/**
 * End-to-end tests for queue_by_id / play_by_id against a mocked Roon browse +
 * mocked music provider. Models the headline case: two same-titled studio
 * recordings of "Puppets" by Atmosphere on different albums. queue_by_id must
 * resolve the provider ID to the EXACT album's track and queue THAT one, with no
 * ambiguity - the case fuzzy name search and queue_version cannot handle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  nextId: 3000,
  // The zone's current now-playing title, read by findZone. Defaults to the
  // track these tests play ("Puppets") so a Play Now verifies; a test can set it
  // to a non-matching title to model an acked play that never flips.
  nowPlaying: "Puppets" as string | null,
};

function qitem(title: string, artist: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

// Two provider tracks: both "Puppets" / Atmosphere, different albums.
const TRACKS: Record<string, ProviderTrack> = {
  "95206613": {
    provider: "qobuz", id: "95206613", title: "Puppets", artist: "Atmosphere",
    album: "When Life Gives You Lemons, You Paint That Shit Gold", trackNumber: 2, year: 2008, explicit: true,
  },
  "337073075": {
    provider: "qobuz", id: "337073075", title: "Puppets", artist: "Atmosphere",
    album: "Triple X Years In The Game", trackNumber: 17, year: 2025, explicit: true,
  },
};

const actions = (key: string): BrowseItem[] => [
  { title: "Play Now", item_key: `act:play:${key}`, hint: "action" },
  { title: "Add Next", item_key: `act:next:${key}`, hint: "action" },
  { title: "Queue", item_key: `act:queue:${key}`, hint: "action" },
  { title: "Start Radio", item_key: `act:radio:${key}`, hint: "action" },
];

let lastBrowse = "root";
let lastInput = "";

// The mock browse models album-anchored resolution: a track search for
// "Atmosphere Puppets" returns BOTH same-titled rows (a tie -> forces the
// album-anchored path); an album search resolves the named album, whose track
// listing has the unique "Puppets" row.
function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      if (/lemons|triple x/i.test(lastInput)) return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
      return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
    case "cat:track":
      // Both recordings, identical title+subtitle -> ambiguous, no album text.
      return [
        { title: "Puppets", item_key: "trk:a", hint: "list", subtitle: "Atmosphere" },
        { title: "Puppets", item_key: "trk:b", hint: "list", subtitle: "Atmosphere" },
      ];
    case "cat:album":
      if (/lemons/i.test(lastInput)) return [{ title: "When Life Gives You Lemons, You Paint That Shit Gold", item_key: "alb:lemons", hint: "list", subtitle: "Atmosphere" }];
      return [{ title: "Triple X Years In The Game", item_key: "alb:triplex", hint: "list", subtitle: "Atmosphere" }];
    case "alb:lemons":
      return [
        { title: "Play Album", item_key: "act:play:album", hint: "action" },
        { title: "1. Like the Rest of Us", item_key: "alb:lemons:t1", hint: "list", subtitle: "Atmosphere" },
        { title: "2. Puppets", item_key: "alb:lemons:puppets", hint: "list", subtitle: "Atmosphere" },
      ];
    case "alb:triplex":
      return [
        { title: "17. Puppets", item_key: "alb:triplex:puppets", hint: "list", subtitle: "Atmosphere" },
      ];
    case "alb:lemons:puppets":
      return actions("lemons-puppets");
    case "alb:triplex:puppets":
      return actions("triplex-puppets");
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
      if (key.startsWith("act:queue:") || key.startsWith("act:next:")) {
        world.queue.push(qitem("Puppets", "Atmosphere"));
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActionList = key.endsWith(":puppets") && key.startsWith("alb:");
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
    findZone: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1", state: "playing", now_playing: { three_line: { line1: world.nowPlaying } } })),
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
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
  // An unconfirmed play prepends a warning line ahead of the JSON tail; parse
  // from the first brace so both shapes decode.
  return { isError: res.isError === true, text, json: JSON.parse(text.slice(text.indexOf("{"))) };
}

function reset() {
  world.queue = [];
  world.executed = [];
  world.nextId = 3000;
  world.nowPlaying = "Puppets";
  lastBrowse = "root";
  lastInput = "";
}

describe("queue_by_id (album-anchored deterministic resolution)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("queues the EXACT 'When Life Gives You Lemons' Puppets by ID, verified by growth", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "95206613" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(json.matched.album).toContain("When Life Gives You Lemons");
    expect(json.matched.resolved_via).toBe("album-anchored");
    expect(world.executed).toContain("act:queue:lemons-puppets");
    expect(world.executed.some((k) => k.includes("triplex"))).toBe(false);
  });

  it("queues the OTHER same-titled Puppets (Triple X) by its ID", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_by_id", { track_id: "337073075" });
    expect(json.ok).toBe(true);
    expect(json.matched.album).toContain("Triple X");
    expect(world.executed).toContain("act:queue:triplex-puppets");
    expect(world.executed.some((k) => k.includes("lemons"))).toBe(false);
  });

  it("play_by_id SAFE DEFAULT (no immediate) does NOT play now - it adds after current (Add Next)", async () => {
    const server = buildServer();
    const { json } = await call(server, "play_by_id", { track_id: "95206613" });
    expect(json.ok).toBe(true);
    expect(json.when).toBe("next");
    // The Add Next action ran; the current track was NOT cut with Play Now.
    expect(world.executed).toContain("act:next:lemons-puppets");
    expect(world.executed).not.toContain("act:play:lemons-puppets");
  });

  it("play_by_id immediate:true plays now (Play Now)", async () => {
    const server = buildServer();
    const { json } = await call(server, "play_by_id", { track_id: "95206613", immediate: true });
    expect(json.ok).toBe(true);
    expect(json.when).toBe("now");
    expect(world.executed).toContain("act:play:lemons-puppets");
  });

  it("play_by_id immediate:true whose Play Now never flips now-playing is NOT success (warning-first, isError)", async () => {
    const server = buildServer();
    // The Play Now is acked and executes, but now-playing never becomes our
    // recording - the false-success class. Verification reads the flip failed.
    world.nowPlaying = "Something Else Entirely";
    const { isError, text, json } = await call(server, "play_by_id", { track_id: "95206613", immediate: true });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("play_not_verified");
    // The warning is the FIRST line of the text, not buried in the JSON.
    expect(text).toMatch(/^WARNING - not verified/);
    expect(text).toMatch(/did NOT change/);
    expect(world.executed).toContain("act:play:lemons-puppets");
  });

  it("queue_by_id SAFE DEFAULT never plays now; a stray when:'now' is downgraded, not honored", async () => {
    const server = buildServer();
    // Even if a caller passes the old interrupting value, without immediate it
    // must NOT cut the current track - it downgrades to the safe queue add.
    const { json } = await call(server, "queue_by_id", { track_id: "95206613", when: "now" });
    expect(json.ok).toBe(true);
    expect(world.executed).toContain("act:queue:lemons-puppets");
    expect(world.executed).not.toContain("act:play:lemons-puppets");
  });

  it("queue_by_id immediate:true plays now (Play Now)", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_by_id", { track_id: "95206613", immediate: true });
    expect(json.ok).toBe(true);
    expect(world.executed).toContain("act:play:lemons-puppets");
  });

  it("when='next' uses Add Next", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_by_id", { track_id: "95206613", when: "next" });
    expect(json.action).toBe("Add Next");
    expect(world.executed).toContain("act:next:lemons-puppets");
  });

  it("reports provider_lookup_failed for an unknown ID, touching nothing", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "000" });
    expect(isError).toBe(true);
    expect(json.error).toBe("provider_lookup_failed");
    expect(world.executed).toHaveLength(0);
  });
});
