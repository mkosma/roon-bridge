/**
 * roon-key config block: schema, validation, read/write helpers.
 *
 * All roon-key settings live in roon-bridge's config.json under the
 * top-level key "roon_key". roon-key reads and writes via HTTP endpoints;
 * there is no local config file on the mbp.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface RoonKeyExtras {
  open_roon_app: boolean;
  muse_toggle: boolean;
  favorites: string[];
}

export interface RoonKeyConfig {
  active_zone_display_name: string;
  volume_step: number;
  ramp_step_ms: number;
  presets: number[];
  extras: RoonKeyExtras;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ROON_KEY_CONFIG: RoonKeyConfig = {
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateRoonKeyConfig(cfg: unknown): ValidationResult {
  if (typeof cfg !== "object" || cfg === null) {
    return { ok: false, error: "config must be an object" };
  }

  const c = cfg as Record<string, unknown>;

  if (typeof c.active_zone_display_name !== "string") {
    return { ok: false, error: "active_zone_display_name must be a string" };
  }

  if (typeof c.volume_step !== "number" || c.volume_step < 1 || c.volume_step > 50) {
    return { ok: false, error: "volume_step must be an integer 1-50" };
  }

  if (typeof c.ramp_step_ms !== "number" || c.ramp_step_ms < 5 || c.ramp_step_ms > 200) {
    return { ok: false, error: "ramp_step_ms must be an integer 5-200" };
  }

  if (!Array.isArray(c.presets)) {
    return { ok: false, error: "presets must be an array" };
  }
  if (c.presets.length < 1 || c.presets.length > 12) {
    return { ok: false, error: "presets must have 1-12 entries" };
  }
  for (const p of c.presets as unknown[]) {
    if (typeof p !== "number" || p < 0 || p > 100 || !Number.isInteger(p)) {
      return { ok: false, error: "each preset must be an integer 0-100" };
    }
  }

  if (typeof c.extras !== "object" || c.extras === null) {
    return { ok: false, error: "extras must be an object" };
  }

  const extras = c.extras as Record<string, unknown>;
  if (typeof extras.open_roon_app !== "boolean") {
    return { ok: false, error: "extras.open_roon_app must be a boolean" };
  }
  if (typeof extras.muse_toggle !== "boolean") {
    return { ok: false, error: "extras.muse_toggle must be a boolean" };
  }
  if (!Array.isArray(extras.favorites)) {
    return { ok: false, error: "extras.favorites must be an array" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readFullConfig(): Record<string, unknown> {
  try {
    const content = readFileSync(CONFIG_PATH, { encoding: "utf8" });
    return (JSON.parse(content) as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}

/** Read roon_key config block, merged with defaults. */
export function readRoonKeyConfig(): RoonKeyConfig {
  const full = readFullConfig();
  const stored = full.roon_key as Partial<RoonKeyConfig> | undefined;
  if (!stored) return { ...DEFAULT_ROON_KEY_CONFIG };

  return {
    ...DEFAULT_ROON_KEY_CONFIG,
    ...stored,
    extras: {
      ...DEFAULT_ROON_KEY_CONFIG.extras,
      ...(stored.extras ?? {}),
    },
  };
}

/**
 * Write roon_key config block atomically (write tmp file, then rename).
 * Preserves all other keys in config.json.
 */
export function writeRoonKeyConfig(cfg: RoonKeyConfig): void {
  const full = readFullConfig();
  full.roon_key = cfg;

  const json = JSON.stringify(full, null, "    ");
  const tmpPath = `${CONFIG_PATH}.tmp`;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(tmpPath, json, { encoding: "utf8" });
  renameSync(tmpPath, CONFIG_PATH);
}
