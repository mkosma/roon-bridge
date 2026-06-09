/**
 * Tests for the add_to_library MCP tool (Objective 4).
 *
 * Roon exposes "Add to Library" / "Remove from Library" as ordinary browse
 * action items (same item_key + execute mechanism as Play Now / Queue), so the
 * tool navigates search -> category -> match -> action list, executes the add,
 * and verifies by re-reading the menu (it should flip to "Remove from Library").
 *
 * The mock browse below models that action list and its membership toggle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";

const world = {
  albumTitle: "Beyond the Bog Road",
  matchExists: true,
  libraryActionAvailable: true,
  inLibrary: false,
  executed: [] as string[],
  // How Roon presents the matched album when browsed:
  //  "popup"   - first browse lands directly on the action_list (streaming case).
  //  "content" - first browse lands on the album CONTENT page (a "Play Album"
  //              header action + numbered track rows); the real action menu,
  //              carrying Add to Library, is nested behind `menuItem`. This is
  //              the defect shape from the 2026-06-08 live verify.
  albumShape: "popup" as "popup" | "content",
  // The nested-menu entry on a content page: its hint controls whether the tool
  // reaches it as an action_list (normal) or as a plain list row whose title is
  // the album itself (fallback path). `hasMenu=false` models a content page with
  // no reachable menu at all -> genuinely unsupported.
  hasMenu: true,
  menuHint: "action_list" as "action_list" | "list",
  menuTitle: "More",
};

let stage: "root" | "category" | "match" | "content" | "action" = "root";

function actionItems(): BrowseItem[] {
  const playNow: BrowseItem = { title: "Play Now", item_key: "act:play", hint: "action" };
  const queue: BrowseItem = { title: "Queue", item_key: "act:queue", hint: "action" };
  if (!world.libraryActionAvailable) return [playNow, queue];
  const lib: BrowseItem = world.inLibrary
    ? { title: "Remove from Library", item_key: "act:remove", hint: "action" }
    : { title: "Add to Library", item_key: "act:add", hint: "action" };
  return [playNow, lib, queue];
}

// The album content page: a "Play Album" header action, numbered track rows
// (hint:"list"), and optionally the nested action menu entry.
function contentItems(): BrowseItem[] {
  const items: BrowseItem[] = [
    { title: "Play Album", item_key: "act:playalbum", hint: "action" },
    { title: "1. Walk On", item_key: "trk:1", hint: "list" },
    { title: "2. Kitty's Wedding", item_key: "trk:2", hint: "list" },
  ];
  if (world.hasMenu) {
    items.push({ title: world.menuTitle, item_key: "menu:album", hint: world.menuHint });
  }
  return items;
}

function stageItems(): BrowseItem[] {
  switch (stage) {
    case "category":
      return [{ title: "Albums", item_key: "cat:album", hint: "list" }];
    case "match":
      return world.matchExists
        ? [{ title: world.albumTitle, item_key: "match:album", hint: "list", subtitle: "Eileen Ivers" }]
        : [];
    case "content":
      return contentItems();
    case "action":
      return actionItems();
    default:
      return [];
  }
}

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: BrowseResult) => void) => {
    if (opts.pop_all) {
      stage = "category";
      cb(false, { action: "list", list: { title: "Search", count: 1, level: 0 } });
      return;
    }
    const key = String(opts.item_key ?? "");
    if (key === "cat:album") {
      stage = "match";
      cb(false, { action: "list", list: { title: "Albums", count: stageItems().length, level: 1 } });
      return;
    }
    if (key === "match:album") {
      if (world.albumShape === "content") {
        stage = "content";
        // Content page: no action_list hint on the list itself.
        cb(false, { action: "list", list: { title: world.albumTitle, count: contentItems().length, level: 2 } });
      } else {
        stage = "action";
        cb(false, { action: "list", list: { title: world.albumTitle, count: actionItems().length, level: 2, hint: "action_list" } });
      }
      return;
    }
    if (key === "menu:album") {
      stage = "action";
      cb(false, { action: "list", list: { title: world.albumTitle, count: actionItems().length, level: 3, hint: "action_list" } });
      return;
    }
    // Action execution (Add/Remove from Library, Play, Queue).
    if (key.startsWith("act:")) {
      world.executed.push(key);
      if (key === "act:add") world.inLibrary = true;
      if (key === "act:remove") world.inLibrary = false;
      cb(false, { action: "none" });
      return;
    }
    cb(false, { action: "none" });
  },
  load: (_opts: Record<string, unknown>, cb: (e: false | string, b: LoadResult) => void) => {
    const items = stageItems();
    cb(false, { items, offset: 0, list: { title: "x", count: items.length, level: 0 } });
  },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
    getTransport: vi.fn(() => ({
      change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb(),
    })),
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
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON (plain-text error path); callers that need json assert isError.
  }
  return { isError: res.isError === true, text, json };
}

function reset(partial: Partial<typeof world> = {}) {
  world.albumTitle = "Beyond the Bog Road";
  world.matchExists = true;
  world.libraryActionAvailable = true;
  world.inLibrary = false;
  world.executed = [];
  world.albumShape = "popup";
  world.hasMenu = true;
  world.menuHint = "action_list";
  world.menuTitle = "More";
  stage = "root";
  Object.assign(world, partial);
}

describe("add_to_library", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds an album not yet in the library and verifies the flip to Remove", async () => {
    reset({ inLibrary: false });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.action).toBe("Add to Library");
    expect(json.verified).toBe(true);
    expect((json.matched as Record<string, unknown>).title).toBe("Beyond the Bog Road");
    expect(world.executed).toContain("act:add");
    expect(world.inLibrary).toBe(true);
  });

  it("is idempotent when the album is already in the library (no add executed)", async () => {
    reset({ inLibrary: true });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.already_in_library).toBe(true);
    expect(json.verified).toBe(true);
    expect(world.executed).not.toContain("act:add");
  });

  it("reports unsupported_operation when Roon exposes no add-to-library action", async () => {
    reset({ libraryActionAvailable: false });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unsupported_operation");
    expect(json.available_actions).toEqual(["Play Now", "Queue"]);
    expect(world.executed).not.toContain("act:add");
  });

  it("fails loudly when nothing matches the query", async () => {
    reset({ matchExists: false });
    const server = buildServer();
    const { isError } = await call(server, "add_to_library", { query: "No Such Album" });
    expect(isError).toBe(true);
    expect(world.executed).toHaveLength(0);
  });

  // Regression: the 2026-06-08 defect. The first browse lands on the album
  // CONTENT page ("Play Album" + track rows), not the action menu. The old code
  // stopped there (a "Play Album" action was present) and reported
  // unsupported_operation even though Add to Library was reachable one level
  // deeper. The tool must now drill into the nested action_list and add.
  it("drills past the album content page to the nested action menu and adds", async () => {
    reset({ albumShape: "content", menuHint: "action_list", menuTitle: "More" });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.action).toBe("Add to Library");
    expect(json.verified).toBe(true);
    expect(world.executed).toContain("act:add");
    expect(world.inLibrary).toBe(true);
  });

  // Fallback shape: a source that presents the album's menu as a plain list row
  // titled with the album itself (no action_list hint). The tool drills the row
  // whose title matches the match - never a track row ("1. Walk On") - and adds.
  it("reaches a content-page menu presented as a title-matching list row", async () => {
    reset({ albumShape: "content", hasMenu: true, menuHint: "list", menuTitle: "Beyond the Bog Road" });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    expect(world.executed).toContain("act:add");
  });

  // Already-in-library via the content-page path: the nested menu offers
  // Remove, not Add. Idempotent success, no add executed.
  it("is idempotent on a content-page album already in the library", async () => {
    reset({ albumShape: "content", inLibrary: true });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.already_in_library).toBe(true);
    expect(json.verified).toBe(true);
    expect(world.executed).not.toContain("act:add");
  });

  // Truly unsupported: a content page with no reachable menu at all. The tool
  // must still report unsupported_operation honestly (no false success), and
  // surface the content page's actions as what was available.
  it("reports unsupported_operation when a content page exposes no menu", async () => {
    reset({ albumShape: "content", hasMenu: false });
    const server = buildServer();
    const { isError, json } = await call(server, "add_to_library", { query: "Beyond the Bog Road" });

    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unsupported_operation");
    expect(json.available_actions).toEqual(["Play Album", "1. Walk On", "2. Kitty's Wedding"]);
    expect(world.executed).not.toContain("act:add");
  });
});
