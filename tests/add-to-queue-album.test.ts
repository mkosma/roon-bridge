/**
 * BUG C regression: add_to_queue category='album' must add the WHOLE album or
 * fail honestly with the count it added - never report success when only one
 * track of a multi-track album landed.
 *
 * The live failure (2026-06-20): add_to_queue category='album' for "The Long
 * Winters When I Pretend To Fall" added only ONE track ("Blue Diamonds") instead
 * of the ~11-track album, while the same call worked fully for three other albums
 * the same minute. The generic add path verifies only that the queue grew by at
 * least one item, so a partial/under-committed album browse reads as success.
 *
 * The mock models an album whose Queue action commits an incomplete set (the
 * under-add) versus the full album (the clean case). A correct add reads the
 * album's real track count, waits for the queue to settle, and reports the
 * actual tracks_added.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";

const ALBUM_TITLES = [
  "Blue Diamonds", "Prom Night At Hater High", "Stupid", "Shapes", "Bride And Bridle",
  "New Girl", "It'll Be A Breeze", "Clouds", "Nora", "Pushover", "When I Pretend To Fall",
];

const world = { commitCount: 11, queue: [] as QueueItem[], executed: [] as string[], nextId: 5000 };

function qitem(title: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: "The Long Winters" },
    three_line: { line1: title, line2: "The Long Winters" },
  };
}

let lastBrowse = "root";

// The album detail page: a Play/Queue action bar followed by the numbered track
// listing (so the album's real length is readable from its own page).
function albumPage(): BrowseItem[] {
  return [
    { title: "Play Now", item_key: "act:play:album", hint: "action" },
    { title: "Queue", item_key: "act:queue:album", hint: "action" },
    { title: "Start Radio", item_key: "act:radio:album", hint: "action" },
    ...ALBUM_TITLES.map((t, i) => ({ title: `${i + 1}. ${t}`, item_key: `trk:${i}`, hint: "list", subtitle: "The Long Winters" } as BrowseItem)),
  ];
}

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
    case "cat:album":
      return [{ title: "When I Pretend To Fall", item_key: "alb:wipf", hint: "list", subtitle: "The Long Winters" }];
    case "alb:wipf":
      return albumPage();
    default:
      return [];
  }
}

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: BrowseResult) => void) => {
    if (opts.pop_all) {
      lastBrowse = "root";
      cb(false, { action: "list", list: { title: "Search", count: 1, level: 0 } });
      return;
    }
    const key = String(opts.item_key ?? "");
    if (key.startsWith("act:")) {
      world.executed.push(key);
      if (key === "act:queue:album") {
        // The album Queue action commits commitCount tracks (full or under-add).
        for (let i = 0; i < world.commitCount; i++) world.queue.push(qitem(ALBUM_TITLES[i]));
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActionList = key === "alb:wipf";
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
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
  },
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

function reset(partial: Partial<typeof world> = {}) {
  world.commitCount = 11;
  world.queue = [];
  world.executed = [];
  world.nextId = 5000;
  lastBrowse = "root";
  Object.assign(world, partial);
}

describe("add_to_queue category=album (BUG C)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("reports an honest under-add when the album Queue commits only one track", async () => {
    reset({ commitCount: 1 }); // the live under-add: 1 of 11 landed
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", { query: "The Long Winters When I Pretend To Fall", category: "album" });
    const json = JSON.parse(text);
    // Must NOT claim success on a 1-of-11 add.
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.tracks_added).toBe(1);
    expect(json.tracks_expected).toBe(11);
  });

  it("succeeds and reports the full count when the whole album lands", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", { query: "The Long Winters When I Pretend To Fall", category: "album" });
    const json = JSON.parse(text);
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.tracks_added).toBe(11);
    expect(json.tracks_expected).toBe(11);
    expect(json.album).toContain("When I Pretend To Fall");
  });
});
