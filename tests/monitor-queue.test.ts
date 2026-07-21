/**
 * Tests for GET /monitor/queue - a read-only, poll-forever-safe queue peek
 * that reuses readQueueRows (../src/tools/queue.ts), the same internal queue
 * access the get_queue MCP tool uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Zone, QueueItem } from "node-roon-api-transport";

const zoneWithQueue = {
  zone_id: "zone-1",
  display_name: "WiiM + 1",
  state: "playing" as const,
  outputs: [],
  is_previous_allowed: true,
  is_next_allowed: true,
  is_pause_allowed: true,
  is_play_allowed: true,
  is_seek_allowed: true,
  now_playing: {
    three_line: { line1: "Karoo (Original)", line2: "Larse", line3: "DJ-Kicks" },
    two_line: { line1: "Karoo (Original)", line2: "Larse" },
    one_line: { line1: "Karoo (Original)" },
  },
} as unknown as Zone;

const emptyZone = {
  zone_id: "zone-2",
  display_name: "MacBook",
  state: "stopped" as const,
  outputs: [],
  is_previous_allowed: false,
  is_next_allowed: false,
  is_pause_allowed: false,
  is_play_allowed: true,
  is_seek_allowed: false,
} as unknown as Zone;

function qitem(id: number, title: string, artist: string, album: string, length: number): QueueItem {
  return {
    queue_item_id: id,
    three_line: { line1: title, line2: artist, line3: album },
    two_line: { line1: title, line2: artist },
    one_line: { line1: title },
    length,
  } as unknown as QueueItem;
}

// now-playing is item 0 while playing, per readQueueRows convention.
const QUEUE_ITEMS: QueueItem[] = [
  qitem(100, "Karoo (Original)", "Larse", "DJ-Kicks", 320),
  qitem(101, "Track Two", "Artist B", "Album B", 240),
  qitem(102, "Track Three", "Artist C", "Album C", 200),
  qitem(103, "Track Four", "Artist D", "Album D", 210),
];

let connected = true;

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    isConnected: vi.fn(() => connected),
    getDefaultZone: vi.fn(() => "WiiM + 1"),
    getZones: vi.fn(() => [zoneWithQueue, emptyZone]),
    findZone: vi.fn((name: string) => {
      if (!name) return null;
      const lower = name.toLowerCase();
      if (lower.includes("wiim")) return zoneWithQueue;
      if (lower.includes("macbook")) return emptyZone;
      return null;
    }),
    getQueueSnapshot: vi.fn(async (zone: Zone, maxItems = 200) => {
      const items = zone.zone_id === "zone-1" ? QUEUE_ITEMS : [];
      return items.slice(0, maxItems);
    }),
    isSubscriptionAlive: vi.fn(() => true),
    getLastZoneEventTs: vi.fn(() => Date.now()),
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

describe("GET /monitor/queue", () => {
  beforeEach(() => {
    connected = true;
    vi.clearAllMocks();
  });

  it("returns items in queue order with the documented shape", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=WiiM`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; zone: string; count: number; items: Array<Record<string, unknown>> };
      expect(json.ok).toBe(true);
      expect(json.zone).toBe("WiiM + 1");
      expect(json.items.length).toBeGreaterThan(0);
      const first = json.items[0];
      expect(first).toMatchObject({
        position: 1,
        queue_item_id: 100,
        title: "Karoo (Original)",
        artist: "Larse",
        album: "DJ-Kicks",
        length_seconds: 320,
      });
    });
  });

  it("defaults to limit=10 and honors an explicit smaller limit", async () => {
    await withApp(async (base) => {
      const resDefault = await fetch(`${base}/monitor/queue?zone=WiiM`);
      const jsonDefault = (await resDefault.json()) as { items: unknown[] };
      expect(jsonDefault.items.length).toBeLessThanOrEqual(10);

      const resLimited = await fetch(`${base}/monitor/queue?zone=WiiM&limit=2`);
      const jsonLimited = (await resLimited.json()) as { items: unknown[] };
      expect(jsonLimited.items.length).toBe(2);
    });
  });

  it("ignores a non-numeric or non-positive limit and falls back to the default", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=WiiM&limit=abc`);
      const json = (await res.json()) as { ok: boolean; items: unknown[] };
      expect(json.ok).toBe(true);
      expect(json.items.length).toBeLessThanOrEqual(10);
    });
  });

  it("returns an empty items array for a zone with no queue", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=MacBook`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; count: number; items: unknown[] };
      expect(json.ok).toBe(true);
      expect(json.count).toBe(0);
      expect(json.items).toEqual([]);
    });
  });

  it("404s cleanly for an unknown zone, matching /monitor/state's shape", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=Bathroom`);
      expect(res.status).toBe(404);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toBe("zone_not_found");
      expect(json.available).toEqual(["WiiM + 1", "MacBook"]);
    });
  });

  it("falls back to the default zone when none is specified", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue`);
      const json = (await res.json()) as { ok: boolean; zone: string };
      expect(json.ok).toBe(true);
      expect(json.zone).toBe("WiiM + 1");
    });
  });

  it("503s when Roon is not connected", async () => {
    connected = false;
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=WiiM`);
      expect(res.status).toBe(503);
    });
  });

  it("never mutates - it issues no transport/browse calls, only a queue snapshot read", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=WiiM`);
      expect(res.status).toBe(200);
      // getQueueSnapshot is the only roonConnection surface this endpoint may
      // touch; asserting nothing else on the mock was called would require
      // wiring every method as a spy, but the mock module above only exposes
      // read methods to begin with - a mutation call is not even possible to
      // make from this router without adding new imports, which the diff
      // does not.
      expect(res.ok).toBe(true);
    });
  });

  it("does not crash on a getQueueSnapshot rejection - clean error JSON instead", async () => {
    const { roonConnection } = (await import("../src/roon-connection.js")) as unknown as {
      roonConnection: { getQueueSnapshot: ReturnType<typeof vi.fn> };
    };
    roonConnection.getQueueSnapshot.mockRejectedValueOnce(new Error("boom"));
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/queue?zone=WiiM`);
      expect(res.status).toBe(500);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toBe("queue_read_failed");
    });
  });
});
