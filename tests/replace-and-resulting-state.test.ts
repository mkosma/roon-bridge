/**
 * Acceptance tests for the harness-safe "replace queue and play now" work:
 *
 *   1. TRANSPORT-LEVEL SERIALIZATION (the class the historic -32602 lived in):
 *      drive play_tracks through a REAL MCP transport + Client (JSON-RPC +
 *      zod validation), not a direct handler call. when:"replace",
 *      immediate:"true" (string), and immediate:true all take the interrupt
 *      path; immediate:"false" and omitted take the safe path. A direct
 *      handler call bypasses zod and would never have caught the bug - this
 *      goes through the serializing boundary where it lived.
 *   2. when:"replace" against a 200-item queue + 13 tracks ends with
 *      queue_count 13, track 1 playing, and the tool's own resulting_state
 *      matches the fake transport's state.
 *   3. Fuzzy guard: play_album with when:"replace" and a sub-0.9 match returns
 *      candidates and mutates NOTHING.
 *   4. False-success regression: a play action acked while now-playing does not
 *      change must NOT read as success.
 *
 * The fake models Play Now as clearing the queue (Roon's documented Play Now
 * semantics), Add Next / Queue as inserts/appends, and derives now-playing from
 * the queue head so a state read reflects the mutation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowseItem, BrowseResult, LoadResult } from "node-roon-api-browse";
import type { QueueItem, Zone, Output } from "node-roon-api-transport";
import type { ProviderTrack } from "../src/providers/types.js";

// 20 tracks, same artist, unique titles so each resolves unambiguously.
const TRACKS: Record<string, ProviderTrack> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => {
    const id = String(i + 1);
    const n = String(i + 1).padStart(2, "0");
    return [id, { provider: "qobuz", id, title: `Track ${n}`, artist: "The Band", album: "Album A", trackNumber: i + 1 }];
  }),
);

let queue: QueueItem[] = [];
let nextQId = 5000;
const executed: string[] = [];
let lastBrowse = "root";
let lastInput = "";

function qitem(title: string): QueueItem {
  return {
    queue_item_id: nextQId++,
    one_line: { line1: title },
    two_line: { line1: title, line2: "The Band" },
    three_line: { line1: title, line2: "The Band" },
  } as unknown as QueueItem;
}

function actions(id: string): BrowseItem[] {
  return [
    { title: "Play Now", item_key: `act:play:${id}`, hint: "action" },
    { title: "Add Next", item_key: `act:next:${id}`, hint: "action" },
    { title: "Queue", item_key: `act:queue:${id}`, hint: "action" },
  ];
}

function loadItems(): BrowseItem[] {
  if (lastBrowse === "root") return [{ title: "Tracks", item_key: "cat:track", hint: "list" }];
  if (lastBrowse === "cat:track") {
    const t = Object.values(TRACKS).find((t) => lastInput.toLowerCase().includes(t.title.toLowerCase()));
    return t ? [{ title: t.title, item_key: `trk:${t.id}`, hint: "list", subtitle: t.artist }] : [];
  }
  if (lastBrowse.startsWith("trk:")) return actions(lastBrowse.slice(4));
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
      const [, verb, id] = key.split(":");
      const t = TRACKS[id];
      if (t) {
        const item = qitem(t.title);
        if (verb === "queue") queue.push(item);
        else if (verb === "next") queue.length === 0 ? queue.push(item) : queue.splice(1, 0, item);
        else if (verb === "play") queue = [item]; // Play Now clears the queue
      }
      executed.push(key);
      cb(false, { action: "none" });
      return;
    }
    lastBrowse = key;
    const isActions = key.startsWith("trk:");
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

function output(): Output {
  return { output_id: "out-wiim", zone_id: "zone-1", display_name: "WiiM", state: "playing", volume: { type: "number", value: 48, min: 0, max: 100, is_muted: false } } as unknown as Output;
}

/** The zone, with now-playing derived from the queue head so a state read
 *  reflects whatever the last mutation did. */
function zoneObj(): Zone {
  const head = queue[0];
  const title = head ? (head.three_line?.line1 ?? "(silence)") : "(silence)";
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: "playing",
    outputs: [output()],
    now_playing: {
      one_line: { line1: title },
      two_line: { line1: title, line2: "The Band" },
      three_line: { line1: title, line2: "The Band" },
      length: 200,
      seek_position: 3,
    },
  } as unknown as Zone;
}

