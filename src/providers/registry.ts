/**
 * Config-driven provider registry.
 *
 * Which providers are enabled and which is the default come from env, mirroring
 * the BRIDGE_* convention in server.ts:
 *   MUSIC_PROVIDERS         comma list, default "qobuz"
 *   MUSIC_PROVIDER_DEFAULT  default = first enabled
 *
 * Tools resolve a provider via get(name?) — omitting name yields the default.
 * This is the seam that makes Tidal "register an adapter", nothing more.
 */

import { type MusicProvider, type ProviderName, ProviderError } from "./types.js";

const ALL_PROVIDERS: readonly ProviderName[] = ["qobuz", "tidal"];

export interface ProviderConfig {
  enabled: ProviderName[];
  default: ProviderName;
}

function isProviderName(s: string): s is ProviderName {
  return (ALL_PROVIDERS as readonly string[]).includes(s);
}

/** Pure parse of provider config from an env-like map (injectable for tests). */
export function loadProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  const rawList = (env.MUSIC_PROVIDERS ?? "qobuz")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const enabled: ProviderName[] = [];
  for (const p of rawList) {
    if (!isProviderName(p)) {
      throw new ProviderError("config", `Unknown provider in MUSIC_PROVIDERS: "${p}"`);
    }
    if (!enabled.includes(p)) enabled.push(p);
  }
  if (enabled.length === 0) {
    throw new ProviderError("config", "MUSIC_PROVIDERS resolved to an empty list");
  }

  const rawDefault = env.MUSIC_PROVIDER_DEFAULT?.trim().toLowerCase();
  let dflt: ProviderName;
  if (rawDefault) {
    if (!isProviderName(rawDefault)) {
      throw new ProviderError("config", `Unknown MUSIC_PROVIDER_DEFAULT: "${rawDefault}"`);
    }
    if (!enabled.includes(rawDefault)) {
      throw new ProviderError(
        "config",
        `MUSIC_PROVIDER_DEFAULT "${rawDefault}" is not in MUSIC_PROVIDERS`,
      );
    }
    dflt = rawDefault;
  } else {
    dflt = enabled[0];
  }

  return { enabled, default: dflt };
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, MusicProvider>();

  constructor(private readonly config: ProviderConfig) {}

  /** Register an adapter. Throws if it isn't in the enabled set. */
  register(provider: MusicProvider): void {
    if (!this.config.enabled.includes(provider.name)) {
      throw new ProviderError(
        "config",
        `Provider "${provider.name}" is not enabled (MUSIC_PROVIDERS)`,
        provider.name,
      );
    }
    this.providers.set(provider.name, provider);
  }

  /** Resolve a provider; omit name for the configured default. */
  get(name?: ProviderName): MusicProvider {
    const target = name ?? this.config.default;
    const p = this.providers.get(target);
    if (!p) {
      throw new ProviderError(
        "config",
        name
          ? `Provider "${name}" is enabled but not registered`
          : `Default provider "${target}" is not registered`,
        target,
      );
    }
    return p;
  }

  has(name: ProviderName): boolean {
    return this.providers.has(name);
  }

  list(): ProviderName[] {
    return [...this.providers.keys()];
  }

  get defaultName(): ProviderName {
    return this.config.default;
  }

  get enabledNames(): ProviderName[] {
    return [...this.config.enabled];
  }
}

let _registry: ProviderRegistry | null = null;

/** Process-wide registry, built from env on first use. */
export function getRegistry(): ProviderRegistry {
  if (!_registry) _registry = new ProviderRegistry(loadProviderConfig());
  return _registry;
}

/** Test-only reset of the singleton. */
export function _resetRegistryForTests(): void {
  _registry = null;
}
