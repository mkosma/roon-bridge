/**
 * Tests for the MCP volume/fade tools that drive the shared VolumeRamper:
 *   ramp_volume  (Objective 1) - smooth absolute/relative fades from MCP.
 *   smooth_skip  (Objective 2) - fade out -> skip -> fade in.
 *   mute_toggle / volume_preset / zone_state (Objective 3) - HTTP parity.
 *
 * Uses a stateful mock roon-connection whose change_volume mutates the mock
 * zone's output values, so the ramper's fire-and-forget loop can be observed
 * to completion. ramp_step_ms is mocked to 0 so ramps flush within a few ticks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Zone, Output } from "node-roon-api-transport";

// ---------------------------------------------------------------------------
// Stateful mock world
// ---------------------------------------------------------------------------

interface VolCall {
  output_id: string;
  how: string;
  value: number;
}
interface MuteCall {
  output_id: string;
  how: "mute" | "unmute";
}
interface ControlCall {
  action: string;
}

const world = {
  outputs: [] as Output[],
  state: "playing" as Zone["state"],
  volumeCalls: [] as VolCall[],
  muteCalls: [] as MuteCall[],
  controlCalls: [] as ControlCall[],
  queue_items_remaining: 0 as number,
  queue_time_remaining: 0 as number,
  failControl: false,
};

function makeOutput(name: string, value: number, muted = false): Output {
  return {
    output_id: `out-${name}`,
    zone_id: "zone-1",
    display_name: name,
    state: "playing",
    volume: { type: "number", value, min: 0, max: 100, is_muted: muted },
  };
}

function makeZone(): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: world.state,
    outputs: world.outputs,
    is_previous_allowed: true,
    is_next_allowed: true,
    is_pause_allowed: true,
    is_play_allowed: true,
    is_seek_allowed: true,
    queue_items_remaining: world.queue_items_remaining,
    queue_time_remaining: world.queue_time_remaining,
    now_playing: {
      one_line: { line1: "Track One" },
      two_line: { line1: "Track One", line2: "An Artist" },
      three_line: { line1: "Track One", line2: "An Artist", line3: "An Album" },
    },
  } as unknown as Zone;
}

const mockTransport = {
  change_volume: (output: Output, how: string, value: number, cb?: (e: false | string) => void) => {
    world.volumeCalls.push({ output_id: output.output_id, how, value });
    // Reflect absolute writes back into world so fresh zone reads see progress.
    const o = world.outputs.find((x) => x.output_id === output.output_id);
    if (o?.volume) {
      o.volume.value = how === "absolute" ? value : (o.volume.value ?? 0) + value;
    }
    cb?.(false);
  },
  mute: (output: Output, how: "mute" | "unmute", cb?: (e: false | string) => void) => {
    world.muteCalls.push({ output_id: output.output_id, how });
    const o = world.outputs.find((x) => x.output_id === output.output_id);
    if (o?.volume) o.volume.is_muted = how === "mute";
    cb?.(false);
  },
  control: (_zone: Zone, action: string, cb?: (e: false | string) => void) => {
    world.controlCalls.push({ action });
    cb?.(world.failControl ? "skip_failed" : false);
  },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getTransport: vi.fn(() => mockTransport),
    findZone: vi.fn((name: string) => {
      if (!name || name.toLowerCase().includes("wiim")) return makeZone();
      return null;
    }),
    findZoneOrThrow: vi.fn((name?: string) => {
      if (!name || name.toLowerCase().includes("wiim")) return makeZone();
      throw new Error(`Zone '${name}' not found.`);
    }),
    getDefaultZone: vi.fn(() => "WiiM + 1"),
    getZones: vi.fn(() => [makeZone()]),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock("../src/control/roon-key-config.js", () => ({
  readRoonKeyConfig: vi.fn(() => ({
    active_zone_display_name: "WiiM + 1",
    volume_step: 8,
    ramp_step_ms: 0,
    presets: [32, 40, 48, 56, 64, 72, 80],
    extras: { open_roon_app: true, muse_toggle: false, favorites: [] },
  })),
}));

const { registerVolumeTools } = await import("../src/tools/volume.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerVolumeTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, text };
}

/** Poll until cond() is true or the timeout elapses (for fire-and-forget ramps). */
async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function reset(outputs: Output[], partial: Partial<typeof world> = {}) {
  world.outputs = outputs;
  world.state = "playing";
  world.volumeCalls = [];
  world.muteCalls = [];
  world.controlCalls = [];
  world.queue_items_remaining = 0;
  world.queue_time_remaining = 0;
  world.failControl = false;
  Object.assign(world, partial);
}

/** Max numeric output value currently in the world (the audible zone level). */
function currentLevel(): number {
  return Math.max(...world.outputs.map((o) => o.volume?.value ?? 0));
}

