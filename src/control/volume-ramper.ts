/**
 * VolumeRamper: server-side smooth volume ramping for roon-bridge.
 *
 * Accepts a single HTTP request per keypress from roon-key on mbp,
 * then drives a ramp loop against the Roon API from the mini.
 * Generation counter provides instant cancellation when a new ramp
 * supersedes an in-progress one.
 */

import type RoonApiTransport from "node-roon-api-transport";
import type { Zone, Output } from "node-roon-api-transport";

/** Milliseconds between each 1-unit step when ramping. */
const DEFAULT_RAMP_STEP_MS = 20;

/**
 * Longest single uninterrupted sleep inside a shaped ramp. A long ramp can put
 * minutes between integer steps; we sleep in slices no longer than this so the
 * generation-counter cancel stays responsive (a superseding volume command
 * takes effect within ~one slice, not after a multi-minute wait).
 */
const CANCEL_POLL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Easing curve for a duration-shaped ramp. Roon volume is integer units, so we
 * cannot move in sub-unit increments - the only freedom over a fixed total
 * duration is *when* each 1-unit step fires. A curve is the mapping
 *   cadence(p) = fraction of total time elapsed when fraction p of the steps
 *                have fired,  with cadence(0)=0 and cadence(1)=1.
 * Stretching time at one end spaces those steps further apart there, so the
 * volume changes more slowly through that part of the range.
 *
 *  - "linear":     even time per step. Constant unit/sec.
 *  - "ease":       raised-cosine S-curve - slow at both ends, faster in the
 *                  middle. The gentle "wake" feel: it drifts up out of the
 *                  start level and settles into the target without a hard edge.
 *  - "perceptual": dwell on each step proportional to its loudness (dB) jump,
 *                  treating the Roon unit as ~linear-amplitude (so a unit near
 *                  the floor is a far bigger perceptual jump than one up top).
 *                  Spends more time low, less time high, for a constant
 *                  perceived-loudness rate. Requires both endpoints > 0;
 *                  falls back to "ease" when either is <= 0 (log is undefined).
 */
export type RampCurve = "linear" | "ease" | "perceptual";

/**
 * Cumulative elapsed-time fraction at which the step that lands on integer
 * level `levelAfter` (the i-th of `steps`, p = i/steps) should fire.
 * `start`/`target` bound the ramp and let "perceptual" weight by dB.
 */
export function cadence(curve: RampCurve, p: number, start: number, target: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  switch (curve) {
    case "linear":
      return p;
    case "ease":
      // Inverse of the raised-cosine volume curve v(t)=(1-cos(pi*t))/2.
      return Math.acos(1 - 2 * p) / Math.PI;
    case "perceptual": {
      // Time so far proportional to cumulative |dB| from start to this level.
      if (start <= 0 || target <= 0 || start === target) {
        return Math.acos(1 - 2 * p) / Math.PI; // undefined dB ratio -> ease
      }
      const level = start + (target - start) * p;
      if (level <= 0) return Math.acos(1 - 2 * p) / Math.PI;
      return Math.log(level / start) / Math.log(target / start);
    }
  }
}

/**
 * Promisify a Roon callback-style call.
 * Returns the error string, or false if successful.
 */
function promisifyResult(fn: (cb: (error: false | string) => void) => void): Promise<false | string> {
  return new Promise((resolve) => fn((error) => resolve(error)));
}

/**
 * Get the outputs that have volume control from a zone.
 * Filters to outputs that have a volume object present.
 * Incremental-type outputs have no numeric value; skip them for absolute calcs.
 */
function getVolumeOutputs(zone: Zone): Output[] {
  return zone.outputs.filter((o) => o.volume != null);
}

/**
 * Get outputs with a numeric volume value (type "number" or "db").
 * Used for absolute ramp calculations where we need to read a current level.
 */
function getNumericVolumeOutputs(zone: Zone): Output[] {
  return zone.outputs.filter(
    (o) => o.volume != null && (o.volume.type === "number" || o.volume.type === "db"),
  );
}

