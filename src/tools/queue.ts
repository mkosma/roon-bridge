/**
 * queue.ts: in-flight queue editing with stable item ids (Maya spec P0-A).
 *
 * Roon platform reality (verified against node-roon-api-transport
 * "com.roonlabs.transport:2" and the browse service):
 *
 *   - The ONLY queue mutators Roon exposes to an extension are:
 *       * browse action "Add Next"  -> insert immediately after current track
 *       * browse action "Queue"     -> append to end of queue
 *       * transport play_from_here  -> jump playback to a queue_item_id
 *     and subscribe_queue to READ the queue (each item carries a stable
 *     queue_item_id).
 *
 *   - There is NO transport/browse primitive to remove an arbitrary queue
 *     item or to move one to a new position. Roon's own apps implement those
 *     against a private endpoint not surfaced to extensions.
 *
 * So this module delivers, honestly:
 *   - queue_next       : real, native "Add Next" semantics, post-verified.
 *   - play_from_here   : real, native jump.
 *   - remove_from_queue: Roon exposes no queue-delete primitive. The only
 *                        approximation - play_from_here past the items - starts
 *                        playback AT the landing item and abandons everything
 *                        before it, so it interrupts and discards the
 *                        now-playing track. That is destructive and dishonest
 *                        (the verify-loop would still report success while the
 *                        listened-to track was dropped), so this tool refuses
 *                        outright, exactly like reorder_queue, and points at the
 *                        supported alternatives.
 *   - reorder_queue    : Roon exposes no move primitive; this fails loudly with
 *                        a precise explanation and the supported alternative,
 *                        rather than returning a false success.
 *
 * Every mutating tool re-reads the queue afterward and reports the actual
 * resulting state, so a no-op can never masquerade as success.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type { Zone, QueueItem } from "node-roon-api-transport";
import {
  newSessionKey,
  browseAndLoad,
  scoreCandidates,
  resolveActionItem,
  stripRoonLinks,
  promisifyBrowse,
  type QueueAction,
} from "./search-core.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export interface QueueRow {
  position: number; // 1-based
  queue_item_id: number;
  title: string;
  artist: string | null;
  album: string | null;
  length_seconds: number | null;
  length: string | null;
  is_now_playing: boolean;
}

/** Map a Roon QueueItem to our stable, structured row. */
export function toQueueRow(item: QueueItem, index: number, nowPlayingId: number | null): QueueRow {
  return {
    position: index + 1,
    queue_item_id: item.queue_item_id,
    title: item.three_line?.line1 ?? item.two_line?.line1 ?? item.one_line?.line1 ?? "(unknown)",
    artist: item.three_line?.line2 ? stripRoonLinks(item.three_line.line2) : (item.two_line?.line2 ?? null),
    album: item.three_line?.line3 ? stripRoonLinks(item.three_line.line3) : null,
    length_seconds: item.length ?? null,
    length: item.length != null ? formatTime(item.length) : null,
    is_now_playing: nowPlayingId != null && item.queue_item_id === nowPlayingId,
  };
}

/**
 * Read the queue and return structured rows. The now-playing item is the first
 * queue item whose title matches the zone's now_playing line1 AND, when
 * available, length - Roon does not hand us the now-playing queue_item_id
 * directly, so we infer it positionally (the now-playing item is the head of
 * the queue while playing).
 */
export async function readQueueRows(zone: Zone, maxItems = 200): Promise<QueueRow[]> {
  const items = await roonConnection.getQueueSnapshot(zone, maxItems);
  // While playing/paused, Roon keeps the now-playing track as queue item 0.
  const playing = zone.state === "playing" || zone.state === "paused" || zone.state === "loading";
  const npId = playing && items.length > 0 ? items[0].queue_item_id : null;
  return items.map((it, i) => toQueueRow(it, i, npId));
}

/**
 * Drive the Roon browse tree from a fresh search to the action list for the
 * best matching item, then return the matched candidate + the action list.
 * Shared by queue_next and (re-)used to make adds trustworthy.
 *
 * Returns either a resolved action context, a disambiguation set, or an error.
 */
interface ResolvedTarget {
  kind: "resolved";
  sessionKey: string;
  matchTitle: string;
  matchArtist: string;
  matchAlbum: string | null;
  confidence: number;
  actionItems: import("./search-core.js").BrowseItem[];
  actionListHint?: string;
}
interface NoMatch { kind: "no_match"; query: string; }
interface BrowseErr { kind: "error"; error: string; }