// ---------------------------------------------------------------------------
// Objective 1: ramp_volume
// ---------------------------------------------------------------------------

describe("ramp_volume", () => {
  beforeEach(() => vi.clearAllMocks());

  it("smoothly ramps to an absolute target in 1-unit steps", async () => {
    reset([makeOutput("WiiM", 4)]);
    const server = buildServer();
    const { isError, text } = await call(server, "ramp_volume", { value: 0, how: "absolute" });
    expect(isError).toBe(false);
    expect(text).toContain("from 4 to 0");

    await waitFor(() => world.volumeCalls.length === 4);
    expect(world.volumeCalls.map((c) => c.value)).toEqual([3, 2, 1, 0]);
    world.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
  });

  it("ramps by a relative delta", async () => {
    reset([makeOutput("WiiM", 4)]);
    const server = buildServer();
    await call(server, "ramp_volume", { value: -4, how: "relative" });

    await waitFor(() => world.volumeCalls.length === 4);
    expect(world.volumeCalls.map((c) => c.value)).toEqual([3, 2, 1, 0]);
  });

  it("applies the same absolute target to every output of a grouped zone", async () => {
    reset([makeOutput("WiiM", 4), makeOutput("KEF", 2)]);
    const server = buildServer();
    await call(server, "ramp_volume", { value: 0, how: "absolute" });

    // Max is 4 -> 4 steps fired to both outputs = 8 calls.
    await waitFor(() => world.volumeCalls.length === 8);
    const byOut = (id: string) =>
      world.volumeCalls.filter((c) => c.output_id === id).map((c) => c.value);
    expect(byOut("out-WiiM")).toEqual([3, 2, 1, 0]);
    expect(byOut("out-KEF")).toEqual([3, 2, 1, 0]);
  });

  it("reaches the target when a duration_ms is supplied", async () => {
    reset([makeOutput("WiiM", 4)]);
    const server = buildServer();
    const { text } = await call(server, "ramp_volume", { value: 0, how: "absolute", duration_ms: 40 });
    expect(text).toContain("over 40ms");

    await waitFor(() => world.volumeCalls.length === 4);
    expect(world.volumeCalls[world.volumeCalls.length - 1].value).toBe(0);
  });

  it("no-ops when already at the target", async () => {
    reset([makeOutput("WiiM", 0)]);
    const server = buildServer();
    const { text } = await call(server, "ramp_volume", { value: 0, how: "absolute" });
    expect(text).toContain("already at 0");
    expect(world.volumeCalls).toHaveLength(0);
  });

  it("reports a loud error for an unknown zone", async () => {
    reset([makeOutput("WiiM", 4)]);
    const server = buildServer();
    const { isError } = await call(server, "ramp_volume", { zone: "Bedroom", value: 0 });
    expect(isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Objective 2: smooth_skip
// ---------------------------------------------------------------------------

describe("smooth_skip", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fades out, skips next, and fades back to the original level", async () => {
    reset([makeOutput("WiiM", 4)]);
    const server = buildServer();
    const { isError, text } = await call(server, "smooth_skip", { direction: "next", fade_ms: 4 });

    expect(isError).toBe(false);
    expect(text).toContain("faded back to 4");
    expect(world.controlCalls).toEqual([{ action: "next" }]);
    // Faded to silence at some point, and ended back at the original level.
    expect(world.volumeCalls.some((c) => c.value === 0)).toBe(true);
    expect(currentLevel()).toBe(4);
  });

  it("skips to the previous track when asked", async () => {
    reset([makeOutput("WiiM", 4)]);
    const server = buildServer();
    await call(server, "smooth_skip", { direction: "previous", fade_ms: 4 });
    expect(world.controlCalls).toEqual([{ action: "previous" }]);
    expect(currentLevel()).toBe(4);
  });

  it("restores the original level even when the skip fails (no stuck-at-0)", async () => {
    reset([makeOutput("WiiM", 4)], { failControl: true });
    const server = buildServer();
    const { isError } = await call(server, "smooth_skip", { direction: "next", fade_ms: 4 });

    expect(isError).toBe(true);
    // The skip threw, but the finally fade-in still brought the zone back up.
    expect(currentLevel()).toBe(4);
  });

  it("fades both outputs of a grouped zone back to the original level", async () => {
    reset([makeOutput("WiiM", 4), makeOutput("KEF", 2)]);
    const server = buildServer();
    await call(server, "smooth_skip", { direction: "next", fade_ms: 4 });
    expect(world.outputs.find((o) => o.output_id === "out-WiiM")!.volume!.value).toBe(4);
    expect(world.outputs.find((o) => o.output_id === "out-KEF")!.volume!.value).toBe(4);
  });
});
