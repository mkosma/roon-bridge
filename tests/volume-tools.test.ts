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
import { EventEmitter } from "node:events";
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
  // smooth_skip fade-in gate: the current track identity and its seek progress.
  // A skip flips `track` to a new title; `seek` > 0 means the new track is
  // producing audio (what waitForTrackStart gates the fade-in on).
  track: "Track One",
  seek: 5,
  // When true, control() lands the new track already producing audio (the
  // common case). When false, the new track sits at seek 0 until a test drives
  // a zone-seek event, exercising the event-driven gate path.
  advanceOnControl: true,
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
      one_line: { line1: world.track },
      two_line: { line1: world.track, line2: "An Artist" },
      three_line: { line1: world.track, line2: "An Artist", line3: "An Album" },
      length: 200,
      seek_position: world.seek,
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
    if (world.failControl) {
      cb?.("skip_failed");
      return;
    }
    // A successful skip lands a NEW track; advanceOnControl decides whether it
    // already has audio (seek > 0) or waits for a driven zone-seek event.
    world.track = action === "next" ? "Track Two" : "Track Zero";
    world.seek = world.advanceOnControl ? 5 : 0;
    mockRoon.emit("zones-changed");
    if (world.seek > 0) mockRoon.emit("zone-seek", "zone-1");
    cb?.(false);
  },
};

// roonConnection is an EventEmitter in production (zone-seek / zones-changed);
// the smooth_skip fade-in gate attaches to it, so the mock must be one too.
const mockRoon = Object.assign(new EventEmitter(), {
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
});

