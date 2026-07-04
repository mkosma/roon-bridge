/**
 * Tests for edit_queue (delete/reorder via safe rebuild).
 *
 *   Part A - pure planning helpers (planEditedList / detectInterference /
 *            finalQueueMatches) in isolation.
 *   Part B - the tool end-to-end against a mocked Roon browse + provider + an
 *            event-emitting connection, covering:
 *              - when="now": delete + reorder rebuild, EXACT provider-id replay,
 *                verified final order.
 *              - when="after_current": arms, then ABORTS cleanly when the queue
 *                changes during the wait (never stomps the user).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem, Zone } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Part A: pure helpers (no Roon). Imported after the mocks below are set up so
// the module's top-level `new DeferredPlayer(roonConnection)` uses the mock.
// ---------------------------------------------------------------------------

// A stateful mock world shared by the browse + connection mocks.
interface NP { title: string; artist: string; length: number; seek: number }
const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  np: null as NP | null,
  state: "playing" as Zone["state"],
  nextId: 7000,
};

function qitem(id: number, title: string, artist: string): QueueItem {
  return {
    queue_item_id: id,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
    length: 100,
  } as unknown as QueueItem;
}

const TRACKS: Record<string, ProviderTrack> = {
  idB: { provider: "qobuz", id: "idB", title: "Beta", artist: "Artist", album: "Album One", trackNumber: 2 },
  idC: { provider: "qobuz", id: "idC", title: "Gamma", artist: "Artist", album: "Album One", trackNumber: 3 },
  idD: { provider: "qobuz", id: "idD", title: "Delta", artist: "Artist", album: "Album One", trackNumber: 4 },
};
const TITLE_BY_ID: Record<string, string> = { idB: "Beta", idC: "Gamma", idD: "Delta" };

function actions(id: string): BrowseItem[] {
  return [
    { title: "Play Now", item_key: `act:play:${id}`, hint: "action" },
    { title: "Add Next", item_key: `act:next:${id}`, hint: "action" },
    { title: "Queue", item_key: `act:queue:${id}`, hint: "action" },
  ];
}

let lastBrowse = "root";
let lastInput = "";

function trackIdForInput(input: string): string | null {
  const lower = input.toLowerCase();
  for (const [id, t] of Object.entries(TRACKS)) {
    if (lower.includes(t.title.toLowerCase())) return id;
  }
  return null;
}

function loadItems(): BrowseItem[] {
  if (lastBrowse === "root") {
    return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
  }
  if (lastBrowse === "cat:track") {
    const id = trackIdForInput(lastInput);
    if (!id) return [];
    const t = TRACKS[id];
    return [{ title: t.title, item_key: `trk:${id}`, hint: "list", subtitle: t.artist }];
  }
  if (lastBrowse.startsWith("trk:")) {
    return actions(lastBrowse.slice(4));
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
      const [, intent, id] = key.split(":");
      const title = TITLE_BY_ID[id] ?? "?";
      if (intent === "play") {
        // Play Now replaces the queue + flips now-playing.
        const item = qitem(world.nextId++, title, "Artist");
        world.queue = [item];
        world.np = { title, artist: "Artist", length: 100, seek: 0 };
      } else {
        world.queue.push(qitem(world.nextId++, title, "Artist"));
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key.startsWith("trk:");
    cb(false, { action: "list", list: { title: key, count: 1, level: 1, hint: isActions ? "action_list" : undefined } });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = loadItems();
    cb(false, { items, offset: 0, list: { title: lastBrowse, count: items.length, level: 0 } });
  },
};

class MockConnection extends EventEmitter {
  getBrowse() { return mockBrowse; }
  getTransport() { return { change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() }; }
  zoneObj(): Zone {
    return {
      zone_id: "zone-1",
      display_name: "WiiM + 1",
      state: world.state,
      outputs: [],
      now_playing: world.np
        ? { one_line: { line1: world.np.title }, two_line: { line1: world.np.title, line2: world.np.artist }, three_line: { line1: world.np.title, line2: world.np.artist }, length: world.np.length, seek_position: world.np.seek }
        : undefined,
    } as unknown as Zone;
  }
  findZone() { return this.zoneObj(); }
  findZoneOrThrow() { return this.zoneObj(); }
  getQueueSnapshot() { return Promise.resolve(world.queue.slice()); }
}

const mockConn = new MockConnection();

vi.mock("../src/roon-connection.js", () => ({ roonConnection: mockConn }));
vi.mock("../src/providers/bootstrap.js", () => ({
  initProviders: () => ({
    get: () => ({ getTrack: async (id: string) => { const t = TRACKS[id]; if (!t) throw new Error(`unknown ${id}`); return t; } }),
  }),
}));

const { planEditedList, detectInterference, finalQueueMatches, registerEditQueueTools } = await import("../src/tools/edit-queue.js");
const { queueProvenance } = await import("../src/control/queue-provenance.js");
const { readQueueRows } = await import("../src/tools/queue.js");

function row(id: number, title: string, np = false, pos = 0): import("../src/tools/queue.js").QueueRow {
  return { position: pos, queue_item_id: id, title, artist: "Artist", album: "Album One", length_seconds: 100, length: "1:40", is_now_playing: np };
}

describe("planEditedList", () => {
  const base = [row(1, "A", true, 1), row(2, "B", false, 2), row(3, "C", false, 3), row(4, "D", false, 4)];

  it("deletes a mid-queue upcoming track, current keeps its place", () => {
    const p = planEditedList(base, [3]);
    expect(p.currentId).toBe(1);
    expect(p.deletedPlaying).toBe(false);
    expect(p.editedUpcoming.map((r) => r.queue_item_id)).toEqual([2, 4]);
    expect(p.noop).toBe(false);
  });

  it("reorders remaining upcoming tracks", () => {
    const p = planEditedList(base, [], [4, 2, 3]);
    expect(p.editedUpcoming.map((r) => r.queue_item_id)).toEqual([4, 2, 3]);
  });

  it("delete + reorder together", () => {
    const p = planEditedList(base, [3], [4, 2]);
    expect(p.editedUpcoming.map((r) => r.queue_item_id)).toEqual([4, 2]);
  });

  it("flags a no-op (no delete, order unchanged)", () => {
    expect(planEditedList(base, []).noop).toBe(true);
    expect(planEditedList(base, [], [2, 3, 4]).noop).toBe(true);
  });

  it("rejects an unknown delete id", () => {
    expect(planEditedList(base, [99]).error?.error).toBe("unknown_delete_id");
  });

  it("rejects a reorder that is not a permutation of the remaining upcoming", () => {
    expect(planEditedList(base, [3], [2, 3, 4]).error?.error).toBe("reorder_mismatch"); // 3 was deleted
    expect(planEditedList(base, [], [2, 3]).error?.error).toBe("reorder_mismatch"); // missing 4
    expect(planEditedList(base, [], [1, 2, 3, 4]).error?.error).toBe("reorder_mismatch"); // includes now-playing
  });

  it("marks deletedPlaying when the now-playing id is in the delete set", () => {
    const p = planEditedList(base, [1]);
    expect(p.deletedPlaying).toBe(true);
    expect(p.editedUpcoming.map((r) => r.queue_item_id)).toEqual([2, 3, 4]);
  });

  it("treats the whole queue as upcoming when nothing is playing", () => {
    const stopped = [row(2, "B", false, 1), row(3, "C", false, 2)];
    const p = planEditedList(stopped, [2]);
    expect(p.currentId).toBe(null);
    expect(p.editedUpcoming.map((r) => r.queue_item_id)).toEqual([3]);
  });
});

describe("detectInterference", () => {
  it("no interference when upcoming ids are intact (advanced head, trailing radio tolerated)", () => {
    expect(detectInterference([2, 3, 4], [2, 3, 4])).toBe(false);
    expect(detectInterference([2, 3, 4], [1, 2, 3, 4, 9])).toBe(false); // stale head + trailing add
  });
  it("interference when an expected upcoming id is gone", () => {
    expect(detectInterference([2, 3, 4], [3, 4])).toBe(true);
  });
  it("interference when the upcoming order changed", () => {
    expect(detectInterference([2, 3, 4], [2, 4, 3])).toBe(true);
  });
});

describe("finalQueueMatches", () => {
  it("matches identical title order", () => {
    expect(finalQueueMatches([{ title: "D", artist: "x" }, { title: "B", artist: "x" }], [{ title: "D", artist: "x" }, { title: "B", artist: "x" }]).match).toBe(true);
  });
  it("fails on wrong order", () => {
    const r = finalQueueMatches([{ title: "D", artist: "x" }, { title: "B", artist: "x" }], [{ title: "B", artist: "x" }, { title: "D", artist: "x" }]);
    expect(r.match).toBe(false);
    expect(r.firstMismatch).toBe(0);
  });
  it("fails when the result is shorter than intended", () => {
    expect(finalQueueMatches([{ title: "D", artist: "x" }, { title: "B", artist: "x" }], [{ title: "D", artist: "x" }]).match).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part B: tool integration
// ---------------------------------------------------------------------------

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerEditQueueTools(server);
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
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function seedQueue() {
  // Now playing A, upcoming B(11) C(12) D(13). Provenance pre-captured by id.
  world.queue = [qitem(10, "Alpha", "Artist"), qitem(11, "Beta", "Artist"), qitem(12, "Gamma", "Artist"), qitem(13, "Delta", "Artist")];
  world.np = { title: "Alpha", artist: "Artist", length: 100, seek: 0 };
  world.state = "playing";
  world.executed = [];
  queueProvenance.clear();
  queueProvenance.record(11, { providerId: "idB", provider: "qobuz", title: "Beta", artist: "Artist", album: "Album One", trackNumber: 2 });
  queueProvenance.record(12, { providerId: "idC", provider: "qobuz", title: "Gamma", artist: "Artist", album: "Album One", trackNumber: 3 });
  queueProvenance.record(13, { providerId: "idD", provider: "qobuz", title: "Delta", artist: "Artist", album: "Album One", trackNumber: 4 });
}

describe("edit_queue tool (integration)", () => {
  beforeEach(() => { vi.clearAllMocks(); lastBrowse = "root"; lastInput = ""; });

  it("immediate:true: deletes Gamma and reorders to [Delta, Beta], replaying EXACT provider ids", async () => {
    seedQueue();
    const server = buildServer();
    const { isError, json } = await call(server, "edit_queue", { delete: [12], reorder: [13, 11], immediate: true });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    // First edited track (Delta) started via Play Now, by its exact provider id.
    expect(world.executed).toContain("act:play:idD");
    // Beta appended via Queue.
    expect(world.executed).toContain("act:queue:idB");
    // Gamma never touched.
    expect(world.executed.some((k) => k.includes("idC"))).toBe(false);
    // No item needed title+artist fallback - all had provenance.
    expect(json.plan.reresolved_count).toBe(0);
    // Final queue matches intent [Delta, Beta].
    const titles = world.queue.map((q) => q.three_line!.line1);
    expect(titles).toEqual(["Delta", "Beta"]);
    expect(json.outcome.final_match).toBe(true);
  });

  it("rejects an empty-result edit (cannot clear the upcoming queue)", async () => {
    seedQueue();
    const server = buildServer();
    const { isError, json } = await call(server, "edit_queue", { delete: [11, 12, 13], when: "now" });
    expect(isError).toBe(true);
    expect(json.error).toBe("cannot_empty_queue");
    expect(world.executed).toHaveLength(0); // nothing executed
  });

  it("when='after_current': arms, then ABORTS on interference (queue changed during wait)", async () => {
    seedQueue();
    const server = buildServer();
    const { json } = await call(server, "edit_queue", { delete: [12], when: "after_current" });
    expect(json.scheduled).toBe(true);
    expect(world.executed).toHaveLength(0); // nothing yet

    // Interfere: the user removes Beta from the upcoming queue during the wait.
    world.queue = [qitem(10, "Alpha", "Artist"), qitem(12, "Gamma", "Artist"), qitem(13, "Delta", "Artist")];
    // Now drive a natural track end (Alpha -> Beta would normally play).
    world.np = { title: "Alpha", artist: "Artist", length: 100, seek: 96 };
    mockConn.emit("zone-seek", "zone-1");
    world.np = { title: "Gamma", artist: "Artist", length: 100, seek: 0 };
    mockConn.emit("zones-changed");

    // Give the fire-and-forget rebuild a tick; it must abort without executing.
    await new Promise((r) => setTimeout(r, 50));
    expect(world.executed).toHaveLength(0);
  });

  it("when='after_current': fires and rebuilds at a clean natural track end", async () => {
    seedQueue();
    const server = buildServer();
    const { json } = await call(server, "edit_queue", { delete: [12], when: "after_current" });
    expect(json.scheduled).toBe(true);

    // Natural end of Alpha; Roon advances, upcoming intact [Beta, Gamma, Delta].
    world.queue = [qitem(11, "Beta", "Artist"), qitem(12, "Gamma", "Artist"), qitem(13, "Delta", "Artist")];
    world.np = { title: "Alpha", artist: "Artist", length: 100, seek: 96 };
    mockConn.emit("zone-seek", "zone-1");
    world.np = { title: "Beta", artist: "Artist", length: 100, seek: 0 };
    mockConn.emit("zones-changed");

    // Rebuild: play Beta now, append Delta (Gamma deleted). Order -> [Beta, Delta].
    await waitFor(() => world.executed.includes("act:play:idB"));
    await waitFor(() => world.executed.includes("act:queue:idD"));
    expect(world.executed.some((k) => k.includes("idC"))).toBe(false);
    expect(world.queue.map((q) => q.three_line!.line1)).toEqual(["Beta", "Delta"]);
  });

  it("SAFE DEFAULT (no immediate) arms a deferred rebuild - does not cut the current track", async () => {
    seedQueue();
    const server = buildServer();
    const { json } = await call(server, "edit_queue", { delete: [12] });
    // Default is after_current: armed, nothing executed yet, current track intact.
    expect(json.scheduled).toBe(true);
    expect(json.when).toBe("after_current");
    expect(world.executed).toHaveLength(0);
  });

  it("falls back to title+artist re-resolution and flags items without provenance", async () => {
    seedQueue();
    queueProvenance.forget(13); // Delta queued by the GUI - no provider id.
    const server = buildServer();
    const { json } = await call(server, "edit_queue", { reorder: [13, 11, 12], immediate: true });
    expect(json.ok).toBe(true);
    expect(json.plan.reresolved_count).toBe(1);
    const delta = json.plan.edited_upcoming.find((e: { title: string }) => e.title === "Delta");
    expect(delta.reresolved).toBe(true);
    // Still resolved + played by name (Delta) as the new head.
    expect(world.executed).toContain("act:play:idD");
  });
});
