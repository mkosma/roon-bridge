/**
 * Integration-ish tests for the queue editing tools (Maya spec P0-A), with a
 * stateful in-memory mock of the Roon connection + browse tree.
 *
 * Covers the adversarial edge cases Maya will re-run:
 *  - queue_next: nothing playing / paused / verified add / no-match loud fail.
 *  - play_from_here: valid jump + verification, stale id loud fail.
 *  - remove_from_queue: honest refusal on every target (no queue-delete
 *    primitive exists; the skip-past approximation discards the now-playing
 *    track), touching neither playback nor the queue.
 *  - reorder_queue: loud unsupported (never a false success).
 *  - add verification: an "add" that does not land fails loudly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QueueItem, Zone } from "node-roon-api-transport";

// ---------------------------------------------------------------------------
// Stateful mock world
// ---------------------------------------------------------------------------

interface World {
  state: Zone["state"];
  queue: QueueItem[];
  // When true, the next browse "Add Next"/"Queue" action is a no-op (simulates
  // the "Tonight - RÜFÜS DU SOL" silent-failure defect).
  swallowNextAdd: boolean;
  // Title the search will resolve to, or null to simulate no-match.
  resolveTitle: string | null;
}

const world: World = {
  state: "playing",
  queue: [],
  swallowNextAdd: false,
  resolveTitle: "Resolved Track",
};

function qi(id: number, title: string, artist?: string, len = 200): QueueItem {
  return {
    queue_item_id: id,
    length: len,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

function makeZone(): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: world.state,
    outputs: [],
    is_previous_allowed: true,
    is_next_allowed: true,
    is_pause_allowed: true,
    is_play_allowed: true,
    is_seek_allowed: true,
    queue_items_remaining: world.queue.length,
  } as unknown as Zone;
}

// Mock browse: returns a fixed nav path ending in an action list with
// Play Now / Add Next / Queue. The terminal action execution mutates the queue
// unless swallowNextAdd is set.
const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: unknown) => void) => {
    // pop_all => start of search
    if (opts.pop_all) {
      cb(false, { action: "list", list: { title: "Search", count: 1, level: 0 } });
      return;
    }
    const key = String(opts.item_key ?? "");
    if (key === "cat:track") {
      cb(false, { action: "list", list: { title: "Tracks", count: 1, level: 1 } });
      return;
    }
    if (key === "match:item") {
      cb(false, { action: "list", list: { title: world.resolveTitle ?? "x", count: 3, level: 2, hint: "action_list" } });
      return;
    }
    // Action execution
    if (key === "action:add_next" || key === "action:queue") {
      if (!world.swallowNextAdd) {
        const insertAt = key === "action:add_next" ? 1 : world.queue.length;
        world.queue.splice(insertAt, 0, qi(900 + world.queue.length, world.resolveTitle ?? "Added"));
      }
      world.swallowNextAdd = false;
      cb(false, { action: "none" });
      return;
    }
    cb(false, { action: "none" });
  },
  load: (opts: Record<string, unknown>, cb: (e: false | string, b: unknown) => void) => {
    const level = Number(opts.offset ?? 0);
    void level;
    // Decide what list we're loading based on a tiny state machine keyed by
    // the most recent browse. We approximate: search root -> category list;
    // category -> match list; match -> action list.
    // We encode this by inspecting a module-level "stage".
    cb(false, { items: stageItems(), offset: 0, list: { title: "x", count: stageItems().length, level: 0 } });
  },
};

// The load() above needs to know which stage we're in. We track it by patching
// browse to set `currentStage`.
let currentStage: "root" | "category" | "match" | "action" = "root";
const origBrowse = mockBrowse.browse;
mockBrowse.browse = (opts, cb) => {
  if (opts.pop_all) currentStage = "category";
  else if (opts.item_key === "cat:track") currentStage = "match";
  else if (opts.item_key === "match:item") currentStage = "action";
  origBrowse(opts as Record<string, unknown>, cb);
};

function stageItems() {
  switch (currentStage) {
    case "category":
      return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
    case "match":
      // Empty resolveTitle simulates a genuine no-match (no playable items).
      return world.resolveTitle
        ? [{ title: world.resolveTitle, item_key: "match:item", hint: "list", subtitle: "Artist" }]
        : [];
    case "action":
      return [
        { title: "Play Now", item_key: "action:play_now", hint: "action" },
        { title: "Add Next", item_key: "action:add_next", hint: "action" },
        { title: "Queue", item_key: "action:queue", hint: "action" },
        { title: "Start Radio", item_key: "action:radio", hint: "action" },
      ];
    default:
      return [];
  }
}

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
    getTransport: vi.fn(() => ({
      change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb(),
    })),
    findZoneOrThrow: vi.fn(() => makeZone()),
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
    playFromHere: vi.fn(async (_z: Zone, id: number) => {
      // Drop everything before the target id (Roon play_from_here semantics).
      const idx = world.queue.findIndex((q) => q.queue_item_id === id);
      if (idx > 0) world.queue = world.queue.slice(idx);
    }),
  },
}));

const { registerQueueTools } = await import("../src/tools/queue.js");
const { roonConnection } = await import("../src/roon-connection.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerQueueTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

function resetWorld(partial: Partial<World>) {
  world.state = "playing";
  world.queue = [];
  world.swallowNextAdd = false;
  world.resolveTitle = "Resolved Track";
  currentStage = "root";
  Object.assign(world, partial);
}

describe("queue_next", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts right after current track and verifies the add landed", async () => {
    resetWorld({ queue: [qi(1, "Now Playing"), qi(2, "Later")] });
    const server = buildServer();
    const { isError, json } = await call(server, "queue_next", { query: "Resolved Track" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.action).toBe("Add Next");
    expect(json.verified).toBe(true);
    expect((json.matched as Record<string, unknown>).title).toBe("Resolved Track");
    // Inserted at position 2 (right after now-playing).
    expect(world.queue[1].three_line.line1).toBe("Resolved Track");
  });

  it("works with nothing playing / empty queue (add still lands)", async () => {
    resetWorld({ state: "stopped", queue: [] });
    const server = buildServer();
    const { json } = await call(server, "queue_next", { query: "Resolved Track" });
    expect(json.ok).toBe(true);
    expect(world.queue.length).toBe(1);
  });

  it("fails loudly when the add does not land (Tonight defect)", async () => {
    resetWorld({ queue: [qi(1, "NP")], swallowNextAdd: true });
    const server = buildServer();
    const { isError, json } = await call(server, "queue_next", { query: "Resolved Track" });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("add_not_verified");
  });

  it("returns within the 1.5s perf ceiling even when the add never lands", async () => {
    // The verify poll is anchored to the operation start, so the worst case
    // (add silently no-ops) must not hang past the ceiling.
    resetWorld({ queue: [qi(1, "NP")], swallowNextAdd: true });
    const server = buildServer();
    const t0 = Date.now();
    const { json } = await call(server, "queue_next", { query: "Resolved Track" });
    const elapsed = Date.now() - t0;
    expect(json.error).toBe("add_not_verified");
    // Small scheduler slack over the 1500ms window; nowhere near the old 2500ms.
    expect(elapsed).toBeLessThan(1800);
    expect(json.verification_window_ms).toBe(1500);
  });

  it("fails loudly on no-match, never silent", async () => {
    resetWorld({ queue: [qi(1, "NP")], resolveTitle: null });
    // With resolveTitle null the match list has an empty-title item; force a
    // genuine no-match by emptying the match stage.
    const server = buildServer();
    world.resolveTitle = "";
    const { isError, json } = await call(server, "queue_next", { query: "zzz nonexistent" });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
  });
});

describe("play_from_here", () => {
  beforeEach(() => vi.clearAllMocks());

  it("jumps to a valid queued id and verifies", async () => {
    resetWorld({ queue: [qi(1, "A"), qi(2, "B"), qi(3, "C")] });
    const server = buildServer();
    const { isError, json } = await call(server, "play_from_here", { queue_item_id: 2 });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(world.queue[0].queue_item_id).toBe(2);
  });

  it("fails loudly on a stale id", async () => {
    resetWorld({ queue: [qi(1, "A")] });
    const server = buildServer();
    const { isError, json } = await call(server, "play_from_here", { queue_item_id: 999 });
    expect(isError).toBe(true);
    expect(json.error).toBe("stale_id");
  });
});

describe("remove_from_queue", () => {
  beforeEach(() => vi.clearAllMocks());

  // FIX-1: Roon has no queue-delete primitive. The skip-past approximation
  // interrupts and discards the now-playing track, so remove_from_queue refuses
  // honestly on EVERY target and touches neither playback nor the queue.

  it("refuses any removal without touching playback or the queue (the live repro)", async () => {
    // Before: Outlier(4909) playing, next-up Grains(4910), then Second Sun(4911).
    resetWorld({
      queue: [qi(4909, "Outlier"), qi(4910, "Grains"), qi(4911, "Second Sun")],
    });
    const server = buildServer();
    const { isError, json } = await call(server, "remove_from_queue", { queue_item_ids: [4910] });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unsupported_operation");
    expect(json.alternatives).toBeTruthy();
    expect((json.requested as Record<string, unknown>).queue_item_ids).toEqual([4910]);
    // Playback never jumped and the queue is byte-for-byte unchanged.
    expect(roonConnection.playFromHere).not.toHaveBeenCalled();
    expect(world.queue.map((q) => q.queue_item_id)).toEqual([4909, 4910, 4911]);
  });

  it("refuses a now-playing target the same way (no special-case path)", async () => {
    resetWorld({ queue: [qi(1, "NP"), qi(2, "X")] });
    const server = buildServer();
    const { isError, json } = await call(server, "remove_from_queue", { queue_item_ids: [1] });
    expect(isError).toBe(true);
    expect(json.error).toBe("unsupported_operation");
    expect(roonConnection.playFromHere).not.toHaveBeenCalled();
    expect(world.queue.map((q) => q.queue_item_id)).toEqual([1, 2]);
  });

  it("refuses a stale id without pretending to look it up", async () => {
    resetWorld({ queue: [qi(1, "NP"), qi(2, "A")] });
    const server = buildServer();
    const { isError, json } = await call(server, "remove_from_queue", { queue_item_ids: [999] });
    expect(isError).toBe(true);
    expect(json.error).toBe("unsupported_operation");
    expect(roonConnection.playFromHere).not.toHaveBeenCalled();
    expect(world.queue.map((q) => q.queue_item_id)).toEqual([1, 2]);
  });
});

describe("reorder_queue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never returns a false success — reports the platform limitation", async () => {
    resetWorld({ queue: [qi(1, "NP"), qi(2, "A"), qi(3, "B")] });
    const server = buildServer();
    const { isError, json } = await call(server, "reorder_queue", { queue_item_id: 3, new_position: 1 });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unsupported_operation");
    expect(json.alternatives).toBeTruthy();
  });

  it("still validates the id first (stale id is its own error)", async () => {
    resetWorld({ queue: [qi(1, "NP")] });
    const server = buildServer();
    const { json } = await call(server, "reorder_queue", { queue_item_id: 42, new_position: 1 });
    expect(json.error).toBe("stale_id");
  });
});
