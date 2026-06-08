/**
 * Tests for get_roon_playlist's filtering of Roon's phantom action rows
 * (Maya FIX-3). Roon's playlist browse node prepends play-all controls (e.g.
 * "Play Playlist") before the real tracks; they must not surface as tracks, and
 * `total`/offsets must reflect the real track count.
 *
 * Uses a small stateful mock of the browse tree:
 *   root -> "Playlists" -> "Hearted Albums & Songs" -> [action row, ...tracks]
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseItem } from "../src/tools/search-core.js";

// The playlist's raw rows as Roon returns them: one leading action row, then
// the three real tracks.
const PL_ROWS: BrowseItem[] = [
  { title: "Play Playlist", item_key: "act:play", hint: "action_list" },
  { title: "Track A", subtitle: "Artist A", item_key: "t:a", hint: "list" },
  { title: "Track B", subtitle: "Artist B", item_key: "t:b", hint: "list" },
  { title: "Track C", subtitle: "Artist C", item_key: "t:c", hint: "list" },
];

const NODES: Record<string, BrowseItem[]> = {
  root: [{ title: "Playlists", item_key: "node:playlists", hint: "list" }],
  "node:playlists": [{ title: "Hearted Albums & Songs", item_key: "pl:hearted", hint: "list" }],
  "pl:hearted": PL_ROWS,
};

let currentNode = "root";

const mockBrowse = {
  browse: (opts: Record<string, unknown>, cb: (e: false | string, b: unknown) => void) => {
    currentNode = opts.pop_all ? "root" : String(opts.item_key ?? "root");
    const rows = NODES[currentNode] ?? [];
    cb(false, { action: "list", list: { title: currentNode, count: rows.length, level: 0 } });
  },
  load: (opts: Record<string, unknown>, cb: (e: false | string, b: unknown) => void) => {
    const rows = NODES[currentNode] ?? [];
    const offset = Number(opts.offset ?? 0);
    const count = Number(opts.count ?? rows.length);
    const items = rows.slice(offset, offset + count);
    cb(false, { items, offset, list: { title: currentNode, count: rows.length, level: 0 } });
  },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getBrowse: vi.fn(() => mockBrowse),
  },
}));

const { registerRoonPlaylistTools } = await import("../src/tools/roon-playlists.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerRoonPlaylistTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  // Calling the handler directly bypasses the MCP layer's zod parsing, so apply
  // the same offset/limit defaults the server would.
  const withDefaults = { offset: 0, limit: 200, ...args };
  const res = await tool.handler(withDefaults, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

describe("get_roon_playlist (FIX-3: phantom action row)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentNode = "root";
  });

  it("drops the leading 'Play Playlist' row; position 1 is the first real track", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "get_roon_playlist", { name: "Hearted Albums & Songs" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    const tracks = json.tracks as Array<Record<string, unknown>>;
    expect(tracks.map((t) => t.title)).toEqual(["Track A", "Track B", "Track C"]);
    expect(tracks[0].position).toBe(1);
    // No action/header rows survive at any position.
    expect(tracks.some((t) => t.title === "Play Playlist")).toBe(false);
  });

  it("reports total as the real track count, not including the action row", async () => {
    const server = buildServer();
    const { json } = await call(server, "get_roon_playlist", { name: "Hearted Albums & Songs" });
    expect(json.total).toBe(3); // 4 raw rows - 1 action row
    expect(json.returned).toBe(3);
    expect(json.next_offset).toBeNull();
  });

  it("keeps offsets consistent: offset addresses real tracks", async () => {
    const server = buildServer();
    const { json } = await call(server, "get_roon_playlist", { name: "Hearted Albums & Songs", offset: 1, limit: 1 });
    const tracks = json.tracks as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Track B");
    expect(tracks[0].position).toBe(2);
    expect(json.total).toBe(3);
    expect(json.next_offset).toBe(2);
  });
});
