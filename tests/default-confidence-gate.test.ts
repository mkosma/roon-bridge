/**
 * prompts/03, item 3: EVERY name-based play/queue tool is gated at
 * DEFAULT_MIN_CONFIDENCE (0.75), not just a deliberate interrupt/replace
 * stomp (REPLACE_MIN_CONFIDENCE, 0.9). Before this, a non-interrupting
 * add_to_queue or a play into a silent zone could land ANY confidence match -
 * only annotated with a "loose match" note, never refused. This is the
 * album/track-name analog of the "Gas instead of Spoon" defect for the safe
 * (non-stomp) paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { Zone } from "node-roon-api-transport";

const world = {
  trackTitle: "Some Track",
  nowPlaying: null as string | null,
  state: "stopped" as Zone["state"],
  executed: [] as string[],
  queue: [] as { queue_item_id: number }[],
  nextId: 5000,
};

let lastBrowse = "root";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
    case "cat:track":
      return [{ title: world.trackTitle, item_key: "match:track", hint: "list", subtitle: "An Artist" }];
    case "match:track":
      return [
        { title: "Play Now", item_key: "act:play", hint: "action" },
        { title: "Queue", item_key: "act:queue", hint: "action" },
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
      world.executed.push(key);
      if (key === "act:play") world.nowPlaying = "New Track";
      if (key === "act:queue") world.queue.push({ queue_item_id: world.nextId++ });
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key === "match:track";
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
    getQueueSnapshot: async () => world.queue.slice(),
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
  world.trackTitle = "Some Track";
  world.nowPlaying = null;
  world.state = "stopped";
  world.executed = [];
  world.queue = [];
  world.nextId = 5000;
  lastBrowse = "root";
  Object.assign(world, partial);
}

describe("default confidence gate (#not just the stomp): add_to_queue never rides a loose match", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("refuses a sub-75% match and mutates nothing - no immediate/replace involved at all", async () => {
    // The only track Roon returns shares no words with the query, so
    // confidence is near 0 - below the new 0.75 default floor.
    reset({ trackTitle: "Totally Unrelated Recording" });
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", {
      query: "Kill The Moonlight Spoon",
      category: "track",
    });

    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("low_confidence_replace");
    expect(Array.isArray(json.candidates)).toBe(true);
    expect(json.candidates.length).toBeGreaterThan(0);
    expect(world.executed).toHaveLength(0);
  });

  it("proceeds when the match is confident (>=75%), well below the 90% stomp bar", async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "add_to_queue", { query: "Some Track", category: "track" });
    expect(isError).toBe(false);
    expect(text).not.toMatch(/low_confidence_replace/);
    expect(world.executed).toContain("act:queue");
  });
});

describe("default confidence gate applies to a fuzzy play into silence too (no interrupt involved)", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it('play_track (no immediate, nothing playing so it plays now) refuses a sub-75% match', async () => {
    reset({ trackTitle: "Totally Unrelated Recording", state: "stopped", nowPlaying: null });
    const server = buildServer();
    const { isError, text } = await call(server, "play_track", { track: "Kill The Moonlight Spoon" });
    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("low_confidence_replace");
    expect(world.executed).toHaveLength(0);
  });
});
