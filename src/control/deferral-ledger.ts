/**
 * DeferralLedger: the fleet-wide record of every deferred ("at the next track
 * seam") action - armed, superseded, and how it terminated.
 *
 * Why this exists: before it, a scheduled seam action fired fire-and-forget. If
 * the seam re-resolve failed, the action silently evaporated (a queue-replace
 * "when Barbara Allen ends" that never fired, after the caller had already told
 * Monty "Done" on the strength of the schedule-time ok:true). There was no
 * record that the action was armed, no outcome, no way to ask "did it fire?".
 *
 * The ledger closes that gap. Every arming is recorded with an id, its trigger
 * condition, and a terminal outcome:
 *
 *   armed            - waiting for the seam (not terminal)
 *   fired_verified   - fired and a post-action state read confirmed it landed
 *   fired_unverified - fired but the landing could not be confirmed (loud)
 *   failed           - the seam action threw or reported it did not complete
 *   aborted          - a clean, intended stand-down (interference, canceled)
 *   superseded       - a newer deferral (or an immediate play) replaced it
 *   expired          - dropped without firing (e.g. process shutdown)
 *
 * The ledger is a single shared singleton so `deferred_status`, the
 * /monitor/state surface, and the supersede-per-zone rule all see the same
 * truth regardless of which tool armed the deferral. It is deliberately small
 * and dependency-free: an in-memory ring (capped) plus a warn-level bridge-log
 * line on every non-clean terminal state.
 */

export type DeferralStatus =
  | "armed"
  | "fired_verified"
  | "fired_unverified"
  | "failed"
  | "aborted"
  | "superseded"
  | "expired";

/** A terminal status carries no more transitions. */
const TERMINAL: ReadonlySet<DeferralStatus> = new Set([
  "fired_verified",
  "fired_unverified",
  "failed",
  "aborted",
  "superseded",
  "expired",
]);

export interface DeferralMeta {
  zoneId: string;
  zoneName: string;
  /** Human description of the seam condition, e.g. `end of "Barbara Allen"`. */
  trigger: string;
  /** What the seam action will do, e.g. `replace queue with 13 track(s)`. */
  description: string;
}

export interface DeferralRecord extends DeferralMeta {
  deferral_id: string;
  status: DeferralStatus;
  /** Set for failed / aborted / superseded / fired_unverified. */
  reason?: string;
  armed_at: string;
  fired_at?: string;
  settled_at?: string;
  /** The post-action state snapshot that backs (or refutes) the outcome. */
  resulting_state?: unknown;
}

/** Max entries retained in memory (oldest evicted first). */
const MAX_ENTRIES = 100;

export class DeferralLedger {
  private readonly entries: DeferralRecord[] = [];
  private seq = 0;

  /** The bridge-log sink. Overridable for tests. Defaults to console.error. */
  log: (line: string) => void = (line) => console.error(line);

  private nextId(): string {
    this.seq += 1;
    // Monotonic + time-stamped so ids sort chronologically and never collide.
    return `d-${Date.now()}-${this.seq}`;
  }

  /** Record a new arming and return its id. Does not touch prior entries. */
  arm(meta: DeferralMeta): string {
    const deferral_id = this.nextId();
    const rec: DeferralRecord = {
      deferral_id,
      zoneId: meta.zoneId,
      zoneName: meta.zoneName,
      trigger: meta.trigger,
      description: meta.description,
      status: "armed",
      armed_at: new Date().toISOString(),
    };
    this.entries.push(rec);
    while (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.log(`[deferral] armed ${deferral_id} zone="${meta.zoneName}" trigger="${meta.trigger}" action="${meta.description}"`);
    return deferral_id;
  }

  /** Mark that the seam fired and the action is now running (not yet terminal). */
  markFired(deferral_id: string): void {
    const rec = this.get(deferral_id);
    if (!rec || TERMINAL.has(rec.status)) return;
    rec.fired_at = new Date().toISOString();
  }

  /**
   * Record a terminal outcome. No-op if the entry is unknown or already
   * terminal (a supersede that raced a fire must not clobber the real outcome).
   * Emits a warn-level bridge-log line for every non-clean terminal state so a
   * seam action that failed or aborted is loud, never silent.
   */
  settle(deferral_id: string, status: DeferralStatus, reason?: string, resulting_state?: unknown): void {
    const rec = this.get(deferral_id);
    if (!rec || TERMINAL.has(rec.status)) return;
    rec.status = status;
    rec.settled_at = new Date().toISOString();
    if (reason !== undefined) rec.reason = reason;
    if (resulting_state !== undefined) rec.resulting_state = resulting_state;

    if (status === "fired_verified") {
      this.log(`[deferral] ${deferral_id} fired_verified action="${rec.description}"`);
    } else {
      // Everything else is worth a warn: a caller may have claimed success on
      // the arm; the outcome must reach the log and /monitor/state.
      this.log(
        `[deferral] WARN ${deferral_id} ${status}${reason ? `(${reason})` : ""} zone="${rec.zoneName}" action="${rec.description}"`,
      );
    }
  }

  get(deferral_id: string): DeferralRecord | undefined {
    return this.entries.find((e) => e.deferral_id === deferral_id);
  }

  /** The currently-armed (non-terminal) deferrals, oldest first. */
  pending(): DeferralRecord[] {
    return this.entries.filter((e) => !TERMINAL.has(e.status));
  }

  /** Most-recent-first list of every retained deferral (pending + settled). */
  recent(limit = MAX_ENTRIES, zoneId?: string): DeferralRecord[] {
    const src = zoneId ? this.entries.filter((e) => e.zoneId === zoneId) : this.entries;
    return src.slice(-limit).reverse();
  }

  /** Test/lifecycle helper: clear all state. */
  reset(): void {
    this.entries.length = 0;
    this.seq = 0;
  }
}

/** The single shared ledger every DeferredPlayer and every tool reads/writes. */
export const deferralLedger = new DeferralLedger();
