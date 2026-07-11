/**
 * Tests for play_playlist shuffle=true (native Roon Shuffle action).
 *
 * play_playlist normally fires "Play Now", which loads the queue in playlist
 * order and ignores the zone shuffle flag. shuffle=true must instead execute
 * Roon's native "Shuffle" action item (random first track, one action, no extra
 * transport events). When the matched item exposes no Shuffle action, the tool
 * must fall back to Play Now and SAY SO - never assert "shuffled" when it wasn't.
 *
 * The mock models: search -> Playlists category -> playlist match -> action list
 * (with or without a Shuffle action), and records which action item executed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";

const world = {
  hasShuffleAction: true,
  // When true, level one (the search-result popup) has NO Shuffle; Shuffle lives
  // one level deeper inside a navigable "Play" submenu - the real Roon playlist
  // shape this navigate-into-item fix targets.
  shuffleNestedInPlaySubmenu: false,
  executed: [] as string[],
  // The zone's current now-playing title; a Play Now / Shuffle flips it, so the
  // tool's play-path verification can observe that playback actually changed.
  nowPlaying: "Prior Track",
};

function makeZone() {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: "playing",
    now_playing: {
      one_line: { line1: world.nowPlaying },
      two_line: { line1: world.nowPlaying, line2: "Artist" },
      three_line: { line1: world.nowPlaying, line2: "Artist" },
      length: 200,
      seek_position: 0,
    },
  };
}

// The playlist's action list. Includes a native Shuffle action unless the
// world says this item exposes none.
function playlistActions(): BrowseItem[] {
  if (world.shuffleNestedInPlaySubmenu) {
    // Level one: a navigable "Play" submenu + flat actions, NO Shuffle here.
    return [
      { title: "Play", item_key: "sub:play", hint: "action_list" },
      { title: "Queue", item_key: "act:queue", hint: "action" },
      { title: "Add Next", item_key: "act:addnext", hint: "action" },
      { title: "Start Radio", item_key: "act:radio", hint: "action" },
    ];
  }
  const actions: BrowseItem[] = [
    { title: "Play Now", item_key: "act:play", hint: "action" },
    { title: "Queue", item_key: "act:queue", hint: "action" },
    { title: "Start Radio", item_key: "act:radio", hint: "action" },
  ];
  if (world.hasShuffleAction) {
    // Roon orders Shuffle right after Play Now in the real menu.
    actions.splice(1, 0, { title: "Shuffle", item_key: "act:shuffle", hint: "action" });
  }
  return actions;
}

let lastBrowse = "root";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Playlists", item_key: "cat:playlist", hint: "list" }];
    case "cat:playlist":
      return [{ title: "Discovered", item_key: "match:playlist", hint: "list", subtitle: "" }];
    case "match:playlist":
      return playlistActions();
    case "sub:play":
      // The opened "Play" submenu: Play Now / Shuffle / Play From Here.
      return [
        { title: "Play Now", item_key: "act:play", hint: "action" },
        { title: "Shuffle", item_key: "act:shuffle", hint: "action" },
        { title: "Play From Here", item_key: "act:fromhere", hint: "action" },
      ];
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
      // Action execution: record which one fired, report plain success.
      world.executed.push(key);
      // Play Now / Shuffle actually start playback: flip now-playing so the
      // tool's play-path verification observes the change.
      if (key === "act:play" || key === "act:shuffle" || key === "act:fromhere") {
        world.nowPlaying = "Discovered Opener";
      }
      cb(false, { action: "none" });
      return;
    }
    // Navigation into a list node. The action list is hinted action_list.
    lastBrowse = key;
    const isActionList = key === "match:playlist" || key === "sub:play";
    cb(false, {
      action: "list",
      list: { title: key, count: loadItems().length, level: 1, hint: isActionList ? "action_list" : undefined },
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
    findZone: vi.fn(() => makeZone()),
    getQueueSnapshot: vi.fn(async () => []),
    // play_playlist now routes through the deferral machinery (immediate gate),
    // which cancels any armed deferral via source.on/off.
    on: vi.fn(),
    off: vi.fn(),
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
  world.hasShuffleAction = true;
  world.shuffleNestedInPlaySubmenu = false;
  world.executed = [];
  world.nowPlaying = "Prior Track";
  lastBrowse = "root";
  Object.assign(world, partial);
}

describe("play_playlist shuffle", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("shuffle:true executes the native Shuffle action when present", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
      shuffle: true,
    });

    expect(isError).toBe(false);
    // The Shuffle action fired, NOT Play Now.
    expect(world.executed).toContain("act:shuffle");
    expect(world.executed).not.toContain("act:play");
    expect(text).toMatch(/^Shuffling:/);
    expect(text).not.toMatch(/shuffle unavailable/i);
  });

  it("shuffle:true navigates INTO the item to find Shuffle nested in a Play submenu", async () => {
    reset({ shuffleNestedInPlaySubmenu: true });
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
      shuffle: true,
    });

    expect(isError).toBe(false);
    // Level one had no Shuffle; the fix opened the "Play" submenu and fired the
    // nested Shuffle action - never Play Now, never the honest-fallback note.
    expect(world.executed).toContain("act:shuffle");
    expect(world.executed).not.toContain("act:play");
    expect(text).toMatch(/^Shuffling:/);
    expect(text).not.toMatch(/shuffle unavailable/i);
  });

  it("shuffle:false does NOT navigate into the item even when Shuffle is nested deeper", async () => {
    reset({ shuffleNestedInPlaySubmenu: true });
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
      shuffle: false,
    });

    expect(isError).toBe(false);
    // Default path resolves Play at level one (the "Play" submenu node) and
    // never drills for Shuffle - no extra round-trips on the non-shuffle path.
    expect(world.executed).not.toContain("act:shuffle");
    expect(text).toMatch(/^Now playing:/);
  });

  it("shuffle:true falls back to Play Now and SAYS SO when no Shuffle action exists", async () => {
    reset({ hasShuffleAction: false });
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
      shuffle: true,
    });

    expect(isError).toBe(false);
    // No native Shuffle -> Play Now fired, and the text is honest about it.
    expect(world.executed).toContain("act:play");
    expect(world.executed).not.toContain("act:shuffle");
    expect(text).toMatch(/^Now playing:/);
    expect(text).toMatch(/shuffle unavailable/i);
  });

  it("shuffle:true probing for a deeper Shuffle never fires the leaf Play Now/Queue/Start Radio actions", async () => {
    // Level one exposes only leaf `action` rows (no Shuffle, no navigable
    // submenu): Play Now, Queue, Start Radio. findShuffleDeeper must not open
    // any of them while hunting - opening a leaf action EXECUTES it in Roon,
    // so probing them would fire Queue/Start Radio as side effects, and would
    // fire Play Now early (from the probe, not Step 7's deliberate execute).
    reset({ hasShuffleAction: false });
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
      shuffle: true,
    });

    expect(isError).toBe(false);
    expect(world.executed).not.toContain("act:queue");
    expect(world.executed).not.toContain("act:radio");
    // Play Now fires exactly once - from Step 7's fallback, not a probe.
    expect(world.executed.filter((k) => k === "act:play")).toHaveLength(1);
    expect(text).toMatch(/shuffle unavailable/i);
  });

  it("shuffle omitted behaves exactly as before: Play Now, no shuffle, no shuffle note", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
    });

    expect(isError).toBe(false);
    expect(world.executed).toContain("act:play");
    expect(world.executed).not.toContain("act:shuffle");
    expect(text).toMatch(/^Now playing:/);
    expect(text).not.toMatch(/shuffle/i);
  });

  it("shuffle:false behaves exactly as before: Play Now, never the Shuffle action", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_playlist", {
      playlist: "Discovered",
      shuffle: false,
    });

    expect(isError).toBe(false);
    expect(world.executed).toContain("act:play");
    expect(world.executed).not.toContain("act:shuffle");
    expect(text).toMatch(/^Now playing:/);
  });
});
