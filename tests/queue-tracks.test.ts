/**
 * Tests for the ORDERED batch enqueue (queue_tracks / play_tracks) against a
 * mocked Roon browse + mocked provider, with a mock queue that the browse
 * actions actually mutate so order is observable.
 *
 * Covers the spec's batch surface:
 *   - the batch resolver (N ids -> N exact rows, queued in order),
 *   - the order assertion (when='next' with prior present lands the set forward,
 *     contiguous, right after the current track - via reverse Add-Next from
 *     pre-resolved rows, the non-racy path),
 *   - when='queue' / when='now',
 *   - the partial-failure path (a bogus id is flagged with its index, the rest
 *     still queue in correct relative order, nothing silently dropped),
 *   - when='after_current' (deferral fires at the real track seam).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem, Zone } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

// Five distinct tracks, all same artist, unique titles (so each resolves
// unambiguously via the track-search path).
const TRACKS: Record<string, ProviderTrack> = {
  "1": { provider: "qobuz", id: "1", title: "Track One", artist: "The Band", album: "Album A", trackNumber: 1 },
  "2": { provider: "qobuz", id: "2", title: "Track Two", artist: "The Band", album: "Album A", trackNumber: 2 },
  "3": { provider: "qobuz", id: "3", title: "Track Three", artist: "The Band", album: "Album A", trackNumber: 3 },
  "4": { provider: "qobuz", id: "4", title: "Track Four", artist: "The Band", album: "Album A", trackNumber: 4 },
  "5": { provider: "qobuz", id: "5", title: "Track Five", artist: "The Band", album: "Album A", trackNumber: 5 },
};

let queue: QueueItem[] = [];
let nextQId = 9000;
const executed: string[] = [];
let lastBrowse = "root";
let lastInput = "";

function qitem(title: string, artist: string): QueueItem {
  return {
    queue_item_id: nextQId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

function actions(id: string): BrowseItem[] {
  return [
    { title: "Play Now", item_key: `act:play:${id}`, hint: "action" },
    { title: "Add Next", item_key: `act:next:${id}`, hint: "action" },
    { title: "Queue", item_key: `act:queue:${id}`, hint: "action" },
    { title: "Start Radio", item_key: `act:radio:${id}`, hint: "action" },
  ];
}

function loadItems(): BrowseItem[] {
  if (lastBrowse === "root") return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
  if (lastBrowse === "cat:track") {
    const t = Object.values(TRACKS).find((t) => lastInput.toLowerCase().includes(t.title.toLowerCase()));
    return t ? [{ title: t.title, item_key: `trk:${t.id}`, hint: "list", subtitle: t.artist }] : [];
  }
  if (lastBrowse.startsWith("trk:")) return actions(lastBrowse.slice(4));
  return [];
}

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: BrowseResult) => void) => {
    if (opts.pop_all) {
      lastBrowse = "root";
      lastInput = String(opts.input ?? "");
      cb(false, { action: "list", list: { title: "Search", count: 1, level: 0 } });
      return;
    }
    const key = String(opts.item_key ?? "");
    if (key.startsWith("act:")) {
      const [, verb, id] = key.split(":");
      const t = TRACKS[id];
      if (t) {
        const item = qitem(t.title, t.artist);
        if (verb === "queue") queue.push(item);
        else if (verb === "next") queue.length === 0 ? queue.push(item) : queue.splice(1, 0, item);
        else if (verb === "play") queue = [item];
      }
      executed.push(key);
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key.startsWith("trk:");
    cb(false, {
      action: "list",
      list: { title: key, count: loadItems().length, level: 1, hint: isActions ? "action_list" : undefined },
    });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = loadItems();
    cb(false, { items, offset: 0, list: { title: lastBrowse, count: items.length, level: 0 } });
  },
};

function playingZone(): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: "playing",
    outputs: [],
    now_playing: {
      one_line: { line1: "Current" },
      two_line: { line1: "Current", line2: "The Band" },
      three_line: { line1: "Current", line2: "The Band" },
      length: 100,
      seek_position: 0,
    },
  } as unknown as Zone;
}

class MockConn extends EventEmitter {
  zone: Zone = playingZone();
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
  async getQueueSnapshot() {
    return queue.slice();
  }
}

const mockConn = new MockConn();

vi.mock("../src/roon-connection.js", () => ({ roonConnection: mockConn }));

vi.mock("../src/providers/bootstrap.js", () => ({
  initProviders: () => ({
    get: () => ({
      getTrack: async (id: string) => {
        const t = TRACKS[id];
        if (!t) throw new Error(`unknown track ${id}`);
        return t;
      },
    }),
  }),
}));

const { registerPlayByIdTools } = await import("../src/tools/play-by-id.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerPlayByIdTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, json: JSON.parse(text) };
}

function titles(): string[] {
  return queue.map((q) => q.three_line?.line1 ?? "");
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function reset(initialTitles: string[] = []) {
  nextQId = 9000;
  queue = initialTitles.map((t) => qitem(t, "The Band"));
  executed.length = 0;
  lastBrowse = "root";
  lastInput = "";
  mockConn.zone = playingZone();
}

describe("queue_tracks / play_tracks (ordered batch enqueue)", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("batch resolver: queues all 5 tracks in the given order (when='queue')", async () => {
    reset(["Current"]); // current playing, empty upcoming
    const server = buildServer();
    const { isError, json } = await call(server, "queue_tracks", {
      track_ids: ["1", "2", "3", "4", "5"],
      when: "queue",
    });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.count_requested).toBe(5);
    expect(json.count_queued).toBe(5);
    expect(json.order_verified).toBe(true);
    expect(json.contiguous).toBe(true);
    // Appended to the tail in order, current undisturbed.
    expect(titles()).toEqual(["Current", "Track One", "Track Two", "Track Three", "Track Four", "Track Five"]);
    expect(json.tracks.map((t: { ok: boolean }) => t.ok)).toEqual([true, true, true, true, true]);
  });

  it("order assertion: when='next' with prior present lands the set forward, contiguous, right after current", async () => {
    // Current + one already-queued upcoming item; current has ample time left.
    reset(["Current", "Prior Upcoming"]);
    const server = buildServer();
    const { json } = await call(server, "queue_tracks", {
      track_ids: ["1", "2", "3", "4", "5"],
      when: "next",
    });
    expect(json.ok).toBe(true);
    expect(json.order_verified).toBe(true);
    expect(json.contiguous).toBe(true);
    expect(json.anchor_ok).toBe(true);
    // EXACT order: [current, id1..id5, ...prior]. No reversal, no split.
    expect(titles()).toEqual([
      "Current",
      "Track One",
      "Track Two",
      "Track Three",
      "Track Four",
      "Track Five",
      "Prior Upcoming",
    ]);
  });

  it("when='next' with an empty upcoming queue places the set right after current (race-free, no reverse)", async () => {
    reset(["Current"]);
    const server = buildServer();
    const { json } = await call(server, "queue_tracks", { track_ids: ["1", "2", "3"], when: "next" });
    expect(json.ok).toBe(true);
    expect(json.order_verified).toBe(true);
    expect(titles()).toEqual(["Current", "Track One", "Track Two", "Track Three"]);
  });

  it("play_tracks when='now' replaces the queue and plays from the first, rest in order", async () => {
    reset(["Current", "Old"]);
    const server = buildServer();
    const { json } = await call(server, "play_tracks", { track_ids: ["3", "4", "5"] });
    expect(json.ok).toBe(true);
    expect(json.when).toBe("now");
    expect(titles()).toEqual(["Track Three", "Track Four", "Track Five"]);
    expect(executed[0]).toBe("act:play:3");
  });

  it("partial failure: a bogus id is flagged by index, the rest queue in correct relative order", async () => {
    reset(["Current"]);
    const server = buildServer();
    const { json } = await call(server, "queue_tracks", {
      track_ids: ["1", "2", "BOGUS", "4", "5"],
      when: "queue",
    });
    // Not fully ok (one requested track failed), but nothing silently dropped.
    expect(json.ok).toBe(false);
    expect(json.count_requested).toBe(5);
    expect(json.count_queued).toBe(4);
    const bogus = json.tracks.find((t: { index: number }) => t.index === 2);
    expect(bogus.ok).toBe(false);
    expect(bogus.reason).toBe("provider_lookup_failed");
    // The other four landed in correct relative order.
    expect(titles()).toEqual(["Current", "Track One", "Track Two", "Track Four", "Track Five"]);
    expect(json.tracks.filter((t: { ok: boolean }) => t.ok).length).toBe(4);
  });

  it("reports no_tracks_resolved when every id fails, touching nothing", async () => {
    reset(["Current"]);
    const server = buildServer();
    const { isError, json } = await call(server, "queue_tracks", { track_ids: ["BOGUS1", "BOGUS2"] });
    expect(isError).toBe(true);
    expect(json.error).toBe("no_tracks_resolved");
    expect(executed).toHaveLength(0);
    expect(titles()).toEqual(["Current"]);
  });

  it("when='after_current' defers the replace until the real track seam, then plays the set in order", async () => {
    reset(["Current", "Will Be Discarded"]);
    const server = buildServer();
    const { json } = await call(server, "queue_tracks", {
      track_ids: ["1", "2", "3"],
      when: "after_current",
    });
    expect(json.ok).toBe(true);
    expect(json.scheduled).toBe(true);
    // Nothing replaced yet.
    expect(titles()).toEqual(["Current", "Will Be Discarded"]);

    // Drive the current track to a natural end.
    if (mockConn.zone.now_playing) mockConn.zone.now_playing.seek_position = 96;
    mockConn.emit("zone-seek", "zone-1");
    mockConn.zone = playingZone();
    if (mockConn.zone.now_playing) mockConn.zone.now_playing.one_line.line1 = "Different";
    if (mockConn.zone.now_playing) mockConn.zone.now_playing.three_line.line1 = "Different";
    mockConn.emit("zones-changed");

    await waitFor(() => titles().join(",") === "Track One,Track Two,Track Three");
  });
});
