import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { TidalProvider } from "../src/providers/tidal/index.js";
import { ProviderError } from "../src/providers/types.js";

// Proves the port is genuinely pluggable: a second adapter registers and
// resolves through the same registry the tools use, with zero tool changes.
describe("Tidal stub pluggability", () => {
  it("registers and resolves alongside qobuz", () => {
    const reg = new ProviderRegistry({ enabled: ["qobuz", "tidal"], default: "qobuz" });
    reg.register(new TidalProvider());
    expect(reg.get("tidal").name).toBe("tidal");
  });

  it("fails fast with a clear ProviderError until implemented", async () => {
    const t = new TidalProvider();
    await expect(t.searchTracks()).rejects.toBeInstanceOf(ProviderError);
    await expect(t.listPlaylists()).rejects.toThrow(/not implemented yet/);
  });
});
