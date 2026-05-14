/**
 * Tests for VolumeRamper.
 *
 * Uses a mock transport that records calls. No real Roon API calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VolumeRamper } from "../src/control/volume-ramper.js";
import type { Zone, Output } from "node-roon-api-transport";
import type RoonApiTransport from "node-roon-api-transport";

// ---------------------------------------------------------------------------
// Helpers to create mock zones / outputs
// ---------------------------------------------------------------------------

function makeOutput(name: string, volume: number, muted = false): Output {
  return {
    output_id: `out-${name}`,
    zone_id: "zone-1",
    display_name: name,
    state: "playing",
    volume: {
      type: "number",
      value: volume,
      min: 0,
      max: 100,
      is_muted: muted,
    },
  };
}

function makeZone(outputs: Output[]): Zone {
  return {
    zone_id: "zone-1",
    display_name: "Test Zone",
    state: "playing",
    outputs,
    queue_items_remaining: 0,
    queue_time_remaining: 0,
    settings: { shuffle: false, auto_radio: false, loop: "disabled" },
  };
}

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

interface VolCall {
  output: Output;
  how: string;
  value: number;
}
interface MuteCall {
  output: Output;
  how: "mute" | "unmute";
}

function makeMockTransport(error: false | string = false) {
  const volumeCalls: VolCall[] = [];
  const muteCalls: MuteCall[] = [];

  const transport = {
    change_volume(
      output: Output,
      how: string,
      value: number,
      cb?: (err: false | string) => void,
    ) {
      volumeCalls.push({ output, how, value });
      cb?.(error);
    },
    mute(
      output: Output,
      how: "mute" | "unmute",
      cb?: (err: false | string) => void,
    ) {
      muteCalls.push({ output, how });
      cb?.(error);
    },
    volumeCalls,
    muteCalls,
  };

  return transport as unknown as RoonApiTransport & {
    volumeCalls: VolCall[];
    muteCalls: MuteCall[];
  };
}

// ---------------------------------------------------------------------------
// Tests: rampDelta
// ---------------------------------------------------------------------------

describe("VolumeRamper.rampDelta (numeric outputs: pipelined absolute)", () => {
  it("applies correct sequence of absolute steps for positive delta", async () => {
    const ramper = new VolumeRamper(0); // 0ms delay for speed
    const output = makeOutput("WiiM", 50);
    const zone = makeZone([output]);
    const transport = makeMockTransport();

    await ramper.rampDelta(4, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(4);
    expect(transport.volumeCalls.map((c) => c.value)).toEqual([51, 52, 53, 54]);
    transport.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
  });

  it("applies correct sequence of absolute steps for negative delta", async () => {
    const ramper = new VolumeRamper(0);
    const output = makeOutput("WiiM", 50);
    const zone = makeZone([output]);
    const transport = makeMockTransport();

    await ramper.rampDelta(-3, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(3);
    expect(transport.volumeCalls.map((c) => c.value)).toEqual([49, 48, 47]);
    transport.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
  });

  it("applies the same absolute target to all outputs in a grouped zone", async () => {
    const ramper = new VolumeRamper(0);
    const out1 = makeOutput("WiiM", 50);
    const out2 = makeOutput("KEF", 44);
    const zone = makeZone([out1, out2]);
    const transport = makeMockTransport();

    // Max is 50, +2 => step targets 51, 52, each fired to both outputs
    await ramper.rampDelta(2, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(4);
    transport.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
    // Both outputs converge: step 1 targets 51 for both, step 2 targets 52 for both
    const byOutput = (name: string) =>
      transport.volumeCalls.filter((c) => c.output.display_name === name).map((c) => c.value);
    expect(byOutput("WiiM")).toEqual([51, 52]);
    expect(byOutput("KEF")).toEqual([51, 52]);
  });

  it("does nothing for delta = 0", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 50)]);
    const transport = makeMockTransport();

    await ramper.rampDelta(0, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(0);
  });

  it("stops early when cancelled mid-ramp", async () => {
    const ramper = new VolumeRamper(20); // real delay to enable cancellation
    const zone = makeZone([makeOutput("WiiM", 50)]);
    const transport = makeMockTransport();

    // Start a 10-step ramp, cancel after 1 step completes
    const rampPromise = ramper.rampDelta(10, () => zone, transport);

    // Cancel after a short delay
    await new Promise((r) => setTimeout(r, 30));
    ramper.cancel();

    await rampPromise;

    // Should have made fewer than 10 calls
    expect(transport.volumeCalls.length).toBeLessThan(10);
    expect(transport.volumeCalls.length).toBeGreaterThan(0);
  });

  it("second ramp cancels first ramp", async () => {
    const ramper = new VolumeRamper(50); // slow ramp
    const zone = makeZone([makeOutput("WiiM", 50)]);
    const transport = makeMockTransport();

    // Start two ramps rapidly; first should be cancelled
    const p1 = ramper.rampDelta(20, () => zone, transport);
    // Immediately start second ramp (cancels first)
    await new Promise((r) => setTimeout(r, 10));
    const p2 = ramper.rampDelta(3, () => zone, transport);

    await Promise.all([p1, p2]);

    // Total calls should be far fewer than 20+3=23 due to cancellation
    expect(transport.volumeCalls.length).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// Tests: rampAbsolute
// ---------------------------------------------------------------------------

describe("VolumeRamper.rampAbsolute", () => {
  it("ramps up from current max to target", async () => {
    const ramper = new VolumeRamper(0);
    const out1 = makeOutput("WiiM", 60);
    const out2 = makeOutput("KEF", 54);
    const zone = makeZone([out1, out2]);
    const transport = makeMockTransport();

    // Max is 60, target 64 => 4 absolute steps (61..64) per output
    await ramper.rampAbsolute(64, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(8);
    transport.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
    const wiimVals = transport.volumeCalls
      .filter((c) => c.output.display_name === "WiiM")
      .map((c) => c.value);
    expect(wiimVals).toEqual([61, 62, 63, 64]);
  });

  it("ramps down from current max to target", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 70)]);
    const transport = makeMockTransport();

    // Max is 70, target 64 => 6 absolute steps (69..64)
    await ramper.rampAbsolute(64, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(6);
    transport.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
    expect(transport.volumeCalls.map((c) => c.value)).toEqual([69, 68, 67, 66, 65, 64]);
  });

  it("cancels prior ramp before starting new absolute ramp", async () => {
    const ramper = new VolumeRamper(50);
    const zone = makeZone([makeOutput("WiiM", 50)]);
    const transport = makeMockTransport();

    const p1 = ramper.rampDelta(20, () => zone, transport);
    await new Promise((r) => setTimeout(r, 10));

    // rampAbsolute cancels p1
    await ramper.rampAbsolute(56, () => zone, transport);
    await p1;

    // Should not have 20 step-up calls
    expect(transport.volumeCalls.length).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// Tests: instantDelta / instantAbsolute
// ---------------------------------------------------------------------------

describe("VolumeRamper.instantDelta", () => {
  it("makes a single relative call per output", async () => {
    const ramper = new VolumeRamper(0);
    const out1 = makeOutput("A", 50);
    const out2 = makeOutput("B", 44);
    const zone = makeZone([out1, out2]);
    const transport = makeMockTransport();

    await ramper.instantDelta(8, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(2);
    transport.volumeCalls.forEach((c) => {
      expect(c.how).toBe("relative");
      expect(c.value).toBe(8);
    });
  });
});

describe("VolumeRamper.instantAbsolute", () => {
  it("computes delta from max and applies single relative call", async () => {
    const ramper = new VolumeRamper(0);
    const out1 = makeOutput("WiiM", 60);
    const out2 = makeOutput("KEF", 54);
    const zone = makeZone([out1, out2]);
    const transport = makeMockTransport();

    // Max is 60, target 72 => delta +12
    await ramper.instantAbsolute(72, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(2);
    transport.volumeCalls.forEach((c) => {
      expect(c.how).toBe("relative");
      expect(c.value).toBe(12);
    });
  });

  it("does nothing when already at target", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 64)]);
    const transport = makeMockTransport();

    await ramper.instantAbsolute(64, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: toggleMute
// ---------------------------------------------------------------------------

describe("VolumeRamper.toggleMute", () => {
  it("mutes all when none are muted", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("A", 50, false), makeOutput("B", 44, false)]);
    const transport = makeMockTransport();

    await ramper.toggleMute(() => zone, transport);

    expect(transport.muteCalls).toHaveLength(2);
    transport.muteCalls.forEach((c) => expect(c.how).toBe("mute"));
  });

  it("unmutes all when all are muted", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("A", 50, true), makeOutput("B", 44, true)]);
    const transport = makeMockTransport();

    await ramper.toggleMute(() => zone, transport);

    expect(transport.muteCalls).toHaveLength(2);
    transport.muteCalls.forEach((c) => expect(c.how).toBe("unmute"));
  });

  it("mutes all when only some are muted (partial mute)", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("A", 50, true), makeOutput("B", 44, false)]);
    const transport = makeMockTransport();

    await ramper.toggleMute(() => zone, transport);

    expect(transport.muteCalls).toHaveLength(2);
    transport.muteCalls.forEach((c) => expect(c.how).toBe("mute"));
  });

  it("does nothing when zone is null", async () => {
    const ramper = new VolumeRamper(0);
    const transport = makeMockTransport();

    await ramper.toggleMute(() => null, transport);

    expect(transport.muteCalls).toHaveLength(0);
  });
});
