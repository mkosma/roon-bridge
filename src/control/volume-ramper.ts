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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    if (numeric.length === allVolume.length) {
      const startVol = Math.max(...numeric.map((o) => o.volume!.value ?? 0));
      for (let i = 1; i <= steps; i++) {
        if (this.generation !== captured) return;
        const target = startVol + direction * i;
        for (const output of numeric) {
          transport.change_volume(output, "absolute", target, (err) => {
            if (err) console.error("[VolumeRamper] step failed:", err);
          });
        }
        if (i < steps) await delay(this.rampStepMs);
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
      if (i < steps - 1) await delay(this.rampStepMs);
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
  ): Promise<void> {
    // Cancel current ramp generation so rampDelta starts fresh
    this.cancel();

    const zone = getZone();
    if (!zone) return;

    const outputs = getNumericVolumeOutputs(zone);
    if (outputs.length === 0) return;

    const currentMax = Math.max(...outputs.map((o) => o.volume!.value ?? 0));
    const delta = target - currentMax;

    await this.rampDelta(delta, getZone, transport);
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

    const outputs = getVolumeOutputs(zone);
    if (outputs.length === 0) return;

    await Promise.all(
      outputs.map((output) =>
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
}
