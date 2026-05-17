/**
 * Registers concrete adapters for the enabled providers. Kept separate from
 * registry.ts so the registry stays adapter-agnostic (no import cycle, and
 * adding Tidal is a one-line change here, nowhere else).
 */

import { getRegistry, type ProviderRegistry } from "./registry.js";
import { QobuzProvider } from "./qobuz/index.js";
import { TidalProvider } from "./tidal/index.js";

let done = false;

/** Idempotent: build the registry and register enabled adapters. */
export function initProviders(): ProviderRegistry {
  const reg = getRegistry();
  if (done) return reg;

  if (reg.enabledNames.includes("qobuz") && !reg.has("qobuz")) {
    reg.register(new QobuzProvider());
  }
  if (reg.enabledNames.includes("tidal") && !reg.has("tidal")) {
    reg.register(new TidalProvider());
  }

  done = true;
  return reg;
}
