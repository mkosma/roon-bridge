/**
 * DeferredPlayer: event-driven "do this at the next track seam" scheduler.
 *
 * Objective 5 - the robust replacement for the old setTimeout-based
 * play_after_current. The agent cannot time a queue-replace to a track boundary
 * itself: network + browse latency guarantee it lands mid-next-track and
 * guillotines it. So the timing is done server-side, driven by Roon's own
 * zone/seek events - never a wall-clock timer.
 *
 * Mirrors the VolumeRamper pattern: a generation counter gives instant
 * cancellation when a new command supersedes an armed deferral. Only one
 * deferral is armed at a time.
 *
 * Boundary detection: while armed, we watch the zone's seek progress (the
 * lightweight "zone-seek" tick) and its track-identity changes ("zones-changed").
 * The action fires when the watched track is left - whether it ended naturally
 * or the user skipped it. (The old code re-armed onto the new track on an early
 * skip, so "skip the current track" silently swallowed the armed replace - the
 * 2026-07-05 surprise. A deferral means "do this once we leave THIS track"; a
 * skip leaves it just as an end does, so both fire.) Pause/seek never change
 * track identity, so they never fire it.
 *
 * Accountability: every arming is recorded in the shared DeferralLedger with an
 * id, its trigger, and a terminal outcome. The seam action returns a structured
 * SeamOutcome (did it run? did a post-action read verify it landed?) which the
 * player classifies into the ledger's terminal states. A seam action that fails
 * or aborts is loud - a warn-level ledger entry - never a silent console.error.
 */

import type { Zone, NowPlaying } from "node-roon-api-transport";
import { deferralLedger, type DeferralMeta } from "./deferral-ledger.js";

/**
 * What a seam action reports back so the player can record a truthful outcome.
 * Every deferred action MUST verify its own landing (reuse the same queue-
 * snapshot / now_playing read the direct path uses) and return the result here.
 */
export interface SeamOutcome {
  /** Did the action complete the work it was armed to do? */
  ok: boolean;
  /** Did a post-action state read confirm the change actually landed? */
  verified: boolean;
  /** A clean, intended stand-down (interference, playback changed) - not a failure. */
  aborted?: boolean;
  /** Machine-readable reason for !ok / aborted / !verified (e.g. "resolve", "interference"). */
  reason?: string;
  /** Human detail for the ledger and logs. */
  detail?: string;
  /** The post-action state snapshot that backs the outcome. */
  resulting_state?: unknown;
}

export type SeamAction = () => Promise<SeamOutcome>;

/** The reason a supersede/cancel happened; drives the ledger terminal state. */
export type CancelReason = "superseded" | "canceled";

/** The slice of roonConnection the player needs; lets tests inject a fake. */
export interface ZoneSource {
  findZone(nameOrId: string): Zone | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

function trackKeyOf(np: NowPlaying): string {
  return `${np.three_line?.line1 ?? ""}|${np.three_line?.line2 ?? ""}|${np.length ?? ""}`;
}

interface Pending {
  id: string;
  generation: number;
  zoneId: string;
  trackKey: string;
  length: number;
  lastSeek: number;
  action: SeamAction;
}

export interface ScheduleResult {
  deferral_id: string;
  status: "fired" | "scheduled";
}

export class DeferredPlayer {
  private generation = 0;
  private pending: Pending | null = null;
  private readonly onChange = (): void => this.handleChange();
  private readonly onSeek = (...args: unknown[]): void => this.handleSeek(String(args[0]));

  constructor(private readonly source: ZoneSource) {}

  /**
   * Cancel any armed deferral. A new command (incl. an immediate play)
   * supersedes; an explicit user cancel is an abort. Records the terminal
   * state in the ledger.
   */
  cancel(reason: CancelReason = "superseded"): void {
    this.generation++;
    this.detach();
    if (this.pending) {
      deferralLedger.settle(this.pending.id, reason === "canceled" ? "aborted" : "superseded", reason);
    }
    this.pending = null;
  }

  /**
   * Cancel a specific armed deferral by id (the cancel_deferred tool). Returns
   * true if that id was the armed deferral and is now canceled.
   */
  cancelById(deferral_id: string, reason: CancelReason = "canceled"): boolean {
    if (this.pending?.id !== deferral_id) return false;
    this.cancel(reason);
    return true;
  }

  /** True while a deferral is armed (exposed for status/tests). */
  isArmed(): boolean {
    return this.pending !== null;
  }