/**
 * Clamp an absolute target to an output's [min, max] range.
 * Prevents rapid relative steps from driving a device (e.g. the Devialet)
 * past its volume floor, where it auto-mutes and desyncs the group.
 */
function clampToOutput(output: Output, target: number): number {
  const v = output.volume!;
  const lo = typeof v.min === "number" ? v.min : 0;
  const hi = typeof v.max === "number" ? v.max : 100;
  return Math.min(hi, Math.max(lo, target));
}

export interface GetZoneFn {
  (): Zone | null;
}

export class VolumeRamper {
  /** Incremented each time a new ramp starts or cancel() is called. */
  private generation = 0;
  private rampStepMs: number;

  constructor(rampStepMs: number = DEFAULT_RAMP_STEP_MS) {
    this.rampStepMs = rampStepMs;
  }

  /** Cancel any in-progress ramp. */
  cancel(): void {
    this.generation++;
  }

  /**
   * Smooth ramp by a relative delta (positive = up, negative = down).
   * Steps 1 unit at a time at rampStepMs cadence.
   *
   * For zones whose outputs all have numeric volume (type "number" or "db"),
   * the steps are absolute values, fire-and-forget: each step sends
   * `change_volume(output, "absolute", N)` without awaiting the callback,
   * paced by rampStepMs. This pipelines the ramp so cadence matches the
   * configured value instead of being bottlenecked by Roon API round-trip,
   * and makes dropped/coalesced steps self-correcting (the next absolute
   * target supersedes any lost prior step).
   *
   * For zones with incremental-only outputs, falls back to the older
   * serialized-relative path. Cancellable via generation counter.
   */
  async rampDelta(
    delta: number,
    getZone: GetZoneFn,
    transport: RoonApiTransport,
    stepMs?: number,
  ): Promise<void> {
    if (delta === 0) return;
    this.generation++;
    const captured = this.generation;

    const zone = getZone();
    if (!zone) return;

    const allVolume = getVolumeOutputs(zone);
    if (allVolume.length === 0) return;

    const numeric = getNumericVolumeOutputs(zone);
    const steps = Math.abs(delta);
    const direction = delta > 0 ? 1 : -1;
    // Per-call cadence overrides the instance default without mutating shared
    // state, so an MCP fade with a bespoke duration can't be clobbered by a
    // concurrent HTTP keypress (which sets rampStepMs from roon-key config).
    const stepDelay = stepMs ?? this.rampStepMs;

    if (numeric.length === allVolume.length) {
      const startVol = Math.max(...numeric.map((o) => o.volume!.value ?? 0));
      for (let i = 1; i <= steps; i++) {
        if (this.generation !== captured) return;
        const rawTarget = startVol + direction * i;
        for (const output of numeric) {
          const target = clampToOutput(output, rawTarget);
          transport.change_volume(output, "absolute", target, (err) => {
            if (err) console.error("[VolumeRamper] step failed:", err);
          });
        }
        if (i < steps) await delay(stepDelay);
      }
      return;
    }

    // Fallback: incremental-only outputs can't take absolute values.
    // Serialized relative path; slower (RTT-bound) but works everywhere.
    for (let i = 0; i < steps; i++) {
      if (this.generation !== captured) return;
      const currentZone = getZone();
      if (!currentZone) return;
      const outputs = getVolumeOutputs(currentZone);
      if (outputs.length === 0) return;
      await Promise.all(
        outputs.map((output) =>
          promisifyResult((cb) =>
            transport.change_volume(output, "relative", direction, cb),
          ),
        ),
      );
      if (i < steps - 1) await delay(stepDelay);
    }
  }

