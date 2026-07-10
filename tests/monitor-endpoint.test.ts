/**
 * Tests for the cheap monitor state endpoint (Maya spec P1-A).
 * Verifies the script-callable read shape, default-zone fallback, error paths,
 * and that it does NOT depend on subscribe_queue (reads in-memory zone only).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Zone } from "node-roon-api-transport";

const playingZone = {
  zone_id: "zone-1",
  display_name: "WiiM + 1",
  state: "playing" as const,
  outputs: [
    {
      output_id: "out-wiim",
      display_name: "WiiM Ultra",
      volume: { type: "number", value: 48, min: 0, max: 100, is_muted: false },
    },
    {
      output_id: "out-muse",
      display_name: "Muse",
      volume: { type: "number", value: 50, min: 0, max: 100, is_muted: false },
    },
  ],
  is_previous_allowed: true,
  is_next_allowed: true,
  is_pause_allowed: true,
  is_play_allowed: true,
  is_seek_allowed: true,
  queue_items_remaining: 29,
  queue_time_remaining: 3600,
  now_playing: {
    three_line: { line1: "Karoo (Original)", line2: "Larse", line3: "DJ-Kicks" },
    two_line: { line1: "Karoo (Original)", line2: "Larse" },
    one_line: { line1: "Karoo (Original)" },
  },
} as unknown as Zone;

const stoppedZone = {
  zone_id: "zone-2",
  display_name: "MacBook",
  state: "stopped" as const,
  outputs: [],
  is_previous_allowed: false,
  is_next_allowed: false,
  is_pause_allowed: false,
  is_play_allowed: true,
  is_seek_allowed: false,
  queue_items_remaining: 0,
} as unknown as Zone;

let connected = true;
let subscriptionAlive = true;
let lastZoneEventTs: number | null = 1700000000000;

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    isConnected: vi.fn(() => connected),
    getDefaultZone: vi.fn(() => "WiiM + 1"),
    getZones: vi.fn(() => [playingZone, stoppedZone]),
    findZone: vi.fn((name: string) => {
      if (!name) return null;
      const lower = name.toLowerCase();
      if (lower.includes("wiim")) return playingZone;
      if (lower.includes("macbook")) return stoppedZone;
      return null;
    }),
    isSubscriptionAlive: vi.fn(() => subscriptionAlive),
    getLastZoneEventTs: vi.fn(() => lastZoneEventTs),
  },
}));

const { createMonitorRouter } = await import("../src/control/monitor-router.js");
const { deferralLedger } = await import("../src/control/deferral-ledger.js");

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/monitor", createMonitorRouter());
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("GET /monitor/state", () => {
  beforeEach(() => {
    connected = true;
    subscriptionAlive = true;
    lastZoneEventTs = 1700000000000;
    vi.clearAllMocks();
  });

  it("returns the minimal contract for a named zone", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.state).toBe("playing");
      expect(json.queue_remaining_count).toBe(29);
      expect(json.now_playing).toMatchObject({ title: "Karoo (Original)", artist: "Larse" });
    });
  });

  it("surfaces subscription freshness: alive with a recent event by default", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.subscription_alive).toBe(true);
      expect(json.last_zone_event_ts).toBe(1700000000000);
    });
  });

  it("prompts/03 item 4: a killed subscription reports subscription_alive:false and a stale last_zone_event_ts", async () => {
    // Model a stalled WebSocket that never dropped the core reference (still
    // isConnected() true, still 200/ok:true) but stopped delivering zone
    // events - the exact case the old ok:true-whenever-core-is-set contract
    // hid from a polling daemon.
    subscriptionAlive = false;
    const staleTs = Date.now() - 10 * 60 * 1000; // 10 minutes stale
    lastZoneEventTs = staleTs;

    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true); // core is still paired - isConnected() unaffected
      expect(json.subscription_alive).toBe(false);
      expect(json.last_zone_event_ts).toBe(staleTs);
    });
  });

  it("surfaces per-zone deferral outcomes (armed + recent)", async () => {
    deferralLedger.reset();
    const armed = deferralLedger.arm({ zoneId: "zone-1", zoneName: "WiiM + 1", trigger: 'end of "Karoo"', description: "replace queue with 4 track(s)" });
    const failed = deferralLedger.arm({ zoneId: "zone-1", zoneName: "WiiM + 1", trigger: "t", description: "earlier replace" });
    deferralLedger.settle(failed, "failed", "resolve");
    // A deferral for another zone must NOT leak into this zone's view.
    deferralLedger.arm({ zoneId: "zone-2", zoneName: "MacBook", trigger: "t", description: "other zone" });

    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      const json = (await res.json()) as Record<string, unknown>;
      const def = json.deferrals as { armed_count: number; armed: Array<{ deferral_id: string }>; recent: Array<{ deferral_id: string; status: string; reason: string | null }> };
      expect(def.armed_count).toBe(1);
      expect(def.armed[0].deferral_id).toBe(armed);
      expect(def.recent.find((r) => r.deferral_id === failed)).toMatchObject({ status: "failed", reason: "resolve" });
      // The other zone's deferral is absent.
      expect(def.recent.some((r) => r.deferral_id.startsWith("d-") && r.status === "armed" && r.deferral_id !== armed)).toBe(false);
    });
    deferralLedger.reset();
  });

  it("includes a representative volume plus per-output detail", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      const json = (await res.json()) as Record<string, unknown>;
      const vol = json.volume as { value: number; is_muted: boolean; outputs: unknown[] };
      expect(vol).not.toBeNull();
      expect(vol.value).toBe(48); // first numeric-volume output
      expect(vol.is_muted).toBe(false);
      expect(vol.outputs).toHaveLength(2);
    });
  });

  it("reports volume null when the zone has no numeric-volume outputs", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=MacBook`);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.volume).toBeNull();
    });
  });

  it("falls back to the default zone when none specified", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state`);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.zone).toBe("WiiM + 1");
    });
  });

  it("reports stopped state with empty queue", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=MacBook`);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.state).toBe("stopped");
      expect(json.queue_remaining_count).toBe(0);
      expect(json.now_playing).toBeNull();
    });
  });

  it("404s for an unknown zone with the available list", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=Bathroom`);
      expect(res.status).toBe(404);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.available).toEqual(["WiiM + 1", "MacBook"]);
    });
  });

  it("503s when Roon is not connected", async () => {
    connected = false;
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      expect(res.status).toBe(503);
    });
  });

  it("returns all zones in one call", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state/all`);
      const json = (await res.json()) as { ok: boolean; zones: unknown[] };
      expect(json.ok).toBe(true);
      expect(json.zones).toHaveLength(2);
    });
  });

  it("is fast: 50 sequential reads complete well under budget", async () => {
    await withApp(async (base) => {
      const start = Date.now();
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`${base}/monitor/state?zone=WiiM`);
        await res.json();
      }
      const perCall = (Date.now() - start) / 50;
      // Generous CI ceiling; the read itself is in-memory and synchronous.
      expect(perCall).toBeLessThan(50);
    });
  });
});
