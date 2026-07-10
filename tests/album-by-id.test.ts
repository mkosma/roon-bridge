/**
 * End-to-end tests for play_album_by_id / queue_album_by_id / search_albums
 * against a mocked Roon browse + mocked music provider (prompts/03, item 2).
 * Headline case: Roon's fuzzy Albums search returns a wrong-artist decoy
 * ranked above the real album (the "Gas instead of Spoon" mechanism at the
 * album level) - play_album_by_id must pin the EXACT album by provider ID and
 * never touch the decoy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderAlbum } from "../src/providers/types.js";

const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  nextId: 4000,
  nowPlaying: null as string | null,
  nowAlbum: null as string | null,
};

function qitem(title: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: "" },
    three_line: { line1: title, line2: "", line3: "" },
  };
}

const ALBUMS: Record<string, ProviderAlbum> = {
  "x16j3kp3b4g2b": {
    provider: "qobuz", id: "x16j3kp3b4g2b", title: "Trouble Will Find Me", artist: "The National",
    trackCount: 13, year: 2013, explicit: true, hires: true,
  },
};

let lastBrowse = "root";
let lastInput = "";

// Roon's fuzzy Albums search for "The National Trouble Will Find Me" returns
// a wrong-artist decoy FIRST (a cover band using the same title) and the real
// album second - modeling the low-confidence top-1 defect at the album level.
function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
    case "cat:album":
      return [
        { title: "Trouble Will Find Me", item_key: "alb:decoy", hint: "list", subtitle: "American Analog Set" },
        { title: "Trouble Will Find Me", item_key: "alb:real", hint: "list", subtitle: "The National" },
      ];
    case "alb:real":
      return [
        { title: "Play Now", item_key: "act:play:real", hint: "action" },
        { title: "Add Next", item_key: "act:next:real", hint: "action" },
        { title: "Queue", item_key: "act:queue:real", hint: "action" },
      ];
    case "alb:decoy":
      return [{ title: "Play Now", item_key: "act:play:decoy", hint: "action" }];
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
        world.queue.push(qitem("1. All the Wine"));
      }
      if (key.startsWith("act:play:real")) {
        world.nowPlaying = "1. All the Wine";
        world.nowAlbum = "Trouble Will Find Me";
      }
      if (key.startsWith("act:play:decoy")) {
        world.nowPlaying = "Cover Track";
        world.nowAlbum = "Trouble Will Find Me";
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActionList = key.startsWith("alb:");
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
    findZone: vi.fn(() => ({
      zone_id: "zone-1",
      display_name: "WiiM + 1",
      state: "playing",
      now_playing: world.nowPlaying ? { three_line: { line1: world.nowPlaying, line3: world.nowAlbum } } : undefined,
    })),
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
  },
}));

vi.mock("../src/providers/bootstrap.js", () => ({
  initProviders: () => ({
    get: () => ({
      getAlbum: async (id: string) => {
        const a = ALBUMS[id];
        if (!a) throw new Error(`unknown album ${id}`);
        return a;
      },
      searchAlbums: async () => [ALBUMS["x16j3kp3b4g2b"]],
    }),
  }),
}));

const { registerAlbumByIdTools } = await import("../src/tools/album-by-id.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerAlbumByIdTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, text, json: JSON.parse(text.slice(text.indexOf("{"))) };
}

function reset() {
  world.queue = [];
  world.executed = [];
  world.nextId = 4000;
  world.nowPlaying = null;
  world.nowAlbum = null;
  lastBrowse = "root";
  lastInput = "";
}

describe("play_album_by_id / queue_album_by_id (exact-pinned, decoy present)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("plays the EXACT album by ID, never touching the wrong-artist decoy ranked first by Roon", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "play_album_by_id", { album_id: "x16j3kp3b4g2b", when: "replace" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.matched.title).toBe("Trouble Will Find Me");
    expect(json.matched.unambiguous).toBe(true);
    expect(world.executed).toContain("act:play:real");
    expect(world.executed).not.toContain("act:play:decoy");
  });

  it("queues the EXACT album by ID, verified by queue growth", async () => {
    const server = buildServer();
    const { json } = await call(server, "queue_album_by_id", { album_id: "x16j3kp3b4g2b" });
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(world.executed).toContain("act:queue:real");
  });

  it("play_album_by_id SAFE DEFAULT does not cut the current track (Add Next)", async () => {
    const server = buildServer();
    const { json } = await call(server, "play_album_by_id", { album_id: "x16j3kp3b4g2b" });
    expect(json.ok).toBe(true);
    expect(json.when).toBe("next");
    expect(world.executed).toContain("act:next:real");
    expect(world.executed).not.toContain("act:play:real");
  });

  it("a nonexistent album ID errors cleanly with no fuzzy fallback (no browse call at all)", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "play_album_by_id", { album_id: "does-not-exist", when: "replace" });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("provider_lookup_failed");
    expect(world.executed).toEqual([]);
  });
});

describe("search_albums", () => {
  it("lists provider album candidates without touching Roon", async () => {
    const server = buildServer();
    const { isError, text } = await call2text(server, "search_albums", { query: "Trouble Will Find Me" });
    expect(isError).toBe(false);
    expect(text).toContain("ID: x16j3kp3b4g2b");
    expect(text).toContain("The National");
    expect(world.executed).toEqual([]);
  });
});

async function call2text(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, text };
}
