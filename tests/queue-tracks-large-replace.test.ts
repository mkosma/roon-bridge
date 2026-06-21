/**
 * BUG B regression: a large-queue replace (play_tracks / queue_tracks when='now')
 * must not report order_verified=true when Roon actually dropped tracks.
 *
 * The live failure (2026-06-20): replacing a ~38-item journey queue with 5 IDs
 * reported count_queued=5 / order_verified=true, but the queue settled to only 2
 * items (~9.7s to settle). The post-action verify read the queue while Roon was
 * still draining+rebuilding, saw a TRANSIENT snapshot that briefly held all 5
 * tracks, and declared success before the queue collapsed to a partial state.
 * Small-queue replaces never reproduced it (they settle instantly).
 *
 * The mock models exactly that race: getQueueSnapshot returns a transient
 * full-block snapshot for the first couple of reads, then settles to a stable
 * partial (the dropped queue) - or to the full block when the replace is clean.
 * A correct verify must wait for the queue to SETTLE before judging, then report
 * the real, settled count.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

const TITLES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const TRACKS: Record<string, ProviderTrack> = Object.fromEntries(
  TITLES.map((title, i) => [
    String(i + 1),
    { provider: "qobuz", id: String(i + 1), title, artist: "The Band", album: "Album A", trackNumber: i + 1 } as ProviderTrack,
  ]),
);

function qitem(title: string, id: number): QueueItem {
  return {
    queue_item_id: id,
    one_line: { line1: title },
    two_line: { line1: title, line2: "The Band" },
    three_line: { line1: title, line2: "The Band" },
  };
}

// Stable, fixed-id snapshots so waitForStableQueue can detect settling by id.
const FULL: QueueItem[] = TITLES.map((t, i) => qitem(t, i + 1));
const OLD: QueueItem[] = Array.from({ length: 33 }, (_, i) => qitem(`Old ${i}`, 100 + i));
const TRANSIENT: QueueItem[] = [...FULL, ...OLD]; // mid-settle: full block briefly visible
const SETTLED_DROP: QueueItem[] = [FULL[0], FULL[1]]; // only 2 of 5 actually landed
const SETTLED_FULL: QueueItem[] = [...FULL]; // clean replace: all 5 landed

const world = { dropTail: true, snapCount: 0, executed: [] as string[] };

let lastBrowse = "root";
let lastInput = "";

function loadItems(): BrowseItem[] {
  if (lastBrowse === "root") {
    const t = Object.values(TRACKS).find((t) => lastInput.toLowerCase().includes(t.title.toLowerCase()));
    return t ? [{ title: "Tracks", item_key: "cat:track", hint: "list" }] : [];
  }
  if (lastBrowse === "cat:track") {
    const t = Object.values(TRACKS).find((t) => lastInput.toLowerCase().includes(t.title.toLowerCase()));
    return t ? [{ title: t.title, item_key: `trk:${t.id}`, hint: "list", subtitle: t.artist }] : [];
  }
  if (lastBrowse.startsWith("trk:")) {
    const id = lastBrowse.slice(4);
    return [
      { title: "Play Now", item_key: `act:play:${id}`, hint: "action" },
      { title: "Add Next", item_key: `act:next:${id}`, hint: "action" },
      { title: "Queue", item_key: `act:queue:${id}`, hint: "action" },
    ];
  }
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
      world.executed.push(key);
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key.startsWith("trk:");
    cb(false, { action: "list", list: { title: key, count: loadItems().length, level: 1, hint: isActions ? "action_list" : undefined } });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = loadItems();
    cb(false, { items, offset: 0, list: { title: lastBrowse, count: items.length, level: 0 } });
  },
};

// The settling model: the first couple of reads see the transient full block;
// later reads see the stable settled queue (partial or full).
function snapshot(): QueueItem[] {
  world.snapCount += 1;
  if (world.snapCount <= 2) return TRANSIENT.slice();
  return (world.dropTail ? SETTLED_DROP : SETTLED_FULL).slice();
}

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
    getTransport: vi.fn(() => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() })),
    findZoneOrThrow: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1", state: "playing" })),
    findZone: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1" })),
    getQueueSnapshot: vi.fn(async () => snapshot()),
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

function reset(partial: Partial<typeof world> = {}) {
  world.dropTail = true;
  world.snapCount = 0;
  world.executed = [];
  lastBrowse = "root";
  lastInput = "";
  Object.assign(world, partial);
}

describe("large-queue replace verify (BUG B)", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("does NOT report order_verified=true when a large replace drops tracks", async () => {
    reset({ dropTail: true });
    const server = buildServer();
    const { isError, json } = await call(server, "play_tracks", { track_ids: ["1", "2", "3", "4", "5"] });
    // Settled reality: only 2 of 5 landed. The verify must reflect that, not the
    // transient full-block snapshot.
    expect(json.count_queued).toBe(2);
    expect(json.order_verified).toBe(false);
    expect(json.ok).toBe(false);
    expect(isError).toBe(true);
  });

  it("reports success when the replace settles to the full block", async () => {
    reset({ dropTail: false });
    const server = buildServer();
    const { isError, json } = await call(server, "play_tracks", { track_ids: ["1", "2", "3", "4", "5"] });
    expect(json.count_queued).toBe(5);
    expect(json.order_verified).toBe(true);
    expect(json.ok).toBe(true);
    expect(isError).toBe(false);
  });
});
