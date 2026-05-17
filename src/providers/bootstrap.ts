/**
 * Registers concrete adapters for the enabled providers. Kept separate from
 * registry.ts so the registry stays adapter-agnostic (no import cycle, and
 * adding Tidal is a one-line change here, nowhere else).
 */

import { getRegistry, type ProviderRegistry } from "./registry.js";
import { QobuzProvider } from "./qobuz/index.js";

let done = false;

/** Idempotent: build the registry and register enabled adapters. */
export function initProviders(): ProviderRegistry {
  const reg = getRegistry();
  if (done) return reg;

  if (reg.enabledNames.includes("qobuz") && !reg.has("qobuz")) {
    reg.register(new QobuzProvider());
  }
  // Tidal: when an adapter exists, register it here under the same guard.

  done = true;
  return reg;
}