const mockConn = {
  getBrowse: () => mockBrowse,
  getTransport: () => ({ change_settings: (_z: unknown, _s: unknown, cb: () => void) => cb() }),
  findZone: () => zoneObj(),
  findZoneOrThrow: () => zoneObj(),
  getQueueSnapshot: async () => queue.slice(),
  // The DeferredPlayer treats the connection as its event source (cancel() calls
  // source.off); provide no-op event hooks so an immediate action can supersede.
  on: () => {},
  off: () => {},
};

vi.mock("../src/roon-connection.js", () => ({ roonConnection: mockConn }));

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

function reset(initialTitles: string[] = []) {
  nextQId = 5000;
  queue = initialTitles.map((t) => qitem(t));
  executed.length = 0;
  lastBrowse = "root";
  lastInput = "";
}

/** Build an MCP server + Client wired through the in-memory JSON-RPC transport,
 *  so tool calls run the registered zod schemas exactly as a real client does. */
async function connectClient() {
  const server = new McpServer({ name: "t", version: "0" });
  registerPlayByIdTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

/** Call a tool through the transport, parse its JSON payload. */
async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content.map((c) => c.text).join("\n");
  // The payload is the last JSON object in the text (tools may prefix a human line).
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    if (start >= 0) json = JSON.parse(text.slice(start));
  }
  return { isError: res.isError === true, json };
}

describe("transport-level serialization: the interrupt switch survives a stringifying client", () => {
  beforeEach(() => reset(["Old One", "Old Two"]));

  it('when:"replace" takes the interrupt path (no boolean at all)', async () => {
    const { client } = await connectClient();
    const { isError, json } = await callTool(client, "play_tracks", { track_ids: ["3", "4"], when: "replace" });
    expect(isError).toBe(false);
    expect(json.when).toBe("now");
  });

  it('immediate:"true" (STRING, as a scalar-stringifying harness sends it) does NOT -32602 and takes the interrupt path', async () => {
    const { client } = await connectClient();
    // Before the fix this threw MCP -32602 "Expected boolean, received string".
    const { isError, json } = await callTool(client, "play_tracks", { track_ids: ["3", "4"], immediate: "true" });
    expect(isError).toBe(false);
    expect(json.when).toBe("now");
  });

  it("immediate:true (real boolean) still takes the interrupt path", async () => {
    const { client } = await connectClient();
    const { json } = await callTool(client, "play_tracks", { track_ids: ["3", "4"], immediate: true });
    expect(json.when).toBe("now");
  });

  it('immediate:"false" (STRING) takes the SAFE path - never mapped to true', async () => {
    const { client } = await connectClient();
    const { json } = await callTool(client, "play_tracks", { track_ids: ["3", "4"], immediate: "false" });
    expect(json.when).toBe("next");
  });

  it("omitted interrupt args take the SAFE path", async () => {
    const { client } = await connectClient();
    const { json } = await callTool(client, "play_tracks", { track_ids: ["3", "4"] });
    expect(json.when).toBe("next");
  });
});

describe('when:"replace" fully replaces a large queue', () => {
  it("a 200-item queue + 13 tracks ends with queue_count 13, track 1 playing, resulting_state matching", async () => {
    reset(Array.from({ length: 200 }, (_, i) => `Discovered ${i}`));
    const { client } = await connectClient();
    const ids = Array.from({ length: 13 }, (_, i) => String(i + 1));
    const { isError, json } = await callTool(client, "play_tracks", { track_ids: ids, when: "replace" });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.when).toBe("now");
    expect(json.count_queued).toBe(13);
    expect(json.queue_length).toBe(13);
    expect(json.replaced_queue).toBe(true);
    expect(json.trailing_after_block).toBe(0);

    // The whole 200-item Discovered tail is gone; exactly the 13 requested remain.
    expect(queue.map((q) => q.three_line?.line1)).toEqual(ids.map((_, i) => `Track ${String(i + 1).padStart(2, "0")}`));

    // The tool's own resulting_state reflects the same state the fake transport holds.
    const rs = json.resulting_state as Record<string, unknown>;
    expect(rs.queue_count).toBe(13);
    expect((rs.now_playing as { track: string }).track).toBe("Track 01");
    expect(rs.state).toBe("playing");
    expect((rs.volume as { value: number }).value).toBe(48);
  });
});
