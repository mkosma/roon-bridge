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
 * When the watched track is replaced, we distinguish a NATURAL end (the outgoing
 * track had played past NATURAL_END_RATIO of its length) from a MANUAL skip
 * (it had not) - on a natural end we fire; on a skip we re-arm onto the new
 * current track so a skip never causes a mid-track stomp. Pause/seek never
 * change track identity, so they never fire it.
 */

import type { Zone, NowPlaying } from "node-roon-api-transport";

/** Fraction of a track that must have elapsed to count its end as "natural". */
const NATURAL_END_RATIO = 0.85;

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
  generation: number;
  zoneId: string;
  trackKey: string;
  length: number;
  lastSeek: number;
  action: () => Promise<unknown>;
}

export class DeferredPlayer {
  private generation = 0;
  private pending: Pending | null = null;
  private readonly onChange = (): void => this.handleChange();
  private readonly onSeek = (...args: unknown[]): void => this.handleSeek(String(args[0]));

  constructor(private readonly source: ZoneSource) {}

  /** Cancel any armed deferral. A new command (incl. an immediate play) supersedes. */
  cancel(): void {
    this.generation++;
    this.detach();
    this.pending = null;
  }

  /** True while a deferral is armed (exposed for status/tests). */
  isArmed(): boolean {
    return this.pending !== null;
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
   * Arm `action` to run at the end of the zone's current track. If nothing is
   * playing there is no seam to wait for, so the action runs immediately.
   * Returns "fired" if it ran now, "scheduled" if armed.
   */
  async scheduleAfterCurrent(zone: Zone, action: () => Promise<unknown>): Promise<"fired" | "scheduled"> {
    this.generation++;
    const captured = this.generation;
    // Supersede any prior arming before deciding.
    this.detach();
    this.pending = null;

    const np = zone.now_playing;
    if (zone.state !== "playing" || !np || np.length == null) {
      await action();
      return "fired";
    }

    this.pending = {
      generation: captured,
      zoneId: zone.zone_id,
      trackKey: trackKeyOf(np),
      length: np.length,
      lastSeek: np.seek_position ?? 0,
      action,
    };
    this.attach();
    return "scheduled";
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

    // Track changed. Natural end -> fire; manual skip -> re-arm onto the new track.
    const ratio = p.length > 0 ? p.lastSeek / p.length : 1;
    if (ratio >= NATURAL_END_RATIO) {
      this.fire(p);
    } else {
      p.trackKey = currentKey;
      p.length = np.length ?? 0;
      p.lastSeek = np.seek_position ?? 0;
    }
  }

  private fire(p: Pending): void {
    this.detach();
    if (this.generation !== p.generation) return; // superseded
    this.pending = null;
    Promise.resolve()
      .then(() => p.action())
      .catch((e: unknown) => console.error("[DeferredPlayer] deferred action failed:", e));
  }
}
