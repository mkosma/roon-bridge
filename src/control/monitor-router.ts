/**
 * monitor-router: cheap, script-callable zone state read (Maya spec P1-A).
 *
 * GET /monitor/state?zone=<name|id>
 *
 * Returns a tiny JSON snapshot suitable for a deterministic daemon polling
 * every 30-60s forever:
 *
 *   { ok, zone, state: "playing"|"paused"|"stopped"|"loading",
 *     now_playing: { title, artist, album } | null,
 *     queue_remaining_count, queue_time_remaining_seconds,
 *     volume: { value, is_muted, outputs: [...] } | null,
 *     last_command?: { source, action, zone_id, at } }
 *
 * `volume` is a single representative level for the zone (the first
 * numeric-volume output's value), plus per-output detail for grouped zones like
 * "WiiM + 1". It lets a polling daemon notice a manual volume change between
 * ticks without a separate get_volume round trip. null when the zone exposes no
 * numeric volume (e.g. fixed-volume / incremental-only outputs).
 *
 * `last_command` is command provenance (see last-command.ts / command-context.ts):
 * the most recent MUTATING bridge operation against this zone since boot,
 * tagged with who issued it (the X-Command-Source header, default "maya").
 * OMITTED ENTIRELY (never null, never {}) when no command has been recorded
 * for this zone yet - music-monitor.py's `_attribute_source()` depends on
 * that exact distinction (a missing key means "unknown", not "monty").
 *
 * It reads ONLY the in-memory zone map that roon-bridge already keeps fresh via
 * its single subscribe_zones stream. No browse, no subscribe_queue round trip,
 * no LLM, no MCP session - so it returns in well under the 150ms budget and
 * adds negligible load on the bridge or Roon Core.
 *
 * queue_remaining_count comes straight from Roon's zone.queue_items_remaining,
 * which Roon pushes on every queue change; we never spin up a queue
 * subscription for the monitor path.
 *
 * GET /monitor/queue?zone=<name|id>&limit=<n, default 10>
 *
 * A read-only peek at the upcoming queue (title/artist/album/queue_item_id/
 * length_seconds, in queue order), safe to poll every couple of minutes
 * indefinitely - no mutation, no side effects, reuses the same readQueueRows
 * the get_queue MCP tool uses (src/tools/queue.ts).
 *
 * Auth: mounted behind the same bearer middleware as /control (see server.ts).
 * The shape mirrors /control/status but is intentionally minimal and stable.
 */

import { Router } from "express";
import { roonConnection } from "../roon-connection.js";
import { deferralLedger } from "./deferral-ledger.js";
import { lastCommandStore } from "./last-command.js";
import { readQueueRows } from "../tools/queue.js";
import type { Zone } from "node-roon-api-transport";

// A compact deferral view for the monitor: the daemon (and Maya) can see, per
// zone, what is armed and how recent seam actions turned out - so a failed or
// superseded replace is visible to a polling consumer, not just in the log.
function deferralSnapshot(zoneId: string) {
  const pending = deferralLedger.pending().filter((d) => d.zoneId === zoneId);
  const recent = deferralLedger.recent(5, zoneId);
  return {
    armed_count: pending.length,
    armed: pending.map((d) => ({ deferral_id: d.deferral_id, trigger: d.trigger, description: d.description, armed_at: d.armed_at })),
    recent: recent.map((d) => ({ deferral_id: d.deferral_id, status: d.status, reason: d.reason ?? null, description: d.description, settled_at: d.settled_at ?? null })),
  };
}

// A compact, monitor-friendly volume read for a zone. Reads only the in-memory
// outputs (no transport round trip), mirroring the rest of /monitor/state.
// `value` is the first numeric-volume output's level - a stable scalar a daemon
// can diff between ticks; `outputs` carries per-output detail for grouped zones.
function volumeSnapshot(zone: Zone) {
  const outputs = (zone.outputs ?? [])
    .filter((o) => o.volume && o.volume.type !== "incremental")
    .map((o) => ({
      output_id: o.output_id,
      name: o.display_name,
      value: o.volume?.value ?? null,
      is_muted: o.volume?.is_muted ?? null,
    }));
  if (outputs.length === 0) return null;
  return {
    value: outputs[0].value,
    is_muted: outputs[0].is_muted,
    outputs,
  };
}

