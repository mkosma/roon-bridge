/**
 * Tests for find_versions + queue_version (Maya P0 studio/version selection).
 *
 * The mock models a universal track search that returns three recordings of the
 * same song - the studio cut, a live take, and a greatest-hits comp - each with
 * its own action list (Play Now / Add Next / Queue). queue_version must pin the
 * EXACT recording named by the ref (not a fresh fuzzy pick) and verify the add
 * by real queue growth.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem } from "node-roon-api-transport";

const world = {
  queue: [] as QueueItem[],
  executed: [] as string[],
  enqueueWorks: true,
  nextId: 2000,
};

function qitem(title: string, artist: string): QueueItem {
  return {
    queue_item_id: world.nextId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist },
  };
}

// Three versions of "Twist & Crawl": studio (on I Just Can't Stop It), a live
// take, and a greatest-hits compilation appearance.
function trackCandidates(): BrowseItem[] {
  return [
    { title: "Twist & Crawl (Live 1982)", item_key: "trk:live", hint: "list", subtitle: "The Beat" },
    { title: "Twist & Crawl", item_key: "trk:comp", hint: "list", subtitle: "The Beat / The Best Of The Beat" },
    { title: "Twist & Crawl", item_key: "trk:studio", hint: "list", subtitle: "The Beat / I Just Can't Stop It" },
  ];
}

const actions = (key: string): BrowseItem[] => [
  { title: "Play Now", item_key: `act:play:${key}`, hint: "action" },
  { title: "Add Next", item_key: `act:next:${key}`, hint: "action" },
  { title: "Queue", item_key: `act:queue:${key}`, hint: "action" },
  { title: "Start Radio", item_key: `act:radio:${key}`, hint: "action" },
];

let lastBrowse = "root";

function loadItems(): BrowseItem[] {
  switch (lastBrowse) {
    case "root":
      return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
    case "cat:track":
      return trackCandidates();
    case "trk:live":
      return actions("live");
    case "trk:comp":
      return actions("comp");
    case "trk:studio":
      return actions("studio");
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
      if (world.enqueueWorks && (key.startsWith("act:queue:") || key.startsWith("act:next:"))) {
        const which = key.split(":")[2];
        world.queue.push(qitem(`Twist & Crawl [${which}]`, "The Beat"));
      }
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isTrack = key.startsWith("trk:");
    cb(false, {
      action: "list",
      list: { title: key, count: loadItems().length, level: 1, hint: isTrack ? "action_list" : undefined },
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
    getTransport: vi.fn(() => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() })),
    findZoneOrThrow: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1" })),
    getQueueSnapshot: vi.fn(async () => world.queue.slice()),
  },
}));

const { registerVersionTools } = await import("../src/tools/versions.js");
const { encodeRef, decodeRef } = await import("../src/tools/versions.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerVersionTools(server);
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

function reset() {
  world.queue = [];
  world.executed = [];
  world.enqueueWorks = true;
  world.nextId = 2000;
  lastBrowse = "root";
}

describe("ref encode/decode", () => {
  it("round-trips a version ref", () => {
    const ref = { q: "Twist & Crawl", c: "track", t: "Twist & Crawl", s: "The Beat / I Just Can't Stop It", src: "all" as const };
    expect(decodeRef(encodeRef(ref))).toEqual(ref);
  });
  it("returns null for garbage", () => {
    expect(decodeRef("not-a-real-token!!")).toBeNull();
  });
});

describe("find_versions", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("ranks the studio cut first and flags the live take", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "find_versions", { query: "Twist & Crawl" });
    expect(isError).toBe(false);
    expect(json.candidates[0].title).toBe("Twist & Crawl");
    expect(json.candidates[0].subtitle).toContain("I Just Can't Stop It");
    expect(json.candidates[0].is_live).toBe(false);
    const live = json.candidates.find((c: { title: string }) => c.title.includes("Live"));
    expect(live.is_live).toBe(true);
  });

  it("exclude_live drops the live recording", async () => {
    const server = buildServer();
    const { json } = await call(server, "find_versions", { query: "Twist & Crawl", exclude_live: true });
    expect(json.candidates.every((c: { is_live: boolean }) => c.is_live === false)).toBe(true);
    expect(json.candidates.some((c: { title: string }) => c.title.includes("Live"))).toBe(false);
  });

  it("every candidate carries a decodable ref pointing at its exact recording", async () => {
    const server = buildServer();
    const { json } = await call(server, "find_versions", { query: "Twist & Crawl" });
    for (const c of json.candidates) {
      const ref = decodeRef(c.ref);
      expect(ref?.t).toBe(c.title);
    }
  });

  it("surfaces the browse item_key, an instrumental flag, and documents unreachable fields", async () => {
    const server = buildServer();
    const { json } = await call(server, "find_versions", { query: "Twist & Crawl" });
    for (const c of json.candidates) {
      expect(typeof c.item_key === "string" || c.item_key === null).toBe(true);
      expect(typeof c.instrumental).toBe("boolean");
    }
    // The studio cut carries its real browse item_key.
    const studio = json.candidates.find((c: { subtitle: string }) => c.subtitle?.includes("I Just Can't Stop It"));
    expect(studio.item_key).toBe("trk:studio");
    // Roon-browse API limits are documented in the payload, not silently omitted.
    expect(json.fields_note).toMatch(/duration .* explicit .* year .* provider track ID/i);
  });
});

describe("queue_version", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  async function refFor(server: unknown, predicate: (c: { title: string; subtitle: string }) => boolean) {
    const { json } = await call(server, "find_versions", { query: "Twist & Crawl" });
    return json.candidates.find(predicate).ref as string;
  }

  it("queues the EXACT studio recording named by the ref, verified by growth", async () => {
    const server = buildServer();
    const ref = await refFor(server, (c) => c.subtitle?.includes("I Just Can't Stop It"));
    const { isError, json } = await call(server, "queue_version", { ref });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(json.matched.subtitle).toContain("I Just Can't Stop It");
    expect(json.matched.is_live).toBe(false);
    // It queued the studio action, not the live or comp one.
    expect(world.executed).toContain("act:queue:studio");
    expect(world.executed.some((k) => k.includes("live") || k.includes("comp"))).toBe(false);
  });

  it("honors an explicit live ref (deterministic, not re-ranked to studio)", async () => {
    const server = buildServer();
    const ref = await refFor(server, (c) => c.title.includes("Live"));
    const { json } = await call(server, "queue_version", { ref });
    expect(json.ok).toBe(true);
    expect(json.matched.is_live).toBe(true);
    expect(world.executed).toContain("act:queue:live");
  });

  it("'next' uses Add Next", async () => {
    const server = buildServer();
    const ref = await refFor(server, (c) => c.subtitle?.includes("I Just Can't Stop It"));
    const { json } = await call(server, "queue_version", { ref, when: "next" });
    expect(json.action).toBe("Add Next");
    expect(world.executed).toContain("act:next:studio");
  });

  it("reports add_not_verified when the action no-ops (queue does not grow)", async () => {
    const server = buildServer();
    const ref = await refFor(server, (c) => c.subtitle?.includes("I Just Can't Stop It"));
    world.enqueueWorks = false;
    const { isError, json } = await call(server, "queue_version", { ref });
    expect(isError).toBe(true);
    expect(json.error).toBe("add_not_verified");
  });

  it("rejects a stale/unknown ref honestly", async () => {
    const server = buildServer();
    const ref = encodeRef({ q: "Twist & Crawl", c: "track", t: "Nonexistent Take", s: "Nobody", src: "all" });
    const { isError, json } = await call(server, "queue_version", { ref });
    expect(isError).toBe(true);
    expect(json.error).toBe("ref_not_found");
    expect(world.executed).toHaveLength(0);
  });

  it("rejects a malformed ref", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "queue_version", { ref: "garbage!!" });
    expect(isError).toBe(true);
    expect(json.error).toBe("bad_ref");
  });
});
