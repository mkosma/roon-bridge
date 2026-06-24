/**
 * BUG D regression: queue_by_id / queue_tracks must handle a recording that Roon
 * drills to a TWO-ITEM disambiguation - the album-context item ("X (Album)") and
 * the standalone item ("X") - instead of a direct action list.
 *
 * The live failure (2026-06-24, production :3100): provider id 121053082 =
 * "Heart Cooks Brain" [Modest Mouse / The Lonesome Crowded West]. The resolver
 * pinned the right row, but drilling it returned two NAVIGABLE children
 * ("Heart Cooks Brain (Album)" and "Heart Cooks Brain") rather than the
 * Play Now / Add Next / Queue verbs. The action-matcher found no queue action
 * among those two and returned no_action - breaking 12 of 15 album tracks. A few
 * tracks drill straight to action verbs (single-action) and queued fine, which
 * made it look intermittent though it is per-track deterministic.
 *
 * The mock models exactly that shape: drilling the resolved track row yields the
 * two-item "(Album)" disambiguation; only descending into the album-context item
 * reveals the real action list. A single-action control track drills straight to
 * verbs. Both must queue; current pre-fix code returns no_action on the two-item
 * track. The 264-test suite never reproduced this multi-action shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  nextId: 8000,
};

function qitem(title: string, artist: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

// Two tracks of The Lonesome Crowded West: one whose Roon row drills to the
// two-item "(Album)" disambiguation, and a single-action control track.
const TRACKS: Record<string, ProviderTrack> = {
  "121053082": {
    provider: "qobuz", id: "121053082", title: "Heart Cooks Brain", artist: "Modest Mouse",
    album: "The Lonesome Crowded West", trackNumber: 3, durationSec: 273, year: 1997,
  },
  "121053090": {
    provider: "qobuz", id: "121053090", title: "Doin' the Cockroach", artist: "Modest Mouse",
    album: "The Lonesome Crowded West", trackNumber: 5, durationSec: 277, year: 1997,
  },
};

const actions = (key: string): BrowseItem[] => [
  { title: "Play Now", item_key: `act:play:${key}`, hint: "action" },
  { title: "Add Next", item_key: `act:next:${key}`, hint: "action" },
  { title: "Queue", item_key: `act:queue:${key}`, hint: "action" },
  { title: "Start Radio", item_key: `act:radio:${key}`, hint: "action" },
];

const LANDED_TITLE: Record<string, string> = {
  hcb: "Heart Cooks Brain",
  cockroach: "Doin' the Cockroach",
};

let lastBrowse = "root";
let lastInput = "";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      // All resolution here is album-anchored (the search includes the album).
      if (/lonesome crowded west/i.test(lastInput)) return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
      return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
    case "cat:track":
      // Tracks search ties (same artist, identical rows) -> album-anchored.
      return [];
    case "cat:album":
      return [{ title: "The Lonesome Crowded West", item_key: "alb:lcw", hint: "list", subtitle: "Modest Mouse" }];
    case "alb:lcw":
      return [
        { title: "Play Album", item_key: "act:play:album", hint: "action" },
        { title: "3. Heart Cooks Brain", item_key: "alb:lcw:hcb", hint: "list", subtitle: "Modest Mouse" },
        { title: "5. Doin' the Cockroach", item_key: "alb:lcw:cockroach", hint: "list", subtitle: "Modest Mouse" },
      ];
    // BUG D shape: drilling the track row returns a two-item disambiguation,
    // NOT action verbs. Each child is a navigable list to its own action list.
    case "alb:lcw:hcb":
      return [
        { title: "Heart Cooks Brain (Album)", item_key: "disambig:hcb:album", hint: "list", subtitle: "Modest Mouse" },
        { title: "Heart Cooks Brain", item_key: "disambig:hcb:single", hint: "list", subtitle: "Modest Mouse" },
      ];
    case "disambig:hcb:album":
      return actions("hcb");
    case "disambig:hcb:single":
      // A different recording surface (the standalone single). Picking it would
      // also queue, but the album track must resolve to the album-context item.
      return actions("hcb-single");
    // Single-action control: drills straight to action verbs.
    case "alb:lcw:cockroach":
      return actions("cockroach");
    default:
      return [];
  }
}

const ACTION_LISTS = new Set(["disambig:hcb:album", "disambig:hcb:single", "alb:lcw:cockroach"]);

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
      if (verb === "queue" || verb === "next") {
        const landed = which === "hcb" || which === "hcb-single" ? LANDED_TITLE.hcb : LANDED_TITLE.cockroach;
        world.queue.push(qitem(landed, "Modest Mouse"));
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActionList = ACTION_LISTS.has(key);
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
    findZone: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1", now_playing: { three_line: { line1: "Heart Cooks Brain" } } })),
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
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
  world.nextId = 8000;
  lastBrowse = "root";
  lastInput = "";
}

describe("queue_by_id two-action disambiguation (BUG D)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("queues a track whose Roon row drills to the '(Album)' two-item disambiguation", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "121053082", when: "queue" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.error).toBeUndefined();
    // The album-context item is the one queued, not the standalone single.
    expect(world.executed).toContain("act:queue:hcb");
    expect(world.executed.some((k) => k.includes("hcb-single"))).toBe(false);
  });

  it("queues a single-action control track (drills straight to verbs)", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "121053090", when: "queue" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(world.executed).toContain("act:queue:cockroach");
  });

  it("queue_tracks queues a two-action track and a single-action track together", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_tracks", { track_ids: ["121053082", "121053090"], when: "queue" });

    expect(json.count_queued).toBe(2);
    expect(json.tracks.every((t: { ok: boolean }) => t.ok)).toBe(true);
    expect(world.executed).toContain("act:queue:hcb");
    expect(world.executed).toContain("act:queue:cockroach");
    expect(world.executed.some((k) => k.includes("hcb-single"))).toBe(false);
  });
});