async function navigateToActionList(
  query: string,
  zone: Zone,
  category?: string,
): Promise<ResolvedTarget | NoMatch | BrowseErr> {
  const browse = roonConnection.getBrowse();
  const sessionKey = newSessionKey();
  const hierarchy = "search";

  const searchData = await browseAndLoad(browse, {
    hierarchy,
    input: query,
    pop_all: true,
    zone_or_output_id: zone.zone_id,
    multi_session_key: sessionKey,
  });
  if (searchData.error) return { kind: "error", error: searchData.error };
  if (!searchData.items?.length) return { kind: "no_match", query };

  // Pick category bucket.
  const cats = searchData.items;
  let targetCategory = undefined as undefined | import("./search-core.js").BrowseItem;
  if (category) {
    const catLower = category.toLowerCase();
    targetCategory =
      cats.find((c) => c.item_key && (c.title.toLowerCase() === catLower + "s" || c.title.toLowerCase() === catLower)) ||
      cats.find((c) => c.item_key && c.title.toLowerCase().includes(catLower) && c.hint !== "header");
  }
  if (!targetCategory) targetCategory = cats.find((c) => c.item_key && c.hint !== "header");
  if (!targetCategory?.item_key) return { kind: "no_match", query };

  const categoryData = await browseAndLoad(browse, {
    hierarchy,
    item_key: targetCategory.item_key,
    zone_or_output_id: zone.zone_id,
    multi_session_key: sessionKey,
  });
  if (categoryData.error) return { kind: "error", error: categoryData.error };
  if (!categoryData.items?.length) return { kind: "no_match", query };

  const penalize = category !== "playlist";
  const ranked = scoreCandidates(categoryData.items, query, penalize);
  if (!ranked.length) return { kind: "no_match", query };
  const top = ranked[0];

  // Drill into the matched item to get its action list.
  const actionData = await browseAndLoad(browse, {
    hierarchy,
    item_key: top.item_key,
    zone_or_output_id: zone.zone_id,
    multi_session_key: sessionKey,
  });
  if (actionData.error) return { kind: "error", error: actionData.error };

  let actionItems = actionData.items ?? [];
  let listHint = actionData.list?.hint;

  // Navigate deeper when the first level is a content list, not actions.
  const MAX_NAV_DEPTH = 3;
  for (let depth = 0; depth < MAX_NAV_DEPTH; depth++) {
    if (listHint === "action_list") break;
    if (actionItems.some((it) => it.hint === "action")) break;
    const navigable = actionItems.filter((it) => it.item_key && (it.hint === "action_list" || it.hint === "list"));
    if (navigable.length !== 1) break; // 0 = nothing to do; >1 = content list, stop
    const deeper = await browseAndLoad(browse, {
      hierarchy,
      item_key: navigable[0].item_key!,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });
    if (deeper.error || !deeper.items?.length) break;
    actionItems = deeper.items;
    listHint = deeper.list?.hint;
  }

  return {
    kind: "resolved",
    sessionKey,
    matchTitle: top.title,
    matchArtist: top.artist,
    matchAlbum: top.subtitle && top.subtitle !== top.artist ? top.subtitle : null,
    confidence: top.confidence,
    actionItems,
    actionListHint: listHint ?? undefined,
  };
}

/**
 * Execute a queue action (add_next / queue) for the best match of `query`,
 * then VERIFY by re-reading the queue. Returns a structured result reporting
 * what was matched, the confidence, and proof the add landed.
 */
