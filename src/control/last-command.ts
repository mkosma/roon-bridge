/**
 * last-command: per-zone provenance for the most recent MUTATING bridge
 * operation, so a downstream observer (Maya's music-monitor daemon) can tell
 * a bridge-caused transition from Monty driving Roon by hand.
 *
 * Consumer contract (READ music-monitor.py's `_attribute_source` /
 * `_command_is_recent` FIRST before changing this file - this module exists
 * to satisfy that function exactly):
 *
 *   - No `last_command` key in a zone's /monitor/state(/all) response at all
 *     => the daemon treats the transition as "unknown" (the MUST-safe
 *     default). This is why `snapshot()` in monitor-router.ts OMITS the key
 *     entirely for a zone with no recorded command since boot, rather than
 *     emitting null or {}.
 *   - `last_command` present but "recent" is false (its `at` predates the
 *     daemon's previous poll read) => attributed to "monty" (a real Roon-app
 *     change, not caused by a bridge command the daemon already knows about).
 *   - `last_command` present and recent => attributed to `last_command.source`.
 *
 * "Recent" is decided entirely by the CONSUMER (`_command_is_recent`
 * compares `last_command.at` against the daemon's own previous-read
 * timestamp) - this store's only job is to record `at` accurately as an
 * ISO8601 UTC timestamp (`new Date().toISOString()`, parseable by the
 * daemon's `_parse_iso`) at the moment the command executed. Do not try to
 * decide staleness here.
 *
 * In-memory, per zone_id, bridge-process-lifetime only (matches
 * queue-provenance.ts's precedent: best-effort, reset on restart, a miss is
 * always safe because the consumer treats a missing key as "unknown").
 */

export interface LastCommand {
  /** Provenance only, never authorization - see command-context.ts. */
  source: string;
  /** Tool/action name, e.g. "play", "queue_next", "change_volume". */
  action: string;
  zone_id: string;
  /** ISO8601 UTC, e.g. 2026-07-20T12:34:56.789Z. */
  at: string;
}

class LastCommandStore {
  private readonly map = new Map<string, LastCommand>();

  /** Record that `action` (from `source`) just executed against `zoneId`. */
  record(zoneId: string, action: string, source: string): void {
    if (!zoneId) return; // nothing to key on; drop rather than guess
    this.map.set(zoneId, {
      source,
      action,
      zone_id: zoneId,
      at: new Date().toISOString(),
    });
  }

  /** The last recorded command for a zone, or undefined if none since boot. */
  get(zoneId: string): LastCommand | undefined {
    return this.map.get(zoneId);
  }

  /** Tests / diagnostics. */
  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

/** Process-wide singleton, written by every mutating tool, read by the
 * monitor router. */
export const lastCommandStore = new LastCommandStore();
