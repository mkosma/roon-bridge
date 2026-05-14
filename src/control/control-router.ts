/**
 * Control router: HTTP endpoints for roon-key on mbp.
 *
 * All endpoints under /control/... and /config/roon-key.
 * Returns JSON {ok: true, ...} on success or {ok: false, error: "..."} on failure.
 *
 * Volume ramping is server-side; roon-key sends ONE request per keypress.
 * The VolumeRamper maintains a generation counter so a new ramp cancels any
 * in-progress ramp atomically.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { exec } from "node:child_process";
import { roonConnection } from "../roon-connection.js";
import { VolumeRamper } from "./volume-ramper.js";
import {
  readRoonKeyConfig,
  writeRoonKeyConfig,
  validateRoonKeyConfig,
} from "./roon-key-config.js";

const ramper = new VolumeRamper();

// ---------------------------------------------------------------------------
// Helper: get active zone by name from roon-key config, or default zone.
// ---------------------------------------------------------------------------

function getActiveZone() {
  try {
    const cfg = readRoonKeyConfig();
    const zoneName = cfg.active_zone_display_name || "";
    return roonConnection.findZone(zoneName) ?? roonConnection.findZone("");
  } catch {
    return null;
  }
}

function getActiveZoneOrThrow() {
  const zone = getActiveZone();
  if (!zone) throw new Error("no_zone");
  return zone;
}

// ---------------------------------------------------------------------------
// Helper: wrap async route handlers so errors become JSON responses.
// ---------------------------------------------------------------------------

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function asyncRoute(fn: AsyncHandler) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    });
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * createConfigRouter: mounts at /config
 * Handles GET /config/roon-key and POST /config/roon-key
 */