async function findAndQueue(
  query: string,
  zone: Zone,
  intent: QueueAction,
  category?: string,
): Promise<ToolResult> {
  const resolved = await navigateToActionList(query, zone, category);
  if (resolved.kind === "no_match") {
    return jsonResult({ ok: false, error: "no_match", query, zone: zone.display_name }, true);
  }
  if (resolved.kind === "error") {
    return jsonResult({ ok: false, error: resolved.error, query, zone: zone.display_name }, true);
  }

  const action = resolveActionItem(resolved.actionItems, intent);
  if (!action?.item.item_key) {
    return jsonResult(
      {
        ok: false,
        error: "no_action",
        detail: `No '${intent}' action available for "${resolved.matchTitle}".`,
        available_actions: resolved.actionItems.filter((i) => i.hint !== "header").map((i) => i.title),
      },
      true,
    );
  }

  // Snapshot the queue BEFORE, so we can prove the add changed it.
  const before = await readQueueRows(zone);
  const beforeIds = new Set(before.map((r) => r.queue_item_id));
  const beforeCount = before.length;

  const browse = roonConnection.getBrowse();
  const exec = await promisifyBrowse(browse, {
    hierarchy: "search",
    item_key: action.item.item_key,
    zone_or_output_id: zone.zone_id,
    multi_session_key: resolved.sessionKey,
  });
  if (exec.error) {
    return jsonResult({ ok: false, error: String(exec.error), matched: resolved.matchTitle }, true);
  }

  // Verify by re-reading. Roon applies queue changes asynchronously; poll
  // briefly until the queue reflects the add or we time out.
  let after = await readQueueRows(zone);
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const grew = after.length > beforeCount;
    const newId = after.some((r) => !beforeIds.has(r.queue_item_id));
    if (grew || newId) break;
    await new Promise((r) => setTimeout(r, 150));
    after = await readQueueRows(zone);
  }

  const newRows = after.filter((r) => !beforeIds.has(r.queue_item_id));
  const landed = after.length > beforeCount || newRows.length > 0;

  if (!landed) {
    return jsonResult(
      {
        ok: false,
        error: "add_not_verified",
        detail:
          "The browse action returned success but a follow-up queue read showed no new item. The add did NOT land.",
        matched: resolved.matchTitle,
        artist: resolved.matchArtist,
        action: action.matched,
        queue_count_before: beforeCount,
        queue_count_after: after.length,
      },
      true,
    );
  }

  return jsonResult({
    ok: true,
    action: action.matched, // "Add Next" or "Queue" - what Roon actually did
    intent,
    matched: {
      title: resolved.matchTitle,
      artist: resolved.matchArtist,
      album: resolved.matchAlbum,
      confidence: Number(resolved.confidence.toFixed(2)),
    },
    verified: true,
    queue_count_before: beforeCount,
    queue_count_after: after.length,
    new_items: newRows.map((r) => ({
      queue_item_id: r.queue_item_id,
      position: r.position,
      title: r.title,
      artist: r.artist,
    })),
    zone: zone.display_name,
  });
}