vi.mock("../src/roon-connection.js", () => ({ roonConnection: mockRoon }));

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
const { registerZoneTools } = await import("../src/tools/zone.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerVolumeTools(server);
  registerZoneTools(server);
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
  world.track = "Track One";
  world.seek = 5;
  world.advanceOnControl = true;
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
    expect(text).toContain("(linear)");

    await waitFor(() => world.volumeCalls.length === 4);
    expect(world.volumeCalls[world.volumeCalls.length - 1].value).toBe(0);
  });

  it("shapes a long ramp with curve='ease' and lands exactly on the target", async () => {
    // The sunrise-wake shape: 30 -> 52 over a long duration, eased. Short
    // duration here so the test flushes fast; the contract is every integer
    // step in order, ending on 52.
    reset([makeOutput("WiiM", 30)]);
    const server = buildServer();
    const { isError, text } = await call(server, "ramp_volume", {
      value: 52,
      how: "absolute",
      duration_ms: 60,
      curve: "ease",
    });
    expect(isError).toBe(false);
    expect(text).toContain("from 30 to 52");
    expect(text).toContain("(ease)");

    await waitFor(() => currentLevel() === 52);
    const vals = world.volumeCalls.map((c) => c.value);
    expect(vals).toHaveLength(22);
    expect(vals[0]).toBe(31);
    expect(vals[vals.length - 1]).toBe(52);
    world.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
  });

  it("accepts curve='perceptual' and reaches the target", async () => {
    reset([makeOutput("WiiM", 30)]);
    const server = buildServer();
    const { isError, text } = await call(server, "ramp_volume", {
      value: 52,
      how: "absolute",
      duration_ms: 60,
      curve: "perceptual",
    });
    expect(isError).toBe(false);
    expect(text).toContain("(perceptual)");

    await waitFor(() => currentLevel() === 52);
    expect(world.volumeCalls[world.volumeCalls.length - 1].value).toBe(52);
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

  it("ducks to the floor (not silence), skips next, and rides the fade-in back to the original", async () => {
    reset([makeOutput("WiiM", 48)]);
    const server = buildServer();
    // fade_ms is the back-compat convenience knob: sets both legs.
    const { isError, text } = await call(server, "smooth_skip", { direction: "next", fade_ms: 4 });

    expect(isError).toBe(false);
    // floor = round(48 * 0.12) = 6: ducks to a low bed, never to full silence.
    expect(text).toContain("ducked to 6");
    expect(text).toContain("back to 48");
    expect(world.controlCalls).toEqual([{ action: "next" }]);
    expect(Math.min(...world.volumeCalls.map((c) => c.value))).toBe(6);
    expect(world.volumeCalls.some((c) => c.value === 0)).toBe(false);
    expect(currentLevel()).toBe(48);
  });

  it("fade-out tail eases (more steps lower down) rather than stepping linearly", async () => {
    reset([makeOutput("WiiM", 48)]);
    const server = buildServer();
    await call(server, "smooth_skip", { direction: "next", fade_out_ms: 4, fade_in_ms: 4 });

    // The fade-out leg is the descending run from 48 down to the floor of 6.
    const values = world.volumeCalls.map((c) => c.value);
    const floorIdx = values.indexOf(6);
    const fadeOut = values.slice(0, floorIdx + 1);
    // Strictly monotonic 1-unit descent, ending exactly at the floor.
    expect(fadeOut[0]).toBe(47);
    expect(fadeOut[fadeOut.length - 1]).toBe(6);
    for (let i = 1; i < fadeOut.length; i++) {
      expect(fadeOut[i - 1] - fadeOut[i]).toBe(1);
    }
  });

  it("skips to the previous track when asked", async () => {
    reset([makeOutput("WiiM", 48)]);
    const server = buildServer();
    await call(server, "smooth_skip", { direction: "previous", fade_ms: 4 });
    expect(world.controlCalls).toEqual([{ action: "previous" }]);
    expect(currentLevel()).toBe(48);
  });

  it("restores the original level even when the skip fails (no stuck-low)", async () => {
    reset([makeOutput("WiiM", 48)], { failControl: true });
    const server = buildServer();
    const { isError } = await call(server, "smooth_skip", { direction: "next", fade_ms: 4 });

    expect(isError).toBe(true);
    // The skip threw, but the finally fade-in still brought the zone back up.
    expect(currentLevel()).toBe(48);
  });

  it("fades both outputs of a grouped zone back to the original level", async () => {
    reset([makeOutput("WiiM", 48), makeOutput("KEF", 40)]);
    const server = buildServer();
    await call(server, "smooth_skip", { direction: "next", fade_ms: 4 });
    expect(world.outputs.find((o) => o.output_id === "out-WiiM")!.volume!.value).toBe(48);
    expect(world.outputs.find((o) => o.output_id === "out-KEF")!.volume!.value).toBe(48);
  });

  it("gates the fade-in on the new track producing audio (event-driven)", async () => {
    // advanceOnControl=false: the skip lands the new track at seek 0 (silent),
    // so the fade-in must WAIT for a zone-seek event before running.
    reset([makeOutput("WiiM", 48)], { advanceOnControl: false });
    const server = buildServer();
    const tool = server._registeredTools["smooth_skip"];
    const p = tool.handler({ direction: "next", fade_out_ms: 4, fade_in_ms: 4 }, {});

    // Once the skip has fired, the fade-in is gated: volume sits at the floor.
    await waitFor(() => world.controlCalls.length === 1);
    await waitFor(() => currentLevel() === 6);
    // Give the gate a beat to confirm it does NOT fade in without an audio event.
    await new Promise((r) => setTimeout(r, 20));
    expect(currentLevel()).toBe(6);

    // New track starts producing audio -> the gate releases the fade-in.
    world.seek = 5;
    mockRoon.emit("zone-seek", "zone-1");
    await p;
    expect(currentLevel()).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// Objective 3: HTTP -> MCP parity tools (mute_toggle, volume_preset, zone_state)
// ---------------------------------------------------------------------------

describe("mute_toggle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mutes every output when none are muted", async () => {
    reset([makeOutput("WiiM", 40, false), makeOutput("KEF", 40, false)]);
    const server = buildServer();
    const { isError, text } = await call(server, "mute_toggle", {});
    expect(isError).toBe(false);
    expect(text).toContain("Muted");
    expect(world.muteCalls.map((c) => c.how)).toEqual(["mute", "mute"]);
  });

  it("unmutes every output when all are muted", async () => {
    reset([makeOutput("WiiM", 40, true), makeOutput("KEF", 40, true)]);
    const server = buildServer();
    const { text } = await call(server, "mute_toggle", {});
    expect(text).toContain("Unmuted");
    expect(world.muteCalls.map((c) => c.how)).toEqual(["unmute", "unmute"]);
  });

  it("mutes all when only some are muted (partial -> mute)", async () => {
    reset([makeOutput("WiiM", 40, true), makeOutput("KEF", 40, false)]);
    const server = buildServer();
    const { text } = await call(server, "mute_toggle", {});
    expect(text).toContain("Muted");
    expect(world.muteCalls.map((c) => c.how)).toEqual(["mute", "mute"]);
  });
});

describe("volume_preset", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ramps to the configured preset level (1-based index)", async () => {
    // presets: [32, 40, 48, 56, 64, 72, 80]; index 5 -> 64.
    reset([makeOutput("WiiM", 60)]);
    const server = buildServer();
    const { isError, text } = await call(server, "volume_preset", { index: 5 });
    expect(isError).toBe(false);
    expect(text).toContain("Preset 5 -> volume 64");

    await waitFor(() => currentLevel() === 64);
    world.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
  });

  it("jumps instantly when instant=true", async () => {
    reset([makeOutput("WiiM", 60)]);
    const server = buildServer();
    const { text } = await call(server, "volume_preset", { index: 7, instant: true });
    expect(text).toContain("Preset 7 -> volume 80 (instant)");
    // instantAbsolute issues a single relative call per output.
    expect(world.volumeCalls).toHaveLength(1);
    expect(world.volumeCalls[0].how).toBe("relative");
    expect(world.volumeCalls[0].value).toBe(20);
  });

  it("fails loudly when the index is out of range", async () => {
    reset([makeOutput("WiiM", 60)]);
    const server = buildServer();
    const { isError, text } = await call(server, "volume_preset", { index: 99 });
    expect(isError).toBe(true);
    expect(text).toContain("out of range");
  });
});

describe("zone_state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a compact state + queue-runway snapshot with structured JSON", async () => {
    reset([makeOutput("WiiM", 40)], { queue_items_remaining: 7, queue_time_remaining: 1830 });
    const server = buildServer();
    const { isError, text } = await call(server, "zone_state", {});
    expect(isError).toBe(false);

    const json = JSON.parse(text.split("\n").pop() as string);
    expect(json.zone).toBe("WiiM + 1");
    expect(json.state).toBe("playing");
    expect(json.now_playing).toEqual({ title: "Track One", artist: "An Artist", album: "An Album" });
    expect(json.queue_remaining_count).toBe(7);
    expect(json.queue_time_remaining_seconds).toBe(1830);
  });

  it("fails loudly for an unknown zone", async () => {
    reset([makeOutput("WiiM", 40)]);
    const server = buildServer();
    const { isError } = await call(server, "zone_state", { zone: "Garage" });
    expect(isError).toBe(true);
  });
});