  /**
   * Smooth ramp to an absolute target volume.
   * Reads current max volume across outputs, computes delta, then ramps.
   */
  async rampAbsolute(
    target: number,
    getZone: GetZoneFn,
    transport: RoonApiTransport,
    stepMs?: number,
  ): Promise<void> {
    // Cancel current ramp generation so rampDelta starts fresh
    this.cancel();

    const zone = getZone();
    if (!zone) return;

    const outputs = getNumericVolumeOutputs(zone);
    if (outputs.length === 0) return;

    const currentMax = Math.max(...outputs.map((o) => o.volume!.value ?? 0));
    const delta = target - currentMax;

    await this.rampDelta(delta, getZone, transport, stepMs);
  }

  /**
   * Sleep `ms`, but in slices no longer than CANCEL_POLL_MS, bailing out the
   * moment the ramp generation moves on. Returns true if the wait completed
   * while still current, false if a superseding ramp/cancel intervened.
   */
  private async waitCancellable(ms: number, captured: number): Promise<boolean> {
    let remaining = ms;
    while (remaining > 0) {
      if (this.generation !== captured) return false;
      const chunk = Math.min(CANCEL_POLL_MS, remaining);
      await delay(chunk);
      remaining -= chunk;
    }
    return this.generation === captured;
  }

  /**
   * Ramp to an absolute target over a fixed total duration, distributing the
   * integer steps across that duration according to a curve (see RampCurve)
   * rather than at an even cadence. This is the long-fade path: for the sunrise
   * wake a 30->52 climb over 20-45 min reads as continuous because the steps
   * are paced to where the ear is least sensitive to them.
   *
   * Reuses the same mechanics as rampDelta: on the numeric fast path the steps
   * are absolute and fire-and-forget (self-correcting if Roon coalesces one),
   * and the whole ramp is cancellable via the generation counter, so any
   * superseding volume command stops it - here within ~CANCEL_POLL_MS even mid
   * a multi-minute gap between steps. Step *timing* is anchored to a wall clock
   * so a 45-min ramp does not accumulate setTimeout drift or stall.
   *
   * Incremental-only zones have no numeric level to shape against and fall back
   * to an even cadence over totalMs. `onStep(level, index, steps)` is an
   * optional per-step probe for logging the real volume-vs-time timeline.
   *
   * This is the single shaped-cadence path: ramp_volume drives it for long
   * curve-shaped fades, and smooth_skip drives it (curve="perceptual") for its
   * fade-out duck and fade-in ride. Duration-anchored to a wall clock so long
   * durations don't accumulate setTimeout drift or stall.
   */
  async rampCurve(
    target: number,
    getZone: GetZoneFn,
    transport: RoonApiTransport,
    totalMs: number,
    curve: RampCurve = "linear",
    onStep?: (level: number, index: number, steps: number) => void,
  ): Promise<void> {
    this.generation++;
    const captured = this.generation;

    const zone = getZone();
    if (!zone) return;

    const allVolume = getVolumeOutputs(zone);
    if (allVolume.length === 0) return;

    const numeric = getNumericVolumeOutputs(zone);
    const startVol = numeric.length > 0 ? Math.max(...numeric.map((o) => o.volume!.value ?? 0)) : 0;
    const delta = target - startVol;
    const steps = Math.abs(delta);
    if (steps === 0) return;
    const direction = delta > 0 ? 1 : -1;

    // Numeric fast path: absolute, fire-and-forget, curve-shaped cadence,
    // anchored to a wall clock so long durations don't drift or stall.
    if (numeric.length === allVolume.length) {
      const startedAt = Date.now();
      for (let i = 1; i <= steps; i++) {
        const dueAt = totalMs * cadence(curve, i / steps, startVol, target);
        const wait = dueAt - (Date.now() - startedAt);
        if (wait > 0 && !(await this.waitCancellable(wait, captured))) return;
        if (this.generation !== captured) return;
        const rawTarget = startVol + direction * i;
        for (const output of numeric) {
          const stepTarget = clampToOutput(output, rawTarget);
          transport.change_volume(output, "absolute", stepTarget, (err) => {
            if (err) console.error("[VolumeRamper] curve step failed:", err);
          });
        }
        onStep?.(rawTarget, i, steps);
      }
      return;
    }

    // Incremental-only fallback: even cadence over totalMs (no level to shape).
    const stepDelay = Math.max(0, Math.round(totalMs / steps));
    for (let i = 0; i < steps; i++) {
      if (this.generation !== captured) return;
      const currentZone = getZone();
      if (!currentZone) return;
      const outputs = getVolumeOutputs(currentZone);
      if (outputs.length === 0) return;
      await Promise.all(
        outputs.map((output) =>
          promisifyResult((cb) =>
            transport.change_volume(output, "relative", direction, cb),
          ),
        ),
      );
      if (i < steps - 1 && !(await this.waitCancellable(stepDelay, captured))) return;
    }
  }

