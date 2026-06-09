/**
 * Tests for waitForTrackStart - the smooth_skip fade-in gate. It must resolve
 * only when the zone is playing a DIFFERENT track with its seek advancing
 * (real audio), and fall back on a timeout so the fade-in (and the volume
 * restore) always happens even if the expected events never arrive.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Zone } from "node-roon-api-transport";
import { waitForTrackStart, trackKeyOf } from "../src/control/track-gate.js";

function makeZone(track: string, seek: number, state: Zone["state"] = "playing"): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state,
    outputs: [],
    now_playing: {
      three_line: { line1: track, line2: "An Artist", line3: "An Album" },
      length: 200,
      seek_position: seek,
    },
  } as unknown as Zone;
}

const PREV = trackKeyOf(makeZone("Track One", 5).now_playing);

describe("waitForTrackStart", () => {
  it("resolves immediately when a new track is already producing audio", async () => {
    const source = new EventEmitter();
    let zone = makeZone("Track Two", 3);
    const res = await waitForTrackStart(source, () => zone, "zone-1", PREV, { timeoutMs: 1000 });
    expect(res).toBe("playing");
  });

  it("waits for a zone-seek event when the new track lands silent (seek 0)", async () => {
    const source = new EventEmitter();
    let zone = makeZone("Track Two", 0); // new track, no audio yet
    const p = waitForTrackStart(source, () => zone, "zone-1", PREV, { timeoutMs: 1000 });

    // A seek tick for a DIFFERENT zone must not release the gate.
    source.emit("zone-seek", "other-zone");
    await new Promise((r) => setTimeout(r, 10));

    // Audio starts flowing on our zone -> release.
    zone = makeZone("Track Two", 4);
    source.emit("zone-seek", "zone-1");
    expect(await p).toBe("playing");
  });

  it("does not release while the same track is still playing", async () => {
    const source = new EventEmitter();
    const zone = makeZone("Track One", 50); // unchanged track, still advancing
    const res = await waitForTrackStart(source, () => zone, "zone-1", PREV, { timeoutMs: 30 });
    expect(res).toBe("timeout");
  });

  it("falls back to timeout when no track-start event arrives", async () => {
    const source = new EventEmitter();
    const zone = makeZone("Track Two", 0); // new track, never gets audio
    const res = await waitForTrackStart(source, () => zone, "zone-1", PREV, { timeoutMs: 30 });
    expect(res).toBe("timeout");
  });

  it("detaches its listeners once settled", async () => {
    const source = new EventEmitter();
    let zone = makeZone("Track Two", 0);
    const p = waitForTrackStart(source, () => zone, "zone-1", PREV, { timeoutMs: 1000 });
    zone = makeZone("Track Two", 4);
    source.emit("zone-seek", "zone-1");
    await p;
    expect(source.listenerCount("zone-seek")).toBe(0);
    expect(source.listenerCount("zones-changed")).toBe(0);
  });
});
