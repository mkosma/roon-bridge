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
 *     volume: { value, is_muted, outputs: [...] } | null }
 *
 * `volume` is a single representative level for the zone (the first
 * numeric-volume output's value), plus per-output detail for grouped zones like
 * "WiiM + 1". It lets a polling daemon notice a manual volume change between
 * ticks without a separate get_volume round trip. null when the zone exposes no
 * numeric volume (e.g. fixed-volume / incremental-only outputs).
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
 * Auth: mounted behind the same bearer middleware as /control (see server.ts).
 * The shape mirrors /control/status but is intentionally minimal and stable.
 */

import { Router } from "express";
import { roonConnection } from "../roon-connection.js";
import type { Zone } from "node-roon-api-transport";

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

  return router;
}
