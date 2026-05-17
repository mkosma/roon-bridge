/**
 * Opt-in live probe (read-only), mirroring the Rust spike. Skipped unless
 * QOBUZ_LIVE=1 — it talks to real Qobuz using the on-disk token.json.
 *   QOBUZ_LIVE=1 npx vitest run tests/qobuz-provider.live.test.ts
 */
import { describe, it, expect } from "vitest";
import { QobuzProvider } from "../src/providers/qobuz/index.js";

const live = process.env.QOBUZ_LIVE === "1";

describe.skipIf(!live)("QobuzProvider (live, read-only)", () => {
  it("searches tracks", async () => {
    const p = new QobuzProvider();
    const tracks = await p.searchTracks("Spoon", 3);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks[0]).toHaveProperty("id");
    expect(tracks[0].provider).toBe("qobuz");
  });

  it("lists the user's playlists", async () => {
    const p = new QobuzProvider();
    const pls = await p.listPlaylists(5);
    expect(Array.isArray(pls)).toBe(true);
    if (pls.length) expect(pls[0].provider).toBe("qobuz");
  });
});
