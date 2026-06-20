/**
 * Root-cause regression for the lone queue_by_id ok=False seen 2026-06-20
 * (ticket item 7). When the current track advances naturally between the
 * 'Add Next' action and the verifying queue re-read, Roon consumes the played
 * head item and the just-added 'next' track becomes now-playing. A post-add
 * snapshot can then momentarily show NO net length growth and NO new queued id
 * (the added row is now the now-playing head, not an "upcoming" item) - so the
 * old queue-grew check false-negatived a real success.
 *
 * The fix adds a now-playing-flip signal: if now-playing flipped to the track we
 * just queued, the add landed. These tests prove the fix rescues that real
 * success WITHOUT turning verification into an always-true no-op.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

const TRACK: ProviderTrack = {
  provider: "qobuz",
  id: "777",
  title: "Our Track",
  artist: "Artist",
  album: "Alb",
  trackNumber: 1,
};

// Test knobs, reset per case.
let advanced = false; // set true once the 'Add Next' action executes
let simulateNaturalAdvance = true; // when false, the add is a genuine no-op

function qitem(id: number, title: string): QueueItem {
  return {
    queue_item_id: id,
    one_line: { line1: title },
    two_line: { line1: title, line2: "Artist" },
    three_line: { line1: title, line2: "Artist" },
  };
}

const HEAD = qitem(100, "Current");
const X = qitem(101, "Some Upcoming");

let lastBrowse = "root";
let lastInput = "";

function loadItems(): BrowseItem[] {
  if (lastBrowse === "root") return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
  if (lastBrowse === "cat:track") return [{ title: "Our Track", item_key: "trk:1", hint: "list", subtitle: "Artist" }];
  if (lastBrowse === "trk:1")
    return [
      { title: "Play Now", item_key: "act:play", hint: "action" },
      { title: "Add Next", item_key: "act:next", hint: "action" },
      { title: "Queue", item_key: "act:queue", hint: "action" },
    ];
  return [];
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
      // The add 'succeeds' at the browse layer; whether it lands in a way the
      // verify can see is what simulateNaturalAdvance controls.
      if (simulateNaturalAdvance) advanced = true;
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key === "trk:1";
    cb(false, { action: "list", list: { title: key, count: 1, level: 1, hint: isActions ? "action_list" : undefined } });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = loadItems();
    cb(false, { items, offset: 0, list: { title: lastBrowse, count: items.length, level: 0 } });
  },
};

const mockConn = {
  getBrowse: () => mockBrowse,
  getTransport: () => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() }),
  findZoneOrThrow: () => ({ zone_id: "zone-1", display_name: "WiiM + 1", state: "playing" }),
  // Now-playing flips to our track once the natural advance happens.
  findZone: () => ({
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    now_playing: { three_line: { line1: advanced ? "Our Track" : "Current" } },
  }),
  // Before the add: [HEAD, X]. After a natural advance: HEAD consumed, our added
  // track is now the now-playing head (not an upcoming row), so the snapshot
  // shows only [X] - no net growth, no new upcoming id.
  getQueueSnapshot: async () => (advanced ? [X] : [HEAD, X]),
};

vi.mock("../src/roon-connection.js", () => ({ roonConnection: mockConn }));
vi.mock("../src/providers/bootstrap.js", () => ({
  initProviders: () => ({ get: () => ({ getTrack: async () => TRACK }) }),
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

describe("queue_by_id verification is robust to a concurrent natural advance (item 7)", () => {
  beforeEach(() => {
    advanced = false;
    simulateNaturalAdvance = true;
    lastBrowse = "root";
    lastInput = "";
    vi.clearAllMocks();
  });

  it("reports ok=true when the added 'next' track became now-playing (no net queue growth)", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "777", when: "next" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(json.action).toBe("Add Next");
  });

  it("still reports ok=false for a genuine no-op (queue unchanged, now-playing did NOT flip)", async () => {
    simulateNaturalAdvance = false; // action runs but nothing lands, no advance
    const server = buildServer();
    const { isError, json } = await call(server, "queue_by_id", { track_id: "777", when: "next" });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("add_not_verified");
  });
});