  /**
   * Instant (single-call) relative volume change. Does NOT cancel in-progress ramps.
   */
  async instantDelta(
    delta: number,
    getZone: GetZoneFn,
    transport: RoonApiTransport,
  ): Promise<void> {
    if (delta === 0) return;

    const zone = getZone();
    if (!zone) return;

    const allVolume = getVolumeOutputs(zone);
    if (allVolume.length === 0) return;

    const numeric = getNumericVolumeOutputs(zone);

    if (numeric.length === allVolume.length) {
      // Compute a per-output absolute target and clamp to [min, max] so a
      // burst of relative-down keypresses cannot push an output below its
      // floor (where the Devialet auto-mutes and the group desyncs).
      await Promise.all(
        numeric.map((output) => {
          const current = output.volume!.value ?? 0;
          const target = clampToOutput(output, current + delta);
          if (target === current) return Promise.resolve<false | string>(false);
          return promisifyResult((cb) =>
            transport.change_volume(output, "absolute", target, cb),
          );
        }),
      );
      return;
    }

    // Incremental-only outputs have no numeric level to clamp; relative path.
    await Promise.all(
      allVolume.map((output) =>
        promisifyResult((cb) =>
          transport.change_volume(output, "relative", delta, cb),
        ),
      ),
    );
  }

  /**
   * Instant (single-call) absolute volume change.
   * Reads current max, computes delta, applies a single relative call per output.
   */
  async instantAbsolute(
    target: number,
    getZone: GetZoneFn,
    transport: RoonApiTransport,
  ): Promise<void> {
    const zone = getZone();
    if (!zone) return;

    const numericOutputs = getNumericVolumeOutputs(zone);
    if (numericOutputs.length === 0) return;

    const currentMax = Math.max(...numericOutputs.map((o) => o.volume!.value ?? 0));
    const delta = target - currentMax;
    if (delta === 0) return;

    await Promise.all(
      numericOutputs.map((output) =>
        promisifyResult((cb) =>
          transport.change_volume(output, "relative", delta, cb),
        ),
      ),
    );
  }

  /**
   * Toggle mute on all volume-controllable outputs of the zone.
   * If ALL are muted, unmute all. Otherwise mute all.
   */
  async toggleMute(getZone: GetZoneFn, transport: RoonApiTransport): Promise<void> {
    const zone = getZone();
    if (!zone) return;

    const outputs = getVolumeOutputs(zone);
    if (outputs.length === 0) return;

    const allMuted = outputs.every((o) => o.volume?.is_muted === true);
    const how = allMuted ? "unmute" : "mute";

    await Promise.all(
      outputs.map((output) =>
        promisifyResult((cb) => transport.mute(output, how, cb)),
      ),
    );
  }

  /** Update ramp step delay (e.g. from config change). */
  setRampStepMs(ms: number): void {
    this.rampStepMs = ms;
  }

  /**
   * Current max numeric volume across a zone's outputs, or null if the zone
   * has no numeric-volume outputs. Callers use this to size a ramp (number of
   * 1-unit steps) when deriving a step cadence from a target duration.
   */
  static currentMaxVolume(zone: Zone): number | null {
    const numeric = getNumericVolumeOutputs(zone);
    if (numeric.length === 0) return null;
    return Math.max(...numeric.map((o) => o.volume!.value ?? 0));
  }
}
