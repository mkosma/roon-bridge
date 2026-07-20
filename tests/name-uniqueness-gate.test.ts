/**
 * The name-based uniqueness gate on the Roon-browse acting path (searchAndPlay).
 *
 * Replaces the deleted confidence gate (DEFAULT_MIN_CONFIDENCE /
 * REPLACE_MIN_CONFIDENCE): a name play now resolves to the SINGLE exact match on
 * the normalized key, or errors with candidates and mutates nothing - never a
 * fuzzy best-match guess, no threshold. Exercised through play_artist, the tool
 * that still resolves over the Roon substrate (artist has no stable provider id
 * to funnel through the *_by_id gateway; album/track/playlist do, and are
 * covered by deferred-play / album-by-id / play-by-id).
 *
 * Also re-asserts the false-success guard (#4) on this path: a Play Now that
 * Roon acks while now-playing never changes must NOT read as success.
 *
 * The pure selection guarantee (acceptance A-F) lives in resolve-unique.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { Zone } from "node-roon-api-transport";

const world = {
  artistRows: [{ title: "The National", key: "artist:national", subtitle: "" }] as { title: string; key: string; subtitle?: string }[],
  nowPlaying: "Prior Track" as string | null,
  flipOnPlay: true,
  state: "playing" as Zone["state"],
  executed: [] as string[],
};

let lastBrowse = "root";

function loadItems(): BrowseItem[] {
  if (lastBrowse === "root") return [{ title: "Artists", item_key: "cat:artist", hint: "list" }];
  if (lastBrowse === "cat:artist") {
    return world.artistRows.map((r) => ({ title: r.title, item_key: r.key, hint: "list", subtitle: r.subtitle }));
  }
  if (lastBrowse.startsWith("artist:")) {
    return [{ title: "Play Now", item_key: "act:play", hint: "action" }];
  }
  return [];
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
      if (key === "act:play" && world.flipOnPlay) world.nowPlaying = "New Artist Opener";
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key.startsWith("artist:");
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

function zoneObj(): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: world.state,
    outputs: [{ output_id: "o", zone_id: "zone-1", display_name: "WiiM", state: world.state, volume: { type: "number", value: 48, min: 0, max: 100, is_muted: false } }],
    now_playing: world.nowPlaying
      ? {
          one_line: { line1: world.nowPlaying },
          two_line: { line1: world.nowPlaying, line2: "Artist" },
          three_line: { line1: world.nowPlaying, line2: "Artist" },
          length: 200,
          seek_position: 3,
        }
      : undefined,
  } as unknown as Zone;
}

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: () => mockBrowse,
    getTransport: () => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() }),
    findZone: () => zoneObj(),
    findZoneOrThrow: () => zoneObj(),
    getQueueSnapshot: async () => [],
    on: () => {},
    off: () => {},
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
  world.artistRows = [{ title: "The National", key: "artist:national", subtitle: "" }];
  world.nowPlaying = "Prior Track";
  world.flipOnPlay = true;
  world.state = "playing";
  world.executed = [];
  lastBrowse = "root";
  Object.assign(world, partial);
}

describe("name uniqueness gate (Roon acting path): exact-one-or-error", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("plays the ONE exact match (immediate), verified by the now-playing flip", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_artist", { artist: "The National", immediate: true });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Now playing:/);
    expect(world.executed).toContain("act:play");
  });

  it("refuses when NO row is an exact match (not_found), mutates nothing", async () => {
    reset({ artistRows: [{ title: "Some Other Artist", key: "artist:other" }] });
    const server = buildServer();
    const { isError, text } = await call(server, "play_artist", { artist: "The National", immediate: true });
    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("not_found");
    expect(world.executed).toHaveLength(0);
  });

  it("refuses when TWO rows are exactly the named artist (ambiguous), mutates nothing", async () => {
    reset({
      artistRows: [
        { title: "The National", key: "artist:a" },
        { title: "The National", key: "artist:b" },
      ],
    });
    const server = buildServer();
    const { isError, text } = await call(server, "play_artist", { artist: "The National", immediate: true });
    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("ambiguous");
    expect(json.candidates.length).toBe(2);
    expect(world.executed).toHaveLength(0);
  });

  it("a near-miss does not create ambiguity: one exact among fuzzy neighbors still plays", async () => {
    reset({
      artistRows: [
        { title: "The Nationals", key: "artist:near1" },
        { title: "The National", key: "artist:exact" },
        { title: "National Trust", key: "artist:near2" },
      ],
    });
    const server = buildServer();
    const { isError } = await call(server, "play_artist", { artist: "The National", immediate: true });
    expect(isError).toBe(false);
    expect(world.executed).toContain("act:play");
  });
});

describe("false-success guard (#4) survives on the Roon acting path", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("a Play Now that never flips now-playing reports NOT verified, isError, warning-first", async () => {
    reset({ flipOnPlay: false });
    const server = buildServer();
    const { isError, text } = await call(server, "play_artist", { artist: "The National", immediate: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/^WARNING - not verified/);
    expect(text).toMatch(/did NOT change/);
    expect(world.executed).toContain("act:play");
    expect(text).not.toMatch(/^Now playing:/);
  });
});
