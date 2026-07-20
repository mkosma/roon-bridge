/**
 * Tests for the event-driven deferred-replace feature (Objective 5):
 *   Part A - DeferredPlayer boundary logic in isolation (fake event source).
 *   Part B - play_album/play_track when='after_current' wiring through the
 *            browse tool, with a mock roon-connection that emits the same
 *            "zone-seek" / "zones-changed" events the real connection does.
 *
 * The whole point is that timing happens server-side off Roon's own events,
 * not a wall-clock timer - so these drive synthetic track-change events rather
 * than waiting on any clock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import type { Zone } from "node-roon-api-transport";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import { DeferredPlayer, type SeamOutcome } from "../src/control/deferred-player.js";
import { deferralLedger } from "../src/control/deferral-ledger.js";

// A no-op seam action that reports a clean, verified landing.
const okOutcome: SeamOutcome = { ok: true, verified: true };
const META = { zoneId: "zone-1", zoneName: "WiiM + 1", trigger: "end of X", description: "test action" };

// ---------------------------------------------------------------------------
// Part A: DeferredPlayer in isolation
// ---------------------------------------------------------------------------

class FakeSource extends EventEmitter {
  zone: Zone | null = null;
  findZone(): Zone | null {
    return this.zone;
  }
}

function playingZone(title: string, length: number, seek: number, state: Zone["state"] = "playing"): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state,
    outputs: [],
    now_playing: {
      one_line: { line1: title },
      two_line: { line1: title, line2: "Artist" },
      three_line: { line1: title, line2: "Artist" },
      length,
      seek_position: seek,
    },
  } as unknown as Zone;
}

function setTrack(src: FakeSource, title: string, length: number, seek: number) {
  src.zone = playingZone(title, length, seek);
}
function setSeek(src: FakeSource, seek: number) {
  if (src.zone?.now_playing) src.zone.now_playing.seek_position = seek;
}

describe("DeferredPlayer", () => {
  beforeEach(() => deferralLedger.reset());

  it("fires immediately when nothing is playing", async () => {
    const src = new FakeSource();
    src.zone = playingZone("X", 100, 0, "stopped");
    const player = new DeferredPlayer(src);
    const action = vi.fn(async () => okOutcome);

    const res = await player.scheduleAfterCurrent(src.zone, action, META);
    expect(res.status).toBe("fired");
    expect(res.deferral_id).toMatch(/^d-/);
    expect(action).toHaveBeenCalledTimes(1);
    expect(player.isArmed()).toBe(false);
    // A fire-now verified action is recorded fired_verified.
    expect(deferralLedger.get(res.deferral_id)?.status).toBe("fired_verified");
  });

  it("fires at a natural track end (outgoing track played to completion)", async () => {
    const src = new FakeSource();
    setTrack(src, "Track A", 100, 0);
    const player = new DeferredPlayer(src);
    const action = vi.fn(async () => okOutcome);

    const res = await player.scheduleAfterCurrent(src.zone!, action, META);
    expect(res.status).toBe("scheduled");
    expect(action).not.toHaveBeenCalled();
    expect(deferralLedger.get(res.deferral_id)?.status).toBe("armed");

    // Progress to near the end, then the track changes -> natural end -> fire.
    setSeek(src, 90);
    src.emit("zone-seek", "zone-1");
    setTrack(src, "Track B", 100, 0);
    src.emit("zones-changed");

    await Promise.resolve();
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    expect(player.isArmed()).toBe(false);
    expect(deferralLedger.get(res.deferral_id)?.status).toBe("fired_verified");
  });

  it("fires on a manual skip too (any advance past the trigger track fires it)", async () => {
    const src = new FakeSource();
    setTrack(src, "Track A", 100, 0);
    const player = new DeferredPlayer(src);
    const action = vi.fn(async () => okOutcome);

    const res = await player.scheduleAfterCurrent(src.zone!, action, META);

    // Skip early: only 20% elapsed when the track changes. The zone left the
    // armed track, so the action fires now (was: silently re-armed onto B).
    setSeek(src, 20);
    src.emit("zone-seek", "zone-1");
    setTrack(src, "Track B", 100, 0);
    src.emit("zones-changed");

    await Promise.resolve();
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    expect(player.isArmed()).toBe(false);
    expect(deferralLedger.get(res.deferral_id)?.status).toBe("fired_verified");
  });

  it("does not fire on a same-track change (pause/settings/queue edit)", async () => {
    const src = new FakeSource();
    setTrack(src, "Track A", 100, 30);
    const player = new DeferredPlayer(src);
    const action = vi.fn(async () => okOutcome);

    await player.scheduleAfterCurrent(src.zone!, action, META);

    // A zones-changed that does NOT change the track (e.g. volume/settings).
    src.emit("zones-changed");
    await Promise.resolve();

    expect(action).not.toHaveBeenCalled();
    expect(player.isArmed()).toBe(true);
  });

  it("cancel() disarms so the boundary no longer fires; records superseded", async () => {
    const src = new FakeSource();
    setTrack(src, "Track A", 100, 90);
    const player = new DeferredPlayer(src);
    const action = vi.fn(async () => okOutcome);

    const res = await player.scheduleAfterCurrent(src.zone!, action, META);
    player.cancel();
    expect(player.isArmed()).toBe(false);
    expect(deferralLedger.get(res.deferral_id)?.status).toBe("superseded");

    setTrack(src, "Track B", 100, 0);
    src.emit("zones-changed");
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
  });

  it("a second schedule supersedes the first (only the latest fires); first recorded superseded", async () => {
    const src = new FakeSource();
    setTrack(src, "Track A", 100, 90);
    const player = new DeferredPlayer(src);
    const first = vi.fn(async () => okOutcome);
    const second = vi.fn(async () => okOutcome);

    const r1 = await player.scheduleAfterCurrent(src.zone!, first, META);
    const r2 = await player.scheduleAfterCurrent(src.zone!, second, META);
    expect(deferralLedger.get(r1.deferral_id)?.status).toBe("superseded");

    setSeek(src, 95);
    src.emit("zone-seek", "zone-1");
    setTrack(src, "Track B", 100, 0);
    src.emit("zones-changed");

    await Promise.resolve();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(deferralLedger.get(r2.deferral_id)?.status).toBe("fired_verified");
  });
});

// ---------------------------------------------------------------------------
// Part B: play_album/play_track when='after_current' through the browse tool
// ---------------------------------------------------------------------------

const world = {
  executed: [] as string[],
};

let stage: "root" | "category" | "match" | "action" = "root";
// The last search input (from a pop_all step), so the "match" stage can model
// a query-specific Roon row - used to simulate a local-library-only item
// (present in Roon's own browse search, absent from the provider mock).
let lastSearchInput = "";

function stageItems(): BrowseItem[] {
  switch (stage) {
    case "category":
      return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
    case "match":
      // "LIBRARY_ONLY" models an album Monty owns locally but that isn't on
      // Qobuz: the provider mock (below) returns zero results for it, while
      // Roon's own browse search (this fixture) still finds the exact row.
      return [{
        title: lastSearchInput === "LIBRARY_ONLY" ? "LIBRARY_ONLY" : "Some Album",
        item_key: "match:album",
        hint: "list",
        subtitle: "An Artist",
      }];
    case "action":
      return [
        { title: "Play Now", item_key: "act:play", hint: "action" },
        { title: "Queue", item_key: "act:queue", hint: "action" },
      ];
    default:
      return [];
  }
}

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: BrowseResult) => void) => {
    if (opts.pop_all) {
      stage = "category";
      lastSearchInput = String(opts.input ?? "");
      cb(false, { action: "list", list: { title: "Search", count: 1, level: 0 } });
      return;
    }
    const key = String(opts.item_key ?? "");
    if (key === "cat:album") {
      stage = "match";
      cb(false, { action: "list", list: { title: "Albums", count: 1, level: 1 } });
      return;
    }
    if (key === "match:album") {
      stage = "action";
      cb(false, { action: "list", list: { title: "Some Album", count: 2, level: 2, hint: "action_list" } });
      return;
    }
    if (key.startsWith("act:")) {
      world.executed.push(key);
      // A Play Now flips the zone's now-playing, so the tool's play-path
      // verification can observe that playback actually changed.
      if (key === "act:play") {
        mockConn.zone = playingZone("Some Album Opener", 100, 0);
      }
      cb(false, { action: "none" });
      return;
    }
    cb(false, { action: "none" });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = stageItems();
    cb(false, { items, offset: 0, list: { title: "x", count: items.length, level: 0 } });
  },
};

class MockConnection extends EventEmitter {
  zone: Zone = playingZone("Now Playing", 100, 0);
  getBrowse() {
    return mockBrowse;
  }
  getTransport() {
    return { change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() };
  }
  findZone() {
    return this.zone;
  }
  findZoneOrThrow() {
    return this.zone;
  }
}

const mockConn = new MockConnection();

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: mockConn,
}));

// A name play now resolves to ONE exact provider id (selectUnique) and funnels
// through the *_by_id gateway - immediately, or pinned into the seam action.
// Mock the provider deterministically: title === query -> a single exact match;
// "EMPTY" -> no results (drives the not_found refusal); "AMBIG" -> two identical
// exact rows (drives the ambiguous refusal).
vi.mock("../src/providers/bootstrap.js", () => ({
  initProviders: () => ({
    get: () => ({
      searchAlbums: async (q: string) =>
        q === "EMPTY" || q === "LIBRARY_ONLY"
          ? []
          : q === "AMBIG"
            ? [
                { provider: "qobuz", id: "alb1", title: q, artist: "Test Artist" },
                { provider: "qobuz", id: "alb2", title: q, artist: "Test Artist" },
              ]
            : [{ provider: "qobuz", id: "alb1", title: q, artist: "Test Artist" }],
      searchTracks: async (q: string) =>
        q === "EMPTY" || q === "LIBRARY_ONLY"
          ? []
          : q === "AMBIG"
            ? [
                { provider: "qobuz", id: "trk1", title: q, artist: "Test Artist" },
                { provider: "qobuz", id: "trk2", title: q, artist: "Test Artist" },
              ]
            : [{ provider: "qobuz", id: "trk1", title: q, artist: "Test Artist" }],
      listPlaylists: async () => [
        { provider: "qobuz", id: "pl1", name: "Some Album" },
        { provider: "qobuz", id: "pl2", name: "Other List" },
        { provider: "qobuz", id: "pl3", name: "AMBIG" },
        { provider: "qobuz", id: "pl4", name: "AMBIG" },
      ],
      getPlaylist: async (id: string) => ({
        playlist: { provider: "qobuz", id, name: "Some Album" },
        tracks: [
          { provider: "qobuz", id: "t1", title: "Track One", artist: "X" },
          { provider: "qobuz", id: "t2", title: "Track Two", artist: "X" },
        ],
      }),
      getTrack: async (id: string) => ({ provider: "qobuz", id, title: "Some Album", artist: "Test Artist" }),
      getAlbum: async (id: string) => ({ provider: "qobuz", id, title: "Some Album", artist: "Test Artist" }),
    }),
  }),
}));

const { registerBrowseTools } = await import("../src/tools/browse.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerBrowseTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, text };
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("default-safe playback: the immediate gate (browse play tools)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    world.executed = [];
    stage = "root";
    lastSearchInput = "";
    mockConn.zone = playingZone("Now Playing", 100, 0);
  });

  // Pinnable browse play tools WITHOUT immediate never cut the current track:
  // they ARM a deferral resolved to exact provider id(s) at arm time (Monty's
  // ruling: the future queue is resolved when Maya creates it, never at play
  // time). Nothing executes at arm time. WITH immediate:true, they play now.
  for (const [tool, arg] of [
    ["play_album", "album"],
    ["play_track", "track"],
    ["play_playlist", "playlist"],
  ] as const) {
    it(`${tool} SAFE DEFAULT (no immediate) arms a deferral pinned at arm time, cuts nothing`, async () => {
      deferralLedger.reset();
      const server = buildServer();
      const { isError, text } = await call(server, tool, { [arg]: "Some Album" });

      expect(isError).toBe(false);
      expect(text).toContain("Scheduled");
      expect(text).toContain("pinned"); // resolved to exact id(s) up front
      expect(text).toContain("cancel_deferred"); // a deferral was armed
      // Nothing executed at arm time - the playing track is intact.
      expect(world.executed).toHaveLength(0);
    });

  }

  // immediate:true funnels through the *_by_id gateway. The album case runs
  // end-to-end against the mock (album-by-id needs no queue snapshot); track /
  // playlist by-id execution is covered exhaustively by play-by-id / queue-
  // tracks. Here we assert the ROUTING contract: a UNIQUE match acts (album),
  // and an ambiguous / unmatched name refuses with candidates and mutates
  // nothing - for every pinnable category.
  it("play_album immediate:true resolves the exact provider album and plays it via play_album_by_id", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", { album: "Some Album", immediate: true });
    expect(isError).toBe(false);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.ok).toBe(true);
    expect(world.executed).toContain("act:play");
  });

  // Local-library fallback (Fix 1): an album that exists only in Monty's
  // local library - the provider (Qobuz) mock returns zero results for
  // "LIBRARY_ONLY" - still resolves and plays, via Roon's own browse/search
  // substrate, instead of a false not_found.
  it("play_album immediate:true falls back to the local library when the provider has zero results, and plays it", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", { album: "LIBRARY_ONLY", immediate: true });
    expect(isError).toBe(false);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.ok).toBe(true);
    // Executed through the Roon-browse action list (act:play), never through
    // an album-by-id provider pin - there is no provider id for this album.
    expect(world.executed).toContain("act:play");
  });

  it("add_to_queue category=album falls back to the local library when the provider has zero results, and queues it", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", { query: "LIBRARY_ONLY", category: "album" });
    expect(isError).toBe(false);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.ok).toBe(true);
    expect(world.executed).toContain("act:queue");
  });

  it("play_album immediate:true still refuses (not_found) when NEITHER the provider NOR the local library has an exact match", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", { album: "EMPTY", immediate: true });
    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("not_found");
    expect(world.executed).toHaveLength(0);
  });

  for (const [tool, arg] of [
    ["play_album", "album"],
    ["play_track", "track"],
    ["play_playlist", "playlist"],
  ] as const) {
    it(`${tool} immediate:true with an AMBIGUOUS name returns candidates and plays nothing`, async () => {
      const server = buildServer();
      const { isError, text } = await call(server, tool, { [arg]: "AMBIG", immediate: true });
      expect(isError).toBe(true);
      const json = JSON.parse(text.slice(text.indexOf("{")));
      expect(json.error).toBe("ambiguous");
      expect(world.executed).toHaveLength(0);
    });
  }

  // Artist has no stable provider id, so a DEFERRED artist play can't be pinned
  // -> refuse at arm time (Maya plays it now or names a specific album/track).
  it("play_artist SAFE DEFAULT (no immediate) refuses - an artist can't be pinned", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_artist", { artist: "Radiohead" });

    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain("can't be pinned");
    expect(world.executed).toHaveLength(0);
  });

  it("play_artist immediate:true still replaces and plays right now (browse path)", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_artist", { artist: "Some Album", immediate: true });

    expect(isError).toBe(false);
    expect(text).toContain("Now playing");
    expect(world.executed).toContain("act:play");
  });

  // A deferred track/album with no exact provider match refuses at arm time
  // (fail early, while Maya can still ask) - never silently at the seam.
  it("deferred play with no exact provider match refuses (not_found) at arm time", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_track", { track: "EMPTY" });

    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("not_found");
    expect(world.executed).toHaveLength(0);
  });
});