export function registerQueueTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // queue_next - insert a track/album/playlist immediately after current track.
  // ---------------------------------------------------------------------------
  server.tool(
    "queue_next",
    "Insert a track, album, or playlist to play IMMEDIATELY AFTER the current track (Roon 'Add Next'). Verified against a follow-up queue read; reports what it matched and the confidence. Use `item_id` semantics by first searching, or pass a free-text query.",
    {
      query: z.string().describe("What to play next (track, album, artist, or playlist name)."),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)."),
      category: z
        .enum(["track", "album", "artist", "playlist"])
        .optional()
        .describe("Narrow the search to a category to disambiguate."),
    },
    async ({ query, zone, category }): Promise<ToolResult> => {
      try {
        const z = roonConnection.findZoneOrThrow(zone);
        return await findAndQueue(query, z, "add_next", category);
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // play_from_here - jump playback to a queued item by its stable id.
  // ---------------------------------------------------------------------------
  server.tool(
    "play_from_here",
    "Jump playback to a specific queued item by its queue_item_id (from get_queue). Native Roon operation. Verified by re-reading now-playing.",
    {
      queue_item_id: z.coerce.number().int().describe("queue_item_id from get_queue."),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)."),
    },
    async ({ queue_item_id, zone }): Promise<ToolResult> => {
      try {
        const z = roonConnection.findZoneOrThrow(zone);
        const rows = await readQueueRows(z);
        const target = rows.find((r) => r.queue_item_id === queue_item_id);
        if (!target) {
          return jsonResult(
            {
              ok: false,
              error: "stale_id",
              detail: `queue_item_id ${queue_item_id} is not in the current queue (already played, removed, or wrong zone).`,
              queue_item_ids: rows.map((r) => r.queue_item_id),
            },
            true,
          );
        }
        await roonConnection.playFromHere(z, queue_item_id);

        // Verify: re-read; the target should now be the head / now-playing.
        await new Promise((r) => setTimeout(r, 200));
        const after = await readQueueRows(z);
        const head = after[0];
        return jsonResult({
          ok: true,
          jumped_to: { queue_item_id, title: target.title, artist: target.artist },
          now_playing: head ? { queue_item_id: head.queue_item_id, title: head.title } : null,
          verified: head?.queue_item_id === queue_item_id,
          zone: z.display_name,
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // remove_from_queue - refuse honestly.
  //
  // Roon's extension API exposes NO queue-delete primitive. The only
  // approximation is play_from_here past the targeted items - but that starts
  // playback AT the landing item and abandons everything before it, so it
  // interrupts and discards the currently-playing track as collateral. (Proven
  // live: removing the single next-up item dropped both it AND the now-playing
  // track.) A verify-loop checking only the requested ids would report success
  // while having silently killed the track the user was listening to, so we do
  // not keep that path even behind a flag. The Roon GUI can delete queue items
  // because it uses a private service Roon does not grant to extensions.
  //
  // So this refuses outright, exactly like reorder_queue, touching neither
  // playback nor the queue, and points at the supported alternatives.
  // ---------------------------------------------------------------------------
  server.tool(
    "remove_from_queue",
    "Remove upcoming queued items by queue_item_id. NOTE: Roon's extension API has no queue-delete primitive; the only approximation (jumping playback past the items) interrupts and discards the currently-playing track, so this tool refuses honestly rather than damaging playback. Supported alternatives: play_from_here (deliberately jump to a later item) and queue_next (insert right after the current track).",
    {
      queue_item_ids: z
        .array(z.coerce.number().int())
        .min(1)
        .describe("queue_item_id(s) to remove, from get_queue."),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)."),
    },
    async ({ queue_item_ids, zone }): Promise<ToolResult> => {
      try {
        const z = roonConnection.findZoneOrThrow(zone);
        return jsonResult(
          {
            ok: false,
            error: "unsupported_operation",
            detail:
              "Roon's extension API has no queue-delete primitive. The only approximation jumps playback past the items, which interrupts and discards the currently-playing track. The Roon GUI can remove queue items via a private service Roon does not expose to extensions.",
            alternatives: [
              "play_from_here(queue_item_id) to deliberately jump to a later item",
              "queue_next(query) to insert immediately after the current track",
            ],
            requested: { queue_item_ids },
            zone: z.display_name,
          },
          true,
        );
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reorder_queue - move an upcoming item to a new position.
  //
  // Roon's extension API exposes no queue-move primitive at all. We do not fake
  // it. This tool validates the request, then fails loudly with the precise
  // platform reason and the supported alternative.
  // ---------------------------------------------------------------------------
  server.tool(
    "reorder_queue",
    "Move an upcoming queued item to a new position. NOTE: Roon's extension API exposes no queue-move primitive; this tool reports that limitation honestly rather than returning a false success. Supported alternatives: queue_next (to put something right after current) and play_from_here (to jump).",
    {
      queue_item_id: z.coerce.number().int().describe("queue_item_id to move."),
      new_position: z.coerce.number().int().min(0).describe("Target 1-based position (0 treated as 1)."),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)."),
    },
    async ({ queue_item_id, new_position, zone }): Promise<ToolResult> => {
      try {
        const z = roonConnection.findZoneOrThrow(zone);
        const rows = await readQueueRows(z);
        const target = rows.find((r) => r.queue_item_id === queue_item_id);
        if (!target) {
          return jsonResult(
            {
              ok: false,
              error: "stale_id",
              detail: `queue_item_id ${queue_item_id} is not in the current queue.`,
              queue_item_ids: rows.map((r) => r.queue_item_id),
            },
            true,
          );
        }
        return jsonResult(
          {
            ok: false,
            error: "unsupported_operation",
            detail:
              "Roon's extension transport service (com.roonlabs.transport:2) provides no move/reorder primitive for queue items, and the browse service exposes none either. Arbitrary in-place reordering is not achievable via the public API.",
            requested: { queue_item_id, new_position },
            alternatives: [
              "queue_next(query) to place an item immediately after the current track",
              "play_from_here(queue_item_id) to jump playback to an existing item",
            ],
            zone: z.display_name,
          },
          true,
        );
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );
}
