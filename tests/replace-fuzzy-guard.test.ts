/**
 * Acceptance tests #3 and #4 (fuzzy play path, browse.ts):
 *
 *   3. FUZZY GUARD: play_album with when:"replace" and a best match below 90%
 *      confidence returns the candidate list and mutates NOTHING - a stomp may
 *      never ride on a loose match (the "Gas instead of Spoon" rule).
 *   4. FALSE-SUCCESS: a play action Roon acks while now-playing never changes
 *      must NOT read as success (the "Now playing: The National" while Gidge
 *      kept playing failure).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { Zone } from "node-roon-api-transport";

const world = {
  albumTitle: "Some Album",
  nowPlaying: "Prior Track",
  flipOnPlay: true, // whether Play Now actually changes what is playing
  state: "playing", // zone transport state; "stopped" models a silent zone
  executed: [] as string[],
};

let lastBrowse = "root";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
    case "cat:album":
      return [{ title: world.albumTitle, item_key: "match:album", hint: "list", subtitle: "An Artist" }];
    case "match:album":
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
      if (key === "act:play" && world.flipOnPlay) world.nowPlaying = "New Album Opener";
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key === "match:album";
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
    now_playing: {
      one_line: { line1: world.nowPlaying },
      two_line: { line1: world.nowPlaying, line2: "Artist" },
      three_line: { line1: world.nowPlaying, line2: "Artist" },
      length: 200,
      seek_position: 3,
    },
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
  world.albumTitle = "Some Album";
  world.nowPlaying = "Prior Track";
  world.flipOnPlay = true;
  world.state = "playing";
  world.executed = [];
  lastBrowse = "root";
  Object.assign(world, partial);
}

describe("fuzzy replace guard (#3): a stomp may not ride on a loose match", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it('play_album when:"replace" refuses and returns candidates when the match is below 90%', async () => {
    // The album match ("Unrelated Record") shares no words with the query, so
    // confidence is far below the 0.9 replace threshold.
    reset({ albumTitle: "Unrelated Record" });
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", {
      album: "Kill The Moonlight Spoon",
      when: "replace",
    });

    expect(isError).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(json.error).toBe("low_confidence_replace");
    expect(Array.isArray(json.candidates)).toBe(true);
    expect(json.candidates.length).toBeGreaterThan(0);
    // Nothing was played: no Play Now action ran.
    expect(world.executed).not.toContain("act:play");
    expect(world.executed).toHaveLength(0);
  });

  it('play_album when:"replace" proceeds when the match is confident (>=90%)', async () => {
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", { album: "Some Album", when: "replace" });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Now playing:/);
    expect(world.executed).toContain("act:play");
  });
});

describe("false-success guard (#4): an acked play that never changes now-playing is NOT success", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("play_album immediate:true whose Play Now does not change now-playing reports NOT verified, isError", async () => {
    // Confident match so it proceeds to execute, but the action is a silent
    // no-op: now-playing stays on the track that was playing before.
    reset({ flipOnPlay: false });
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", { album: "Some Album", immediate: true });

    expect(isError).toBe(true);
    // The warning is the FIRST line of the text, not buried in the JSON tail.
    expect(text).toMatch(/^WARNING - not verified/);
    expect(text).toMatch(/did NOT change/);
    // The action was attempted (acked) - but the tool refuses to call it success.
    expect(world.executed).toContain("act:play");
    expect(text).not.toMatch(/^Now playing:/);
  });
});

describe("from-silence guard (fix 3): a play that never starts from silence is NOT success", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
  });

  it("play_album immediate:true against a silent zone that never starts reports NOT verified, isError, warning-first", async () => {
    // The zone is silent (stopped, no now-playing) and the Play Now never starts
    // anything - an affirmative no-start, not merely unobservable, so isError.
    reset({ nowPlaying: null as unknown as string, flipOnPlay: false, state: "stopped" });
    const server = buildServer();
    const { isError, text } = await call(server, "play_album", { album: "Some Album", immediate: true });

    expect(isError).toBe(true);
    expect(text).toMatch(/^WARNING - not verified/);
    expect(text).toMatch(/nothing started playing/);
    expect(world.executed).toContain("act:play");
    expect(text).not.toMatch(/^Now playing:/);
  });
});