function snapshot(zone: Zone) {
  const np = zone.now_playing;
  // Normalize Roon's "loading" to the caller's contract where useful, but keep
  // it distinct so a daemon can tell a buffering zone from a steady one.
  const state = zone.state;
  return {
    ok: true,
    zone: zone.display_name,
    zone_id: zone.zone_id,
    state,
    now_playing: np
      ? {
          title: np.three_line.line1,
          artist: np.three_line.line2 ?? null,
          album: np.three_line.line3 ?? null,
        }
      : null,
    queue_remaining_count: zone.queue_items_remaining ?? 0,
    queue_time_remaining_seconds: zone.queue_time_remaining ?? null,
    volume: volumeSnapshot(zone),
    deferrals: deferralSnapshot(zone.zone_id),
    // Omit the key entirely when nothing has been recorded since boot - see
    // the module doc comment and last-command.ts for why this distinction
    // (missing vs null vs {}) is load-bearing for the daemon consumer.
    ...(lastCommandStore.get(zone.zone_id) ? { last_command: lastCommandStore.get(zone.zone_id) } : {}),
    // Freshness signal (prompts/03, item 3): the zone map above is served
    // ok:true whenever core !== null, which hides a stalled WebSocket that
    // stopped delivering events without dropping the core reference. A
    // polling daemon should treat subscription_alive:false or an old
    // last_zone_event_ts as stale, not trust ok:true alone.
    subscription_alive: roonConnection.isSubscriptionAlive(),
    last_zone_event_ts: roonConnection.getLastZoneEventTs(),
  };
}

export function createMonitorRouter(): Router {
  const router = Router();

  // GET /monitor/state?zone=Name  (zone optional -> default zone)
  router.get("/state", (req, res) => {
    if (!roonConnection.isConnected()) {
      res.status(503).json({ ok: false, error: "roon_not_connected" });
      return;
    }
    const zoneParam = (req.query.zone as string | undefined)?.trim() ?? "";
    // Only fall back to the default zone when no zone was requested. An
    // explicit-but-unknown zone is a 404, not a silent default - a polling
    // daemon must see when its target zone disappears.
    const target = zoneParam || roonConnection.getDefaultZone();
    const zone = target ? roonConnection.findZone(target) : null;
    if (!zone) {
      res.status(404).json({
        ok: false,
        error: "zone_not_found",
        requested: target || null,
        available: roonConnection.getZones().map((z) => z.display_name),
      });
      return;
    }
    res.json(snapshot(zone));
  });

  // GET /monitor/state/all  - snapshot of every zone in one call.
  router.get("/state/all", (_req, res) => {
    if (!roonConnection.isConnected()) {
      res.status(503).json({ ok: false, error: "roon_not_connected" });
      return;
    }
    res.json({ ok: true, zones: roonConnection.getZones().map(snapshot) });
  });

  // GET /monitor/queue?zone=Name&limit=10  - read-only queue peek, safe to
  // poll indefinitely. Reuses readQueueRows (../tools/queue.ts), the same
  // internal queue access the get_queue MCP tool uses - no separate queue
  // logic to drift out of sync.
  router.get("/queue", async (req, res) => {
    if (!roonConnection.isConnected()) {
      res.status(503).json({ ok: false, error: "roon_not_connected" });
      return;
    }
    const zoneParam = (req.query.zone as string | undefined)?.trim() ?? "";
    const target = zoneParam || roonConnection.getDefaultZone();
    const zone = target ? roonConnection.findZone(target) : null;
    if (!zone) {
      res.status(404).json({
        ok: false,
        error: "zone_not_found",
        requested: target || null,
        available: roonConnection.getZones().map((z) => z.display_name),
      });
      return;
    }

    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 10;

    try {
      const rows = await readQueueRows(zone, limit);
      res.json({
        ok: true,
        zone: zone.display_name,
        zone_id: zone.zone_id,
        count: rows.length,
        items: rows.slice(0, limit).map((r) => ({
          position: r.position,
          queue_item_id: r.queue_item_id,
          title: r.title,
          artist: r.artist,
          album: r.album,
          length_seconds: r.length_seconds,
          is_now_playing: r.is_now_playing,
        })),
      });
    } catch (e) {
      // Never let a queue read error crash the poller's expectations - a
      // clean error JSON, matching /monitor/state's zone-not-found shape.
      res.status(500).json({ ok: false, error: "queue_read_failed", detail: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}
