/**
 * Navigation tests for add_to_library against the 2026-06-08 live-verify defect:
 * the album quick popup (Play Now / Add Next / Queue / Start Radio) carries NO
 * library toggle, and Roon surfaces the album under TWO search-root entries - a
 * primary-match card AND the "Albums" category. "Add to Library" lives on the
 * album DETAIL page reached via the card, not on the category popup.
 *
 * Unlike add-to-library.test.ts (which uses a stage-based mock), this mock
 * models the Roon browse STACK faithfully: browsing a nav key PUSHES a level,
 * pop_levels POPS, and a nav key whose parent is not the current stack top is
 * REJECTED as stale. That makes the depth-first search's pop bookkeeping
 * load-bearing: if it forgets to pop a dead-end branch before trying a sibling,
 * the sibling's key is stale and the add fails - so these tests would catch it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";

const world = {
  inLibrary: false,
  cardHasLibrary: true, // when false, neither entry exposes a library toggle
  executed: [] as string[],
};

// The album's library menu (the detail-page "..." menu, reached via the card).
function libraryMenu(): BrowseItem[] {
  const toggle: BrowseItem = world.cardHasLibrary
    ? world.inLibrary
      ? { title: "Remove from Library", item_key: "act:remove", hint: "action" }
      : { title: "Add to Library", item_key: "act:add", hint: "action" }
    : { title: "Start Radio", item_key: "act:radio", hint: "action" };
  return [
    { title: "Play Now", item_key: "act:play", hint: "action" },
    { title: "Add Next", item_key: "act:next", hint: "action" },
    toggle,
    { title: "Queue", item_key: "act:queue", hint: "action" },
  ];
}

// The album quick popup reached from the "Albums" category: no library toggle,
// no further nav children. This is the dead end the old code stopped on.
function quickPopup(): BrowseItem[] {
  return [
    { title: "Play Now", item_key: "act:play", hint: "action" },
    { title: "Add Next", item_key: "act:next", hint: "action" },
    { title: "Queue", item_key: "act:queue", hint: "action" },
    { title: "Start Radio", item_key: "act:radio", hint: "action" },
  ];
}

// Browse-tree nodes. `parent` is the id whose stack frame must be on top for a
// browse into this node to be valid (modeling Roon's session/stack key scoping).
const NODES: Record<string, { parent: string | null; listHint?: "action_list"; items: () => BrowseItem[] }> = {
  root: {
    parent: null,
    items: () => [
      { title: "Beyond the Bog Road", item_key: "nav:card", hint: "list", subtitle: "Eileen Ivers" },
      { title: "Albums", item_key: "nav:albums", hint: "list" },
    ],
  },
  // Primary-match card -> album DETAIL page: a Play Album header action, a track
  // row, a decoy menu (forces a pop), then the real menu with the library toggle.
  card: {
    parent: "root",
    items: () => [
      { title: "Play Album", item_key: "act:playalbum", hint: "action" },
      { title: "1. Walk On", item_key: "nav:trk1", hint: "list" },
      { title: "Other Versions", item_key: "nav:decoy", hint: "action_list" },
      { title: "More", item_key: "nav:cardmenu", hint: "action_list" },
    ],
  },
  decoy: { parent: "card", listHint: "action_list", items: () => [
    { title: "Play From Here", item_key: "act:pfh", hint: "action" },
    { title: "Start Radio", item_key: "act:radio", hint: "action" },
  ] },
  cardmenu: { parent: "card", listHint: "action_list", items: libraryMenu },
  trk1: { parent: "card", items: () => [{ title: "Play Now", item_key: "act:play", hint: "action" }] },
  // "Albums" category -> a list of one album -> the quick popup (dead end).
  albums: { parent: "root", items: () => [
    { title: "Beyond the Bog Road", item_key: "nav:albumitem", hint: "list", subtitle: "Eileen Ivers" },
  ] },
  albumitem: { parent: "albums", listHint: "action_list", items: quickPopup },
};

let stack: string[] = [];
const top = () => stack[stack.length - 1];

function listMeta(id: string) {
  return { title: id, count: NODES[id].items().length, level: stack.length - 1, hint: NODES[id].listHint };
}

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: BrowseResult) => void) => {
    if (opts.pop_all) {
      stack = ["root"];
      return cb(false, { action: "list", list: listMeta("root") });
    }
    if (typeof opts.pop_levels === "number") {
      for (let i = 0; i < (opts.pop_levels as number); i++) stack.pop();
      return cb(false, { action: "list", list: listMeta(top()) });
    }
    const key = String(opts.item_key ?? "");
    if (key.startsWith("act:")) {
      world.executed.push(key);
      if (key === "act:add") world.inLibrary = true;
      if (key === "act:remove") world.inLibrary = false;
      return cb(false, { action: "none" });
    }
    if (key.startsWith("nav:")) {
      const target = key.slice(4);
      const node = NODES[target];
      if (!node) return cb("UnknownItemKey", {} as BrowseResult);
      // Reject a key whose parent frame is not on top: it is stale (the caller
      // navigated elsewhere and failed to pop back). This is what catches a
      // pop-bookkeeping bug in the depth-first search.
      if (node.parent !== top()) return cb("StaleItemKey", {} as BrowseResult);
      stack.push(target);
      return cb(false, { action: "list", list: listMeta(target) });
    }
    cb(false, { action: "none" });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const id = top();
    const items = id ? NODES[id].items() : [];
    cb(false, { items, offset: 0, list: listMeta(id ?? "root") });
  },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
    getTransport: vi.fn(() => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() })),
    findZoneOrThrow: vi.fn(() => ({ zone_id: "zone-1", display_name: "WiiM + 1" })),
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
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* plain-text error path */ }
  return { isError: res.isError === true, text, json };
}

function reset(partial: Partial<typeof world> = {}) {
  world.inLibrary = false;
  world.cardHasLibrary = true;
  world.executed = [];
  stack = [];
  Object.assign(world, partial);
}

describe("add_to_library navigation across search-root entries", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  // The headline defect: the "Albums" category resolves to a quick popup with no
  // library toggle; the tool must fall through to the primary-match card, drill
  // past a decoy menu to the detail-page menu, find Add to Library, and add.
  it("falls through the category quick-popup to the card detail menu and adds", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", {
      query: "Eileen Ivers Beyond the Bog Road",
    });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.action).toBe("Add to Library");
    expect(json.verified).toBe(true);
    expect(world.executed).toContain("act:add");
    expect(world.inLibrary).toBe(true);
  });

  it("is idempotent when the album is already in the library (card path)", async () => {
    reset({ inLibrary: true });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", {
      query: "Eileen Ivers Beyond the Bog Road",
    });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.already_in_library).toBe(true);
    expect(json.verified).toBe(true);
    expect(world.executed).not.toContain("act:add");
  });

  // Truly unaddable: no entry exposes a library toggle anywhere in its subtree.
  // Must report unsupported_operation honestly, never a false success.
  it("reports unsupported_operation when no entry exposes a library action", async () => {
    reset({ cardHasLibrary: false });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", {
      query: "Eileen Ivers Beyond the Bog Road",
    });

    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unsupported_operation");
    expect(world.executed).not.toContain("act:add");
  });
});
