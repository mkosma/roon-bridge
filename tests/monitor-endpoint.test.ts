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
  outputs: [],
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
  },
}));

const { createMonitorRouter } = await import("../src/control/monitor-router.js");

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