export function createConfigRouter(): Router {
  const router = Router();

  // GET /config/roon-key
  router.get(
    "/roon-key",
    asyncRoute(async (_req, res) => {
      const cfg = readRoonKeyConfig();
      res.json({ ok: true, config: cfg });
    }),
  );

  // POST /config/roon-key
  router.post(
    "/roon-key",
    asyncRoute(async (req, res) => {
      const body = req.body as unknown;
      const validation = validateRoonKeyConfig(body);
      if (!validation.ok) {
        res.status(400).json({ ok: false, error: validation.error });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writeRoonKeyConfig(body as any);
      res.json({ ok: true });
    }),
  );

  return router;
}

/**
 * createControlRouter: mounts at /control
 * Handles all /control/... endpoints for roon-key.
 */
export function createControlRouter(): Router {
  const router = Router();
  const debug = process.env.BRIDGE_DEBUG === "1";
  router.use((req, _res, next) => {
    if (debug) {
      console.error(`[control] ${req.method} ${req.path} body=${JSON.stringify(req.body)}`);
    }
    try {
      const cfg = readRoonKeyConfig();
      ramper.setRampStepMs(cfg.ramp_step_ms);
    } catch {
      // ignore config read errors
    }
    next();
  });

  // -------------------------------------------------------------------------
  // POST /control/volume_ramp
  // Body: { direction: "up"|"down", step?: number }
  // -------------------------------------------------------------------------
  router.post(
    "/volume_ramp",
    asyncRoute(async (req, res) => {
      const { direction, step } = req.body as {
        direction?: unknown;
        step?: unknown;
      };

      if (direction !== "up" && direction !== "down") {
        res.status(400).json({ ok: false, error: "direction must be 'up' or 'down'" });
        return;
      }

      const cfg = readRoonKeyConfig();
      const stepVal =
        typeof step === "number" && Number.isInteger(step) && step > 0
          ? step
          : cfg.volume_step;

      let zone;
      try {
        zone = getActiveZoneOrThrow();
      } catch {
        res.json({ ok: false, error: "no_zone" });
        return;
      }

      const transport = roonConnection.getTransport();
      const delta = direction === "up" ? stepVal : -stepVal;

      // Fire and forget ramp; respond immediately (one request per keypress)
      ramper.rampDelta(delta, () => roonConnection.findZone(zone.display_name), transport)
        .catch((e: unknown) => console.error("[control] rampDelta error:", e));

      res.json({ ok: true, direction, step: stepVal });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /control/volume_instant
  // Body: { direction: "up"|"down", step?: number }
  // -------------------------------------------------------------------------
  router.post(
    "/volume_instant",
    asyncRoute(async (req, res) => {
      const { direction, step } = req.body as {
        direction?: unknown;
        step?: unknown;
      };

      if (direction !== "up" && direction !== "down") {
        res.status(400).json({ ok: false, error: "direction must be 'up' or 'down'" });
        return;
      }

      const cfg = readRoonKeyConfig();
      const stepVal =
        typeof step === "number" && Number.isInteger(step) && step > 0
          ? step
          : cfg.volume_step;

      let zone;
      try {
        zone = getActiveZoneOrThrow();
      } catch {
        res.json({ ok: false, error: "no_zone" });
        return;
      }

      const transport = roonConnection.getTransport();
      const delta = direction === "up" ? stepVal : -stepVal;

      await ramper.instantDelta(delta, () => roonConnection.findZone(zone.display_name), transport);

      res.json({ ok: true, direction, step: stepVal });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /control/volume_preset
  // Body: { index: number (1-based), instant?: boolean }
  // -------------------------------------------------------------------------
  router.post(
    "/volume_preset",
    asyncRoute(async (req, res) => {
      const { index, instant } = req.body as {
        index?: unknown;
        instant?: unknown;
      };

      if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
        res.status(400).json({ ok: false, error: "index must be a positive integer (1-based)" });
        return;
      }

      const cfg = readRoonKeyConfig();
      if (index > cfg.presets.length) {
        res.status(400).json({
          ok: false,
          error: `index ${index} out of range (${cfg.presets.length} presets configured)`,
        });
        return;
      }

      const target = cfg.presets[index - 1];

      let zone;
      try {
        zone = getActiveZoneOrThrow();
      } catch {
        res.json({ ok: false, error: "no_zone" });
        return;
      }

      const transport = roonConnection.getTransport();
      const useInstant = instant === true;

      if (useInstant) {
        await ramper.instantAbsolute(
          target,
          () => roonConnection.findZone(zone.display_name),
          transport,
        );
      } else {
        ramper
          .rampAbsolute(target, () => roonConnection.findZone(zone.display_name), transport)
          .catch((e: unknown) => console.error("[control] rampAbsolute error:", e));
      }

      res.json({ ok: true, preset_index: index, target, instant: useInstant });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /control/mute_toggle
  // Body: {}
  // -------------------------------------------------------------------------
  router.post(
    "/mute_toggle",
    asyncRoute(async (_req, res) => {
      let zone;
      try {
        zone = getActiveZoneOrThrow();
      } catch {
        res.json({ ok: false, error: "no_zone" });
        return;
      }

      const transport = roonConnection.getTransport();
      await ramper.toggleMute(() => roonConnection.findZone(zone.display_name), transport);
      res.json({ ok: true });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /control/transport
  // Body: { action: "playpause"|"next"|"prev" }
  // -------------------------------------------------------------------------
  router.post(
    "/transport",
    asyncRoute(async (req, res) => {
      const { action } = req.body as { action?: unknown };

      const VALID_ACTIONS: Record<string, "playpause" | "next" | "previous"> = {
        playpause: "playpause",
        next: "next",
        prev: "previous",
        previous: "previous",
      };

      const mapped = typeof action === "string" ? VALID_ACTIONS[action] : undefined;
      if (!mapped) {
        res.status(400).json({
          ok: false,
          error: "action must be 'playpause', 'next', or 'prev'",
        });
        return;
      }

      let zone;
      try {
        zone = getActiveZoneOrThrow();
      } catch {
        res.json({ ok: false, error: "no_zone" });
        return;
      }

      const transport = roonConnection.getTransport();

      await new Promise<void>((resolve, reject) => {
        transport.control(zone, mapped, (err) => {
          if (err) reject(new Error(String(err)));
          else resolve();
        });
      });

      res.json({ ok: true, action: mapped, zone: zone.display_name });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /control/status
  // -------------------------------------------------------------------------
  router.get(
    "/status",
    asyncRoute(async (_req, res) => {
      const roonConnected = roonConnection.isConnected();
      const cfg = readRoonKeyConfig();

      let zoneInfo: {
        display_name: string;
        state: string | null;
        volume: number | null;
        muted: boolean;
        outputs: Array<{ name: string; volume: number | null; muted: boolean }>;
        now_playing_title: string | null;
        now_playing_artist: string | null;
        now_playing_album: string | null;
      } | null = null;

      try {
        const zone = getActiveZoneOrThrow();
        const outputs = zone.outputs.map((o) => ({
          name: o.display_name,
          volume: o.volume?.value ?? null,
          muted: o.volume?.is_muted ?? false,
        }));
        const numericOutputs = zone.outputs.filter(
          (o) => o.volume && (o.volume.type === "number" || o.volume.type === "db"),
        );
        const maxVol =
          numericOutputs.length > 0
            ? Math.max(...numericOutputs.map((o) => o.volume!.value ?? 0))
            : null;
        const volumeOutputs = zone.outputs.filter((o) => o.volume);
        const anyMuted = volumeOutputs.some((o) => o.volume?.is_muted);
        const np = (zone as { now_playing?: { three_line?: { line1?: string; line2?: string; line3?: string } } }).now_playing;

        zoneInfo = {
          display_name: zone.display_name,
          state: (zone as { state?: string }).state ?? null,
          volume: maxVol,
          muted: anyMuted,
          outputs,
          now_playing_title: np?.three_line?.line1 ?? null,
          now_playing_artist: np?.three_line?.line2 ?? null,
          now_playing_album: np?.three_line?.line3 ?? null,
        };
      } catch {
        // zone not available
      }

      res.json({
        ok: true,
        roon_connected: roonConnected,
        zone: zoneInfo,
        config: cfg,
        zones: roonConnection.getZones().map((z) => ({
          display_name: z.display_name,
          zone_id: z.zone_id,
          state: z.state,
        })),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /control/open_roon_app
  // -------------------------------------------------------------------------
  router.post(
    "/open_roon_app",
    asyncRoute(async (_req, res) => {
      exec("open -a Roon", (err) => {
        if (err) {
          console.error("[control] open_roon_app error:", err.message);
        }
      });
      res.json({ ok: true });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /control/muse_toggle  (stub)
  // -------------------------------------------------------------------------
  router.post("/muse_toggle", (_req, res) => {
    res.json({ ok: false, error: "not_implemented" });
  });

  // -------------------------------------------------------------------------
  // POST /control/play_favorite  (stub)
  // -------------------------------------------------------------------------
  router.post("/play_favorite", (_req, res) => {
    res.json({ ok: false, error: "not_implemented" });
  });

  return router;
}
