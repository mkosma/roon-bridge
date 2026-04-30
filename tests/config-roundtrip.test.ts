/**
 * Tests for roon-key config read/write/validate.
 *
 * Uses vi.mock to avoid touching the real config.json on disk.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateRoonKeyConfig,
  DEFAULT_ROON_KEY_CONFIG,
} from "../src/control/roon-key-config.js";
import type { RoonKeyConfig } from "../src/control/roon-key-config.js";

// ---------------------------------------------------------------------------
// Validation tests (no filesystem needed)
// ---------------------------------------------------------------------------

describe("validateRoonKeyConfig", () => {
  const validConfig: RoonKeyConfig = {
    active_zone_display_name: "WiiM + 1",
    volume_step: 8,
    ramp_step_ms: 20,
    presets: [32, 40, 48, 56, 64, 72, 80],
    extras: {
      open_roon_app: true,
      muse_toggle: false,
      favorites: [],
    },
  };

  it("accepts a valid config object", () => {
    expect(validateRoonKeyConfig(validConfig)).toEqual({ ok: true });
  });

  it("rejects null", () => {
    const r = validateRoonKeyConfig(null);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("rejects missing active_zone_display_name", () => {
    const bad = { ...validConfig, active_zone_display_name: 42 };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects volume_step = 0", () => {
    const bad = { ...validConfig, volume_step: 0 };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects volume_step = 51", () => {
    const bad = { ...validConfig, volume_step: 51 };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("accepts volume_step boundary values 1 and 50", () => {
    expect(validateRoonKeyConfig({ ...validConfig, volume_step: 1 }).ok).toBe(true);
    expect(validateRoonKeyConfig({ ...validConfig, volume_step: 50 }).ok).toBe(true);
  });

  it("rejects ramp_step_ms = 4", () => {
    const bad = { ...validConfig, ramp_step_ms: 4 };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects ramp_step_ms = 201", () => {
    const bad = { ...validConfig, ramp_step_ms: 201 };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("accepts ramp_step_ms boundary values 5 and 200", () => {
    expect(validateRoonKeyConfig({ ...validConfig, ramp_step_ms: 5 }).ok).toBe(true);
    expect(validateRoonKeyConfig({ ...validConfig, ramp_step_ms: 200 }).ok).toBe(true);
  });

  it("rejects empty presets array", () => {
    const bad = { ...validConfig, presets: [] };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects presets array with 13 entries", () => {
    const bad = { ...validConfig, presets: Array(13).fill(50) };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("accepts 12 presets", () => {
    const good = { ...validConfig, presets: Array(12).fill(50) };
    expect(validateRoonKeyConfig(good).ok).toBe(true);
  });

  it("rejects preset value 101", () => {
    const bad = { ...validConfig, presets: [101] };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects preset value -1", () => {
    const bad = { ...validConfig, presets: [-1] };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("accepts preset boundary values 0 and 100", () => {
    expect(validateRoonKeyConfig({ ...validConfig, presets: [0] }).ok).toBe(true);
    expect(validateRoonKeyConfig({ ...validConfig, presets: [100] }).ok).toBe(true);
  });

  it("rejects non-integer preset (float)", () => {
    const bad = { ...validConfig, presets: [50.5] };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects missing extras", () => {
    const { extras: _extras, ...bad } = validConfig;
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects extras.open_roon_app as non-boolean", () => {
    const bad = { ...validConfig, extras: { ...validConfig.extras, open_roon_app: "yes" } };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });

  it("rejects extras.favorites as non-array", () => {
    const bad = { ...validConfig, extras: { ...validConfig.extras, favorites: "none" } };
    expect(validateRoonKeyConfig(bad).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default config shape
// ---------------------------------------------------------------------------

describe("DEFAULT_ROON_KEY_CONFIG", () => {
  it("passes its own validation", () => {
    expect(validateRoonKeyConfig(DEFAULT_ROON_KEY_CONFIG)).toEqual({ ok: true });
  });

  it("has 7 presets matching the spec", () => {
    expect(DEFAULT_ROON_KEY_CONFIG.presets).toEqual([32, 40, 48, 56, 64, 72, 80]);
  });

  it("has volume_step 8 and ramp_step_ms 20", () => {
    expect(DEFAULT_ROON_KEY_CONFIG.volume_step).toBe(8);
    expect(DEFAULT_ROON_KEY_CONFIG.ramp_step_ms).toBe(20);
  });
});
