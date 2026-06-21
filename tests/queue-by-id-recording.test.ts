/**
 * BUG A regression: queue_by_id / queue_tracks must pin the EXACT recording the
 * provider id denotes, NOT silently substitute a live/alt sibling that outranks
 * the studio cut in Roon's browse.
 *
 * The live failure (2026-06-20, production :3100): provider id 48916424 = studio
 * "New Girl" [When I Pretend To Fall] 2:31, but Roon's track search surfaced
 * "New Girl (Live at The Crocodile)" 3:02 first, and the resolver queued THAT
 * while the return reported the intended studio title. normalizeTitle strips
 * "(Live ...)", so a live row collapses to the same title as the studio cut and
 * passed as an exact, unambiguous match.
 *
 * The mock below models exactly that: the Tracks search for "<artist> New Girl"
 * returns ONLY the live row (the studio cut outranked off the list); the album
 * "When I Pretend To Fall" carries the real studio track. A correct resolver must
 * reject the live row on the track-search path and fall back to the album-anchored
 * studio recording - and the return must read back what ACTUALLY landed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  nextId: 7000,
};

function qitem(title: string, artist: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

// Studio "New Girl" on its real album; and a phantom track whose only Roon
// recording is the live take (no studio anywhere) - must fail honestly.
const TRACKS: Record<string, ProviderTrack> = {
  "48916424": {
    provider: "qobuz", id: "48916424", title: "New Girl", artist: "The Long Winters",
    album: "When I Pretend To Fall", trackNumber: 4, durationSec: 151, year: 2003,
  },
  "999": {
    provider: "qobuz", id: "999", title: "New Girl", artist: "The Long Winters",
    album: "Ghost Sessions", trackNumber: 1, durationSec: 151,
  },
};

const actions = (key: string): BrowseItem[] => [
  { title: "Play Now", item_key: `act:play:${key}`, hint: "action" },
  { title: "Add Next", item_key: `act:next:${key}`, hint: "action" },
  { title: "Queue", item_key: `act:queue:${key}`, hint: "action" },
  { title: "Start Radio", item_key: `act:radio:${key}`, hint: "action" },
];

// Title each executed queue action lands under, so the return can read it back.
const LANDED_TITLE: Record<string, string> = {
  live: "New Girl (Live at The Crocodile)",
  studio: "New Girl",
};

let lastBrowse = "root";
let lastInput = "";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      // Album-anchored search includes the album name; track search does not.
      if (/pretend to fall/i.test(lastInput)) return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
      if (/ghost sessions/i.test(lastInput)) return [{ title: "Albums", item_key: "cat:album:ghost", hint: "list" }];
      return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
    case "cat:track":
      // The studio cut is outranked OFF the list - Roon surfaces only the live
      // sibling. This is the exact condition behind the production defect.
      return [{ title: "New Girl (Live at The Crocodile)", item_key: "trk:live", hint: "list", subtitle: "The Long Winters" }];
    case "cat:album":
      return [{ title: "When I Pretend To Fall", item_key: "alb:wipf", hint: "list", subtitle: "The Long Winters" }];
    case "cat:album:ghost":
      // No studio album exists - album search yields nothing to anchor on.
      return [];
    case "alb:wipf":
      return [
        { title: "Play Album", item_key: "act:play:album", hint: "action" },
        { title: "1. Blanket Hog", item_key: "alb:wipf:t1", hint: "list", subtitle: "The Long Winters" },
        { title: "4. New Girl", item_key: "alb:wipf:studio", hint: "list", subtitle: "The Long Winters" },
        { title: "5. Bride And Bridle", item_key: "alb:wipf:t5", hint: "list", subtitle: "The Long Winters" },
      ];
    case "trk:live":
      return actions("live");
    case "alb:wipf:studio":
      return actions("studio");
    default:
      return [];
  }
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
      world.executed.push(key);
      const verb = key.split(":")[1];
      const which = key.split(":")[2];
      if ((verb === "queue" || verb === "next") && LANDED_TITLE[which]) {
        world.queue.push(qitem(LANDED_TITLE[which], "The Long Winters"));
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActionList = key === "trk:live" || key === "alb:wipf:studio";
    cb(false, { action: "list", list: { title: key, count: loadItems().length, level: 1, hint: isActionList ? "action_list" : undefined } });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = loadItems();
    cb(false, { items, offset: 0, list: { title: lastBrowse, count: items.length, level: 0 } });
  },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
    getTransport: vi.fn(() => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() })),
    findZoneOrThrow: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1" })),
    findZone: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1", now_playing: { three_line: { line1: "New Girl" } } })),
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
    // The batch path cancels any armed deferral (deferredPlayer.cancel -> off).
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

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

function reset() {
  world.queue = [];
  world.executed = [];
  world.nextId = 7000;
  lastBrowse = "root";
  lastInput = "";
}

describe("queue_by_id exact-recording pinning (BUG A)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("does NOT queue a live sibling when the track search surfaces only the live take", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "48916424" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    // The live row must be rejected; the studio cut queued via the album anchor.
    expect(world.executed).toContain("act:queue:studio");
    expect(world.executed.some((k) => k.includes(":live"))).toBe(false);
    expect(json.matched.resolved_via).toBe("album-anchored");
  });

  it("reads back the ACTUAL queued title (not just the intended one)", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_by_id", { track_id: "48916424" });
    // The return reflects what landed in the queue, and it is the studio cut.
    expect(json.queued_title).toBe("New Girl");
    expect(/live/i.test(json.queued_title)).toBe(false);
  });

  it("fails honestly when the only recording available is a live take (queues nothing)", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "999" });
    // No studio recording exists - must NOT substitute the live take.
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(world.executed.some((k) => k.startsWith("act:queue") || k.startsWith("act:play"))).toBe(false);
  });

  it("queue_tracks pins the studio recording for the same id", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_tracks", { track_ids: ["48916424"], when: "queue" });
    expect(world.executed.some((k) => k.includes(":live"))).toBe(false);
    expect(world.executed).toContain("act:queue:studio");
    expect(json.tracks[0].title).toBe("New Girl");
  });
});
