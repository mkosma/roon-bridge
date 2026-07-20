/**
 * Regression test for the live 2026-07-20 defect: play_album_by_id /
 * queue_album_by_id reported success (or a "not verified" warning) while the
 * album never landed in the zone, on a genuinely unambiguous resolve
 * (Spoon - "Kill the Moonlight", provider id eavjov9j20toa, tied:1).
 *
 * ROOT CAUSE: browsing an Albums-category row does not always land on the
 * quick action popup (leaf items, hint:"action", clicking one executes
 * immediately - what the sibling album-by-id.test.ts mock models). It can
 * instead land on the album's full detail page, whose only action-shaped
 * entry is a wrapper like "Play Album". Executing that wrapper item_key
 * returns `action: "list"` - a nested confirm/choice submenu (Play Now /
 * Queue / Add Next) - NOT the actual play/queue effect. The old
 * executeAlbumIdentity treated `exec.error == null` as "done" and moved
 * straight to verification, so it silently opened the submenu, never clicked
 * the real leaf action inside it, then correctly observed nothing had
 * changed: a clean, residue-free silent no-op. This fixture reproduces
 * exactly that shape and asserts the album actually lands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderAlbum } from "../src/providers/types.js";

const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  nextId: 5000,
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

// The exact live fixture from the 2026-07-20 ticket.
const ALBUMS: Record<string, ProviderAlbum> = {
  eavjov9j20toa: {
    provider: "qobuz", id: "eavjov9j20toa", title: "Kill the Moonlight", artist: "Spoon",
    trackCount: 12, year: 2002, explicit: false, hires: true,
  },
};

let lastBrowse = "root";
let submenuOpened = false;

// Unambiguous resolve (single candidate, tied:1) that lands on the album's
// FULL DETAIL PAGE rather than the quick popup: the only action-shaped row is
// the "Play Album" wrapper, which returns a nested submenu on execute.
function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
    case "cat:album":
      return [{ title: "Kill the Moonlight", item_key: "alb:km", hint: "list", subtitle: "Spoon" }];
    case "alb:km":
      // Full album detail page: track rows + a single wrapper action. Its own
      // hint is "action_list" (a container to drill into), NOT "action" - the
      // real live trace confirmed this (2026-07-20). Getting this wrong is
      // exactly what let the old mock hide the double-fire bug below.
      return [
        { title: "Play Album", item_key: "act:playalbum", hint: "action_list" },
        { title: "1. Small Stakes", item_key: "trk:1", hint: "list" },
        { title: "2. The Way We Get By", item_key: "trk:2", hint: "list" },
      ];
    case "submenu:playalbum":
      return [
        { title: "Play Now", item_key: "act:play:now", hint: "action" },
        { title: "Add Next", item_key: "act:play:next", hint: "action" },
        { title: "Queue", item_key: "act:play:queue", hint: "action" },
      ];
    default:
      return [];
  }
}

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: BrowseResult) => void) => {
    if (opts.pop_all) {
      lastBrowse = "root";
      submenuOpened = false;
      cb(false, { action: "list", list: { title: "Search", count: 1, level: 0 } });
      return;
    }
    const key = String(opts.item_key ?? "");

    // Clicking the "Play Album" wrapper: not a direct execute, a submenu.
    if (key === "act:playalbum") {
      world.executed.push(key);
      submenuOpened = true;
      lastBrowse = "submenu:playalbum";
      cb(false, { action: "list", list: { title: "Play Album", count: 3, level: 2, hint: "action_list" } });
      return;
    }

    // Leaf actions from inside the submenu. These are TRUE terminal actions
    // (hint:"action") - but real Roon's response after firing one is NOT a
    // clean {action:"none"}; it echoes back a content list (the album page
    // again), exactly like a genuine unclicked submenu would look. This is
    // the live 2026-07-20 double-fire trap: a loop that keeps drilling on any
    // list-shaped response (rather than stopping once a hint:"action" item
    // has fired) re-clicks this same leaf a second time.
    if (key.startsWith("act:play:")) {
      world.executed.push(key);
      if (key === "act:play:queue" || key === "act:play:next") {
        // A real album-level Queue/Add-Next action lands the WHOLE album, not
        // one track - match ALBUMS[...].trackCount so Fix 2's completeness
        // check (added on the sibling branch) sees a true full landing here.
        for (let i = 0; i < ALBUMS["eavjov9j20toa"].trackCount; i++) {
          world.queue.push(qitem(`${i + 1}. Track ${i + 1}`));
        }
      }
      if (key === "act:play:now") {
        world.nowPlaying = "1. Small Stakes";
        world.nowAlbum = "Kill the Moonlight";
      }
      lastBrowse = "alb:km";
      cb(false, { action: "list", list: { title: "Kill the Moonlight", count: 3, level: 3 } });
      return;
    }

    lastBrowse = key;
    const isActionList = false; // this fixture never reports action_list at the album-row level
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
    findZoneOrThrow: vi.fn(() => ({ zone_id: "zone-1", display_name: "MacBook" })),
    findZone: vi.fn(() => ({
      zone_id: "zone-1",
      display_name: "MacBook",
      state: world.nowPlaying ? "playing" : "stopped",
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
      searchAlbums: async () => [ALBUMS["eavjov9j20toa"]],
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
  world.nextId = 5000;
  world.nowPlaying = null;
  world.nowAlbum = null;
  lastBrowse = "root";
  submenuOpened = false;
}

describe("play_album_by_id / queue_album_by_id (album-page wrapper action requires a submenu click)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("play_album_by_id on an idle zone actually lands the album (Kill the Moonlight fixture)", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "play_album_by_id", { album_id: "eavjov9j20toa", when: "replace" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(json.matched.title).toBe("Kill the Moonlight");
    expect(json.matched.unambiguous).toBe(true);
    // The wrapper was opened AND the real leaf action inside the submenu fired.
    expect(submenuOpened).toBe(true);
    expect(world.executed).toContain("act:playalbum");
    expect(world.executed).toContain("act:play:now");
    expect(world.nowPlaying).toBe("1. Small Stakes");
    // Double-fire regression (live 2026-07-20): the leaf action's post-click
    // list-shaped echo must NOT be mistaken for a further submenu to drill.
    expect(world.executed.filter((k) => k === "act:play:now").length).toBe(1);
  });

  it("queue_album_by_id on the same fixture actually enqueues the album ONCE, not twice", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_album_by_id", { album_id: "eavjov9j20toa" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(submenuOpened).toBe(true);
    expect(world.executed).toContain("act:playalbum");
    expect(world.executed).toContain("act:play:queue");
    // Double-fire regression: exactly one Queue click, exactly one album's
    // worth of tracks - not two (the live bug added the album twice, 24 not
    // 12, because the post-click echo looked like an unclicked submenu).
    expect(world.executed.filter((k) => k === "act:play:queue").length).toBe(1);
    expect(world.queue.length).toBe(ALBUMS["eavjov9j20toa"].trackCount);
  });
});