  /** The armed deferral's id, or null. */
  armedId(): string | null {
    return this.pending?.id ?? null;
  }

  private attach(): void {
    this.source.on("zones-changed", this.onChange);
    this.source.on("zone-seek", this.onSeek);
  }

  private detach(): void {
    this.source.off("zones-changed", this.onChange);
    this.source.off("zone-seek", this.onSeek);
  }

  /**
   * Arm `action` to run at the end of the zone's current track, recording it in
   * the ledger under `meta`. If nothing is playing there is no seam to wait for,
   * so the action runs immediately. Returns the deferral id plus whether it
   * fired now ("fired") or is armed ("scheduled").
   *
   * Arming supersedes any prior armed deferral (single-armed by design): the old
   * one is recorded `superseded` before the new one arms.
   */
  async scheduleAfterCurrent(zone: Zone, action: SeamAction, meta: DeferralMeta): Promise<ScheduleResult> {
    this.generation++;
    const captured = this.generation;
    // Supersede any prior arming before deciding.
    this.detach();
    if (this.pending) {
      deferralLedger.settle(this.pending.id, "superseded", "a newer deferral was armed");
    }
    this.pending = null;

    const deferral_id = deferralLedger.arm(meta);

    const np = zone.now_playing;
    if (zone.state !== "playing" || !np || np.length == null) {
      await this.runAction(deferral_id, action);
      return { deferral_id, status: "fired" };
    }

    this.pending = {
      id: deferral_id,
      generation: captured,
      zoneId: zone.zone_id,
      trackKey: trackKeyOf(np),
      length: np.length,
      lastSeek: np.seek_position ?? 0,
      action,
    };
    this.attach();
    return { deferral_id, status: "scheduled" };
  }

  /**
   * Run a seam action and record its outcome. Any throw becomes failed(<msg>);
   * a returned SeamOutcome is classified into the ledger's terminal states.
   */
  private async runAction(deferral_id: string, action: SeamAction): Promise<void> {
    deferralLedger.markFired(deferral_id);
    let outcome: SeamOutcome;
    try {
      outcome = await action();
    } catch (e) {
      deferralLedger.settle(deferral_id, "failed", e instanceof Error ? e.message : String(e));
      return;
    }
    if (outcome.aborted) {
      deferralLedger.settle(deferral_id, "aborted", outcome.reason ?? "aborted", outcome.resulting_state);
    } else if (!outcome.ok) {
      deferralLedger.settle(
        deferral_id,
        "failed",
        outcome.reason ?? outcome.detail ?? "action did not complete",
        outcome.resulting_state,
      );
    } else if (outcome.verified) {
      deferralLedger.settle(deferral_id, "fired_verified", undefined, outcome.resulting_state);
    } else {
      deferralLedger.settle(
        deferral_id,
        "fired_unverified",
        outcome.reason ?? outcome.detail ?? "landing not confirmed",
        outcome.resulting_state,
      );
    }
  }

  private handleSeek(zoneId: string): void {
    const p = this.pending;
    if (!p || p.zoneId !== zoneId) return;
    const np = this.source.findZone(zoneId)?.now_playing;
    if (np && trackKeyOf(np) === p.trackKey) {
      p.lastSeek = np.seek_position ?? p.lastSeek;
      if (np.length != null) p.length = np.length;
    }
  }

  private handleChange(): void {
    const p = this.pending;
    if (!p) return;
    const zone = this.source.findZone(p.zoneId);

    // Zone vanished or playback stopped: the watched track is over -> fire.
    if (!zone || zone.state === "stopped" || !zone.now_playing) {
      this.fire(p);
      return;
    }

    const np = zone.now_playing;
    const currentKey = trackKeyOf(np);
    if (currentKey === p.trackKey) {
      // Same track still playing; the change was volume/settings/queue. Refresh.
      p.lastSeek = np.seek_position ?? p.lastSeek;
      if (np.length != null) p.length = np.length;
      return;
    }

    // Track identity changed = the zone left the armed trigger track. Fire,
    // whether the track ended naturally or the user skipped it. Firing happens
    // AT the new track's boundary (event-driven), never mid-track.
    this.fire(p);
  }

  private fire(p: Pending): void {
    this.detach();
    if (this.generation !== p.generation) return; // superseded
    this.pending = null;
    void this.runAction(p.id, p.action);
  }
}
