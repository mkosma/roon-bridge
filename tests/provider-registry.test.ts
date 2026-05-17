import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  loadProviderConfig,
} from "../src/providers/registry.js";
import {
  type MusicProvider,
  type ProviderName,
  ProviderError,
} from "../src/providers/types.js";

function fakeProvider(name: ProviderName): MusicProvider {
  return {
    name,
    searchTracks: async () => [],
    listPlaylists: async () => [],
    getPlaylist: async () => ({
      playlist: { provider: name, id: "x", name: "x", trackCount: 0, isPublic: false },
      tracks: [],
    }),
    createPlaylist: async () => ({
      provider: name,
      id: "x",
      name: "x",
      trackCount: 0,
      isPublic: false,
    }),
    addTracks: async () => {},
    removeTracks: async () => {},
    renamePlaylist: async () => {},
    deletePlaylist: async () => {},
  };
}

describe("loadProviderConfig", () => {
  it("defaults to qobuz only, qobuz default", () => {
    expect(loadProviderConfig({})).toEqual({ enabled: ["qobuz"], default: "qobuz" });
  });

  it("parses a list and dedupes, default = first enabled", () => {
    expect(loadProviderConfig({ MUSIC_PROVIDERS: "qobuz, tidal ,qobuz" })).toEqual({
      enabled: ["qobuz", "tidal"],
      default: "qobuz",
    });
  });

  it("honors an explicit default within the enabled set", () => {
    expect(
      loadProviderConfig({ MUSIC_PROVIDERS: "qobuz,tidal", MUSIC_PROVIDER_DEFAULT: "tidal" }),
    ).toEqual({ enabled: ["qobuz", "tidal"], default: "tidal" });
  });

  it("rejects an unknown provider", () => {
    expect(() => loadProviderConfig({ MUSIC_PROVIDERS: "spotify" })).toThrow(ProviderError);
  });

  it("rejects a default not in the enabled set", () => {
    expect(() =>
      loadProviderConfig({ MUSIC_PROVIDERS: "qobuz", MUSIC_PROVIDER_DEFAULT: "tidal" }),
    ).toThrow(/not in MUSIC_PROVIDERS/);
  });

  it("rejects an empty list", () => {
    expect(() => loadProviderConfig({ MUSIC_PROVIDERS: " , " })).toThrow(/empty list/);
  });
});

describe("ProviderRegistry", () => {
  it("resolves the default when no name is given", () => {
    const reg = new ProviderRegistry({ enabled: ["qobuz"], default: "qobuz" });
    reg.register(fakeProvider("qobuz"));
    expect(reg.get().name).toBe("qobuz");
    expect(reg.get("qobuz").name).toBe("qobuz");
  });

  it("refuses to register a provider that isn't enabled", () => {
    const reg = new ProviderRegistry({ enabled: ["qobuz"], default: "qobuz" });
    expect(() => reg.register(fakeProvider("tidal"))).toThrow(/not enabled/);
  });

  it("throws when an enabled provider was never registered", () => {
    const reg = new ProviderRegistry({ enabled: ["qobuz", "tidal"], default: "qobuz" });
    reg.register(fakeProvider("qobuz"));
    expect(() => reg.get("tidal")).toThrow(/not registered/);
  });

  it("tracks registered providers and the default name", () => {
    const reg = new ProviderRegistry({ enabled: ["qobuz", "tidal"], default: "tidal" });
    reg.register(fakeProvider("qobuz"));
    reg.register(fakeProvider("tidal"));
    expect(reg.list().sort()).toEqual(["qobuz", "tidal"]);
    expect(reg.has("tidal")).toBe(true);
    expect(reg.defaultName).toBe("tidal");
  });
});
