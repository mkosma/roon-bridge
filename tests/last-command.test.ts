/**
 * Tests for last-command.ts's provenance lifecycle:
 *   - the store itself (record/get/clear, per-zone isolation)
 *   - resultingState(zone, action) recording on every mutating call, and
 *     `null` skipping recording for an "armed but not yet executed" read
 *   - a real mutating tool (play) records; a real read-only tool (get_queue)
 *     does not
 *   - the monitor-router contract: last_command is OMITTED (not null, not
 *     {}) for a zone with nothing recorded, and present once one has
 *     landed - the exact distinction music-monitor.py's _attribute_source
 *     depends on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Zone, Output } from "node-roon-api-transport";

function output(id: string, value = 40): Output {
  return {
    output_id: id,
    zone_id: "",
    display_name: id,
    state: "stopped",
    volume: { type: "number", min: 0, max: 100, value, step: 1, is_muted: false, hard_limit_min: 0, hard_limit_max: 100, soft_limit: 100 },
  } as unknown as Output;
}

function zone(id: string, name: string, nowPlaying?: string): Zone {
  return {
    zone_id: id,
    display_name: name,
    outputs: [output(`o-${id}`)],
    state: nowPlaying ? "playing" : "stopped",
    is_previous_allowed: true,
    is_next_allowed: true,
    is_pause_allowed: true,
    is_play_allowed: true,
    is_seek_allowed: true,
    now_playing: nowPlaying
      ? { one_line: { line1: nowPlaying }, two_line: { line1: nowPlaying }, three_line: { line1: nowPlaying } }
      : undefined,
  } as unknown as Zone;
}

const world: { zones: Zone[] } = { zones: [] };

function reset() {
  world.zones = [zone("z-1", "WiiM + 1", "Karoo"), zone("z-2", "MacBook")];
}

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getTransport: vi.fn(() => ({
      control: vi.fn((_zone: Zone, _action: string, cb: (err?: string) => void) => cb()),
    })),
    getZones: vi.fn(() => world.zones),
    findZone: vi.fn((id: string) => {
      if (!id) return null;
      const lower = id.toLowerCase();
      return world.zones.find((z) => z.zone_id === id || z.display_name.toLowerCase().includes(lower)) ?? null;
    }),
    findZoneOrThrow: vi.fn((nameOrId: string) => {
      const z = world.zones.find((x) => x.zone_id === nameOrId || x.display_name.toLowerCase() === nameOrId.toLowerCase());
      if (!z) throw new Error(`Zone '${nameOrId}' not found`);
      return z;
    }),
    getQueueSnapshot: vi.fn(async () => []),
    isConnected: vi.fn(() => true),
    getDefaultZone: vi.fn(() => "WiiM + 1"),
    isSubscriptionAlive: vi.fn(() => true),
    getLastZoneEventTs: vi.fn(() => Date.now()),
  },
}));

const { lastCommandStore } = await import("../src/control/last-command.js");
const { resultingState } = await import("../src/tools/resulting-state.js");
const { registerPlaybackTools } = await import("../src/tools/playback.js");
const { registerZoneTools } = await import("../src/tools/zone.js");
const { createMonitorRouter } = await import("../src/control/monitor-router.js");
const { runWithCommandSource } = await import("../src/control/command-context.js");
const { deferralLedger } = await import("../src/control/deferral-ledger.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerPlaybackTools(server);
  registerZoneTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  return res;
}

beforeEach(() => {
  reset();
  lastCommandStore.clear();
  deferralLedger.reset();
  vi.clearAllMocks();
});

describe("LastCommandStore", () => {
  it("returns undefined for a zone with nothing recorded", () => {
    expect(lastCommandStore.get("z-1")).toBeUndefined();
  });

  it("records source/action/zone_id/at and an ISO8601 timestamp", () => {
    lastCommandStore.record("z-1", "play", "maya");
    const lc = lastCommandStore.get("z-1");
    expect(lc).toMatchObject({ source: "maya", action: "play", zone_id: "z-1" });
    expect(() => new Date(lc!.at).toISOString()).not.toThrow();
    expect(new Date(lc!.at).toISOString()).toBe(lc!.at);
  });

  it("isolates records per zone", () => {
    lastCommandStore.record("z-1", "play", "maya");
    expect(lastCommandStore.get("z-2")).toBeUndefined();
    lastCommandStore.record("z-2", "pause", "telegram");
    expect(lastCommandStore.get("z-1")).toMatchObject({ action: "play" });
    expect(lastCommandStore.get("z-2")).toMatchObject({ action: "pause" });
  });

  it("a later record for the same zone overwrites the earlier one", () => {
    lastCommandStore.record("z-1", "play", "maya");
    lastCommandStore.record("z-1", "pause", "maya");
    expect(lastCommandStore.get("z-1")).toMatchObject({ action: "pause" });
  });

  it("silently drops a record with no zoneId", () => {
    lastCommandStore.record("", "play", "maya");
    expect(lastCommandStore.size()).toBe(0);
  });
});

describe("resultingState(zone, action) provenance recording", () => {
  it("records when action is a string", async () => {
    const z = world.zones[0];
    await runWithCommandSource("telegram", () => resultingState(z, "change_volume"));
    expect(lastCommandStore.get(z.zone_id)).toMatchObject({ action: "change_volume", source: "telegram" });
  });

  it("does NOT record when action is null (armed-but-not-executed read)", async () => {
    const z = world.zones[0];
    await resultingState(z, null);
    expect(lastCommandStore.get(z.zone_id)).toBeUndefined();
  });

  it("uses the default source (maya) outside any bound command context", async () => {
    const z = world.zones[1];
    await resultingState(z, "queue_next");
    expect(lastCommandStore.get(z.zone_id)).toMatchObject({ source: "maya" });
  });
});

describe("mutating vs read-only tools", () => {
  it("a mutating tool (play) records last_command for its zone", async () => {
    const server = buildServer();
    await runWithCommandSource("telegram", () => call(server, "play", { zone: "WiiM + 1" }));
    expect(lastCommandStore.get("z-1")).toMatchObject({ action: "play", source: "telegram" });
  });

  it("a read-only tool (get_queue) does not touch last_command", async () => {
    const server = buildServer();
    await call(server, "get_queue", { zone: "WiiM + 1" });
    expect(lastCommandStore.get("z-1")).toBeUndefined();
  });

  it("a read-only tool (now_playing) does not touch last_command", async () => {
    const server = buildServer();
    await call(server, "now_playing", { zone: "WiiM + 1" });
    expect(lastCommandStore.get("z-1")).toBeUndefined();
  });

  it("per-zone isolation holds across tool calls: acting on zone 1 leaves zone 2 untouched", async () => {
    const server = buildServer();
    await call(server, "play", { zone: "WiiM + 1" });
    expect(lastCommandStore.get("z-1")).toBeDefined();
    expect(lastCommandStore.get("z-2")).toBeUndefined();
  });
});

describe("monitor-router last_command contract", () => {
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

  it("omits last_command entirely for a zone with nothing recorded", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state?zone=WiiM`);
      const json = (await res.json()) as Record<string, unknown>;
      expect("last_command" in json).toBe(false);
    });
  });

  it("includes last_command once a command has been recorded, and it is per-zone", async () => {
    lastCommandStore.record("z-1", "play", "maya");
    await withApp(async (base) => {
      const res1 = await fetch(`${base}/monitor/state?zone=WiiM`);
      const json1 = (await res1.json()) as Record<string, unknown>;
      expect(json1.last_command).toMatchObject({ action: "play", source: "maya", zone_id: "z-1" });

      const res2 = await fetch(`${base}/monitor/state?zone=MacBook`);
      const json2 = (await res2.json()) as Record<string, unknown>;
      expect("last_command" in json2).toBe(false);
    });
  });

  it("state/all reflects the same per-zone presence/absence", async () => {
    lastCommandStore.record("z-2", "mute", "maya");
    await withApp(async (base) => {
      const res = await fetch(`${base}/monitor/state/all`);
      const json = (await res.json()) as { zones: Array<Record<string, unknown>> };
      const z1 = json.zones.find((z) => z.zone_id === "z-1")!;
      const z2 = json.zones.find((z) => z.zone_id === "z-2")!;
      expect("last_command" in z1).toBe(false);
      expect(z2.last_command).toMatchObject({ action: "mute" });
    });
  });
});
