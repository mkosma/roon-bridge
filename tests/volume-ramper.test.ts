/**
 * Tests for VolumeRamper.
 *
 * Uses a mock transport that records calls. No real Roon API calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VolumeRamper, cadence } from "../src/control/volume-ramper.js";
import type { RampCurve } from "../src/control/volume-ramper.js";
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
  it("makes a single clamped absolute call per numeric output", async () => {
    const ramper = new VolumeRamper(0);
    const out1 = makeOutput("A", 50);
    const out2 = makeOutput("B", 44);
    const zone = makeZone([out1, out2]);
    const transport = makeMockTransport();

    await ramper.instantDelta(8, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(2);
    const byName = Object.fromEntries(
      transport.volumeCalls.map((c) => [c.output.display_name, c]),
    );
    expect(byName.A.how).toBe("absolute");
    expect(byName.A.value).toBe(58);
    expect(byName.B.how).toBe("absolute");
    expect(byName.B.value).toBe(52);
  });

  it("clamps at the floor instead of pushing an output below min", async () => {
    // Regression: rapid volume-down used to drive the Devialet past its
    // floor, where it auto-mutes and desyncs the grouped zone.
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("Muse", 2)]);
    const transport = makeMockTransport();

    await ramper.instantDelta(-8, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(1);
    expect(transport.volumeCalls[0].how).toBe("absolute");
    expect(transport.volumeCalls[0].value).toBe(0);
  });

  it("makes no call when already clamped at the floor", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("Muse", 0)]);
    const transport = makeMockTransport();

    await ramper.instantDelta(-8, () => zone, transport);

    expect(transport.volumeCalls).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Tests: cadence (pure curve math, deterministic - no timers)
// ---------------------------------------------------------------------------

describe("cadence", () => {
  const curves: RampCurve[] = ["linear", "ease", "perceptual"];

  it("pins the endpoints to 0 and 1 for every curve", () => {
    for (const c of curves) {
      expect(cadence(c, 0, 30, 52)).toBe(0);
      expect(cadence(c, 1, 30, 52)).toBe(1);
    }
  });

  it("is monotonically increasing across the progress range for every curve", () => {
    for (const c of curves) {
      let prev = -1;
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const t = cadence(c, Math.min(p, 1), 30, 52);
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    }
  });

  it("linear maps progress straight through", () => {
    expect(cadence("linear", 0.25, 30, 52)).toBeCloseTo(0.25, 10);
    expect(cadence("linear", 0.5, 30, 52)).toBeCloseTo(0.5, 10);
    expect(cadence("linear", 0.75, 30, 52)).toBeCloseTo(0.75, 10);
  });

  it("ease is symmetric and slow at both ends (spends little time to cover the middle)", () => {
    // S-curve: at the time-midpoint the step-progress is also 0.5 (symmetry),
    // and a small slice of steps near the ends consumes a large slice of time.
    expect(cadence("ease", 0.5, 30, 52)).toBeCloseTo(0.5, 10);
    // First 10% of steps already eats >10% of the time (slow start).
    expect(cadence("ease", 0.1, 30, 52)).toBeGreaterThan(0.1);
    // Last 10% of steps also eats >10% of the time (slow finish): cadence(0.9) < 0.9.
    expect(cadence("ease", 0.9, 30, 52)).toBeLessThan(0.9);
  });

  it("perceptual spends more time in the low range than linear (rising ramp)", () => {
    // Going 30 -> 52: at the halfway step, perceptual is further along in time
    // than linear, because it front-loaded the louder-per-unit low steps.
    expect(cadence("perceptual", 0.5, 30, 52)).toBeGreaterThan(0.5);
  });

  it("perceptual falls back to ease when an endpoint is <= 0 (dB undefined)", () => {
    // 0 -> 52 has no defined dB ratio at the floor; must not NaN, must equal ease.
    for (const p of [0.25, 0.5, 0.75]) {
      expect(cadence("perceptual", p, 0, 52)).toBeCloseTo(cadence("ease", p, 0, 52), 10);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: rampCurve (duration-shaped long fade)
// ---------------------------------------------------------------------------

describe("VolumeRamper.rampCurve", () => {
  it("hits every integer step in order and ends exactly at the target (linear)", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 30)]);
    const transport = makeMockTransport();

    await ramper.rampCurve(34, () => zone, transport, 8, "linear");

    expect(transport.volumeCalls.map((c) => c.value)).toEqual([31, 32, 33, 34]);
    transport.volumeCalls.forEach((c) => expect(c.how).toBe("absolute"));
  });

  it("ends exactly at the target for ease and perceptual curves too", async () => {
    for (const curve of ["ease", "perceptual"] as RampCurve[]) {
      const ramper = new VolumeRamper(0);
      const zone = makeZone([makeOutput("WiiM", 30)]);
      const transport = makeMockTransport();

      await ramper.rampCurve(52, () => zone, transport, 12, curve);

      const vals = transport.volumeCalls.map((c) => c.value);
      // 22 steps, strictly +1 each, last lands on the target.
      expect(vals).toHaveLength(22);
      expect(vals[0]).toBe(31);
      expect(vals[vals.length - 1]).toBe(52);
      for (let i = 1; i < vals.length; i++) expect(vals[i] - vals[i - 1]).toBe(1);
    }
  });

  it("ramps down through every integer to the target", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 52)]);
    const transport = makeMockTransport();

    await ramper.rampCurve(48, () => zone, transport, 8, "ease");

    expect(transport.volumeCalls.map((c) => c.value)).toEqual([51, 50, 49, 48]);
  });

  it("applies the same absolute target to every output of a grouped zone", async () => {
    const ramper = new VolumeRamper(0);
    const out1 = makeOutput("WiiM", 30);
    const out2 = makeOutput("KEF", 24);
    const zone = makeZone([out1, out2]);
    const transport = makeMockTransport();

    // Max is 30, target 33 => steps 31,32,33 fired to both outputs.
    await ramper.rampCurve(33, () => zone, transport, 6, "linear");

    const byOutput = (name: string) =>
      transport.volumeCalls.filter((c) => c.output.display_name === name).map((c) => c.value);
    expect(byOutput("WiiM")).toEqual([31, 32, 33]);
    expect(byOutput("KEF")).toEqual([31, 32, 33]);
  });

  it("does nothing when already at the target", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 52)]);
    const transport = makeMockTransport();

    await ramper.rampCurve(52, () => zone, transport, 1000, "ease");

    expect(transport.volumeCalls).toHaveLength(0);
  });

  it("cancels promptly mid-ramp despite a long total duration", async () => {
    // 22 steps over 60s would otherwise put ~2.7s between steps; cancel must
    // take effect within ~one CANCEL_POLL_MS slice, not wait for the next step.
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 30)]);
    const transport = makeMockTransport();

    const p = ramper.rampCurve(52, () => zone, transport, 60_000, "linear");
    await new Promise((r) => setTimeout(r, 30));
    ramper.cancel();

    const started = Date.now();
    await p;
    // Returned promptly (well under a step interval) and barely stepped.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(transport.volumeCalls.length).toBeLessThan(5);
  });

  it("a superseding ramp cancels a long curve ramp in progress", async () => {
    const ramper = new VolumeRamper(0);
    const zone = makeZone([makeOutput("WiiM", 30)]);
    const transport = makeMockTransport();

    const p1 = ramper.rampCurve(52, () => zone, transport, 60_000, "ease");
    await new Promise((r) => setTimeout(r, 30));
    // A fast superseding ramp bumps the generation and runs to completion.
    const p2 = ramper.rampCurve(33, () => zone, transport, 0, "linear");
    await Promise.all([p1, p2]);

    // The long ramp did not run away; the final intent (33) is what landed.
    expect(transport.volumeCalls[transport.volumeCalls.length - 1].value).toBe(33);
  });

  it("uses an even relative cadence for incremental-only zones", async () => {
    const ramper = new VolumeRamper(0);
    const incremental: Output = {
      output_id: "out-inc",
      zone_id: "zone-1",
      display_name: "Incremental",
      state: "playing",
      volume: { type: "incremental", value: undefined as unknown as number, is_muted: false },
    } as unknown as Output;
    const zone = makeZone([incremental]);
    const transport = makeMockTransport();

    // No numeric level to shape against: startVol defaults to 0, target 3 => 3
    // relative +1 steps.
    await ramper.rampCurve(3, () => zone, transport, 6, "ease");

    expect(transport.volumeCalls).toHaveLength(3);
    transport.volumeCalls.forEach((c) => {
      expect(c.how).toBe("relative");
      expect(c.value).toBe(1);
    });
  });
});
