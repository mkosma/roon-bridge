/**
 * Tests for add_to_queue with category="artist" (the artist-extend defect).
 *
 * A direct artist-node "Queue" action reports success but enqueues nothing, so
 * the artist path instead harvests the artist's own albums from their browse
 * detail page and enqueues them through the proven album action-list path, then
 * verifies by real queue growth (never by the query string in track titles).
 *
 * The mock below models: search -> Artists category -> artist match -> artist
 * detail page (Top Tracks / Main Albums / Similar Artists sections) -> per-album
 * action lists with a Queue action that appends tracks to a shared queue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";

const world = {
  hasAlbums: true,
  hasTopTrack: true,
  enqueueWorks: true,
  queue: [] as QueueItem[],
  executed: [] as string[],
  nextId: 1000,
};

function track(title: string, artist: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

// The artist detail page: prepended play-all action rows, then sections.
function artistPage(): BrowseItem[] {
  const page: BrowseItem[] = [
    { title: "Play Artist", item_key: "art:play", hint: "list" },
    { title: "Start Radio", item_key: "art:radio", hint: "list" },
  ];
  if (world.hasTopTrack) {
    page.push(
      { title: "Top Tracks", hint: "header" },
      { title: "The Mariner's Revenge Song", item_key: "trk:mariner", hint: "list", subtitle: "The Decemberists" },
    );
  }
  page.push({ title: "Main Albums", hint: "header" });
  if (world.hasAlbums) {
    page.push(
      { title: "Picaresque", item_key: "alb:picaresque", hint: "list", subtitle: "2005" },
      { title: "The Crane Wife", item_key: "alb:crane", hint: "list", subtitle: "2006" },
    );
  }
  page.push(
    { title: "Similar Artists", hint: "header" },
    { title: "Colin Meloy", item_key: "sim:meloy", hint: "list", subtitle: "Similar Artist" },
  );
  return page;
}

const albumActions = (key: string): BrowseItem[] => [
  { title: "Play Now", item_key: `act:play:${key}`, hint: "action" },
  { title: "Queue", item_key: `act:queue:${key}`, hint: "action" },
  { title: "Start Radio", item_key: `act:radio:${key}`, hint: "action" },
];

let lastBrowse = "root";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Artists", item_key: "cat:artist", hint: "list" }];
    case "cat:artist":
      return [{ title: "The Decemberists", item_key: "match:artist", hint: "list", subtitle: "" }];
    case "match:artist":
      return artistPage();
    case "alb:picaresque":
      return albumActions("picaresque");
    case "alb:crane":
      return albumActions("crane");
    case "trk:mariner":
      return albumActions("mariner");
    default:
      return [];
  }
}

function albumTracks(key: string): QueueItem[] {
  if (key === "act:queue:picaresque") {
    return [track("The Infanta", "The Decemberists"), track("Eli, the Barrow Boy", "The Decemberists")];
  }
  if (key === "act:queue:crane") {
    return [track("The Crane Wife 3", "The Decemberists"), track("Sons & Daughters", "The Decemberists")];
  }
  return [track("Unknown", "The Decemberists")];
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
      // Action execution: reports success; only appends if enqueue "works".
      world.executed.push(key);
      if (world.enqueueWorks && key.startsWith("act:queue:")) {
        world.queue.push(...albumTracks(key));
      }
      cb(false, { action: "none" });
      return;
    }
    // Navigation into a list node.
    lastBrowse = key;
    const isAlbum = key.startsWith("alb:");
    cb(false, {
      action: "list",
      list: { title: key, count: loadItems().length, level: 1, hint: isAlbum ? "action_list" : undefined },
    });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = loadItems();
    cb(false, { items, offset: 0, list: { title: lastBrowse, count: items.length, level: 0 } });
  },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
    getTransport: vi.fn(() => ({
      change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb(),
    })),
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
  world.hasAlbums = true;
  world.hasTopTrack = true;
  world.enqueueWorks = true;
  world.queue = [];
  world.executed = [];
  world.nextId = 1000;
  lastBrowse = "root";
  Object.assign(world, partial);
}

describe("add_to_queue category=artist", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("queues a varied stretch of the artist's albums and verifies real growth", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", {
      query: "The Decemberists",
      category: "artist",
    });

    expect(isError).toBe(false);
    // Both albums (cap = 2) enqueued via the album Queue action...
    expect(world.executed).toContain("act:queue:picaresque");
    expect(world.executed).toContain("act:queue:crane");
    // ...the top-track and similar-artist rows are NOT queued.
    expect(world.executed.some((k) => k.includes("mariner") || k.includes("meloy"))).toBe(false);
    // Real growth: 2 albums x 2 tracks = 4.
    expect(world.queue).toHaveLength(4);
    expect(text).toContain("The Decemberists");
    expect(text).toMatch(/added 4 track/);
    expect(text).toContain("Picaresque");
  });

  it("honestly fails when the action reports success but the queue does not grow", async () => {
    reset({ enqueueWorks: false });
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", {
      query: "The Decemberists",
      category: "artist",
    });

    // The action "succeeded" but nothing landed - must not claim success.
    expect(world.executed.length).toBeGreaterThan(0);
    expect(world.queue).toHaveLength(0);
    expect(isError).toBe(true);
    expect(text).toMatch(/not verified|did not grow/i);
  });

  it("does not match by the query string appearing in track titles", async () => {
    // Track titles never contain "The Decemberists"; verification must pass on
    // queue growth + artist field, which the previous title-matching verify
    // could never satisfy for an artist add.
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", {
      query: "The Decemberists",
      category: "artist",
    });
    expect(isError).toBe(false);
    expect(text).toMatch(/confirmed by The Decemberists/);
  });

  it("falls back to the artist's own tracks when no album section is present", async () => {
    reset({ hasAlbums: false, hasTopTrack: true });
    const server = buildServer();
    const { isError } = await call(server, "add_to_queue", {
      query: "The Decemberists",
      category: "artist",
    });
    expect(isError).toBe(false);
    expect(world.executed).toContain("act:queue:mariner");
    expect(world.queue.length).toBeGreaterThan(0);
    // Similar-artist rows are never queued.
    expect(world.executed.some((k) => k.includes("meloy"))).toBe(false);
  });

  it("reports honestly when the artist has no own content to queue", async () => {
    reset({ hasAlbums: false, hasTopTrack: false });
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", {
      query: "The Decemberists",
      category: "artist",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/found none of their albums/i);
    expect(world.executed).toHaveLength(0);
  });
});
