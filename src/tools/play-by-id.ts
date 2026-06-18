/**
 * play-by-id: DETERMINISTIC queue/play by provider track ID (Maya P0 headline).
 *
 * The problem this solves: every other play/queue path resolves a track through
 * Roon's fuzzy NAME search, which grabs covers, type-beats, wrong-artist takes,
 * and cannot distinguish two same-titled recordings by the same artist on
 * different albums (the "Puppets" case). search_tracks already returns clean,
 * unambiguous provider (Qobuz) track IDs - but until now nothing could queue or
 * play by one.
 *
 * Platform reality (investigated against node-roon-api + node-roon-api-browse):
 * Roon exposes NO "play by external/provider id" primitive. Playback happens
 * only through the browse tree (search -> category -> item -> action -> execute)
 * keyed by session-scoped item_keys, and the transport service has no play-by-id
 * either. A Qobuz catalog id is not a Roon item_key. So we bridge the two by
 * RESOLVING the id to its authoritative metadata (provider.getTrack) and then
 * pinning the EXACT Roon row deterministically:
 *
 *   1. provider.getTrack(id)  -> { title, artist, album, trackNumber }  (authoritative)
 *   2. Roon search "<artist> <title>", Tracks category, keep rows whose ARTIST
 *      matches (kills covers / type-beats / wrong-artist - failure class #1).
 *   3. If exactly one title+artist match -> that is the row.
 *   4. If tied (same artist, >1 album - the queue_version ambiguity case) OR none,
 *      re-resolve album-anchored: search "<artist> <album>", open the album, and
 *      pick the track row by exact title (+ track number) - album is the unique
 *      disambiguator, taken from the provider, never guessed.
 *   5. Execute when=now|next|queue and VERIFY (queue grew / now-playing changed).
 *
 * This bypasses fuzzy track-NAME matching entirely: the only search performed is
 * artist-scoped, and the selection among results is exact, not a top-1 guess.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import { initProviders } from "../providers/bootstrap.js";
import type { ProviderName, ProviderTrack } from "../providers/types.js";
import type { Zone } from "node-roon-api-transport";
import type RoonApiBrowse from "node-roon-api-browse";
import {
  newSessionKey,
  browseAndLoad,
  scoreCandidates,
  bestMatch,
  resolveActionItem,
  stripRoonLinks,
  promisifyBrowse,
  normalizeTitle,
  artistMatches,
  pickTrackRow,
  type BrowseItem,
  type QueueAction,
  type TrackIdentity,
} from "./search-core.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const WHEN_TO_INTENT: Record<string, QueueAction> = {
  queue: "queue",
  next: "add_next",
  now: "play_now",
};

/** Action verbs Roon prepends to an album page; never a track row. */
const ALBUM_ACTION_TITLE =
  /^(play|play now|play album|play artist|shuffle|add next|play next|queue|add to queue|start radio|start album radio)$/i;

/**
 * Drill a matched item's browse node to its action list, mirroring the deeper-
 * navigation logic the other play/queue paths use. Returns the action items
 * with the session left positioned so the caller can execute in the same session.
 */
async function drillToActions(
  browse: RoonApiBrowse,
  itemKey: string,
  zoneId: string | undefined,
  sessionKey: string,
): Promise<{ error?: string; message?: string; actionItems: BrowseItem[] }> {
  const actionData = await browseAndLoad(browse, {
    hierarchy: "search",
    item_key: itemKey,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (actionData.message) return { message: actionData.message, actionItems: [] };
  if (actionData.error) return { error: actionData.error, actionItems: [] };

  let actionItems = actionData.items ?? [];
  let listHint = actionData.list?.hint;
  for (let depth = 0; depth < 3; depth++) {
    if (listHint === "action_list") break;
    if (actionItems.some((i) => i.hint === "action")) break;
    const navigable = actionItems.filter((i) => i.item_key && (i.hint === "action_list" || i.hint === "list"));
    if (navigable.length !== 1) break;
    const deeper = await browseAndLoad(browse, {
      hierarchy: "search",
      item_key: navigable[0].item_key!,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    if (deeper.message) return { message: deeper.message, actionItems: [] };
    if (deeper.error || !deeper.items?.length) break;
    actionItems = deeper.items;
    listHint = deeper.list?.hint;
  }
  return { actionItems };
}

interface ResolvedRow {
  itemKey: string;
  via: "track-search" | "album-anchored";
  unambiguous: boolean;
  tiedCount: number;
}

/**
 * Resolve a provider track identity to a single Roon browse item_key, in the
 * given session, deterministically. Tries an artist-scoped track search first
 * (kills wrong-artist matches), then falls back to album-anchored resolution for
 * the tied / not-found case. Returns the item_key to drill, or an error string.
 */
async function resolveRoonRow(
  browse: RoonApiBrowse,
  meta: TrackIdentity,
  zoneId: string | undefined,
  sessionKey: string,
  log: (step: string, data: unknown) => void,
): Promise<ResolvedRow | { error: string; detail?: string }> {
  // --- Path A: artist-scoped track search ----------------------------------
  const trackQuery = `${meta.artist} ${meta.title}`.trim();
  const search = await browseAndLoad(browse, {
    hierarchy: "search",
    input: trackQuery,
    pop_all: true,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (!search.error && search.items?.length) {
    const tracksCat =
      search.items.find((i) => i.item_key && i.title.toLowerCase() === "tracks") ||
      search.items.find((i) => i.item_key && i.title.toLowerCase().includes("track"));
    if (tracksCat?.item_key) {
      const cat = await browseAndLoad(browse, {
        hierarchy: "search",
        item_key: tracksCat.item_key,
        zone_or_output_id: zoneId,
        multi_session_key: sessionKey,
      });
      if (!cat.error && cat.items?.length) {
        const pick = pickTrackRow(cat.items, meta, { rowsCarryArtist: true });
        log("track-search-pick", { matched: pick?.item.title, unambiguous: pick?.unambiguous, tied: pick?.tiedCount });
        if (pick && pick.unambiguous) {
          return { itemKey: pick.item.item_key!, via: "track-search", unambiguous: true, tiedCount: pick.tiedCount };
        }
        // Tied within Tracks (same artist, >1 album, identical rows): fall
        // through to album-anchored, which the album uniquely disambiguates.
      }
    }
  }

  // --- Path B: album-anchored resolution -----------------------------------
  if (!meta.album) {
    return { error: "ambiguous_no_album", detail: `Multiple recordings of "${meta.title}" by ${meta.artist} and the provider gave no album to disambiguate.` };
  }
  const albumQuery = `${meta.artist} ${meta.album}`.trim();
  const albumSearch = await browseAndLoad(browse, {
    hierarchy: "search",
    input: albumQuery,
    pop_all: true,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (albumSearch.error) return { error: "search_error", detail: albumSearch.error };
  if (!albumSearch.items?.length) return { error: "album_not_found", detail: `No results for album "${meta.album}".` };

  const albumsCat =
    albumSearch.items.find((i) => i.item_key && i.title.toLowerCase() === "albums") ||
    albumSearch.items.find((i) => i.item_key && i.title.toLowerCase().includes("album"));
  if (!albumsCat?.item_key) return { error: "album_not_found", detail: `No album category for "${meta.album}".` };

  const albumList = await browseAndLoad(browse, {
    hierarchy: "search",
    item_key: albumsCat.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (albumList.error || !albumList.items?.length) return { error: "album_not_found", detail: `No albums listed for "${meta.album}".` };

  const album = bestMatch(albumList.items, albumQuery);
  if (!album?.item_key) return { error: "album_not_found", detail: `No album match for "${meta.album}".` };
  log("album-matched", { title: album.title, subtitle: stripRoonLinks(album.subtitle || "") });

  // Open the album. Roon may return either the album's track listing or an
  // action popup; from a popup, find the navigable child that loads the tracks.
  const opened = await browseAndLoad(browse, {
    hierarchy: "search",
    item_key: album.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (opened.error || !opened.items?.length) return { error: "album_open_failed", detail: opened.error || "empty album page" };

  let trackRows = opened.items.filter(
    (i) => i.item_key && i.hint !== "header" && !ALBUM_ACTION_TITLE.test(i.title.trim()),
  );
  // If the open returned only action verbs (a popup), descend into the single
  // navigable list child that holds the actual tracks.
  if (!trackRows.some((r) => normalizeTitle(r.title) === normalizeTitle(meta.title) || normalizeTitle(r.title).includes(normalizeTitle(meta.title)))) {
    const navChild = opened.items.find(
      (i) => i.item_key && (i.hint === "list" || i.hint === "action_list") && !ALBUM_ACTION_TITLE.test(i.title.trim()),
    );
    if (navChild?.item_key) {
      const deeper = await browseAndLoad(browse, {
        hierarchy: "search",
        item_key: navChild.item_key,
        zone_or_output_id: zoneId,
        multi_session_key: sessionKey,
      });
      if (!deeper.error && deeper.items?.length) {
        trackRows = deeper.items.filter((i) => i.item_key && i.hint !== "header" && !ALBUM_ACTION_TITLE.test(i.title.trim()));
      }
    }
  }

  const pick = pickTrackRow(trackRows, meta, { rowsCarryArtist: false });
  log("album-track-pick", { matched: pick?.item.title, unambiguous: pick?.unambiguous, tied: pick?.tiedCount, rowCount: trackRows.length });
  if (!pick) {
    return { error: "track_not_in_album", detail: `"${meta.title}" was not found on album "${meta.album}".` };
  }
  return { itemKey: pick.item.item_key!, via: "album-anchored", unambiguous: pick.unambiguous, tiedCount: pick.tiedCount };
}

/** Execute the resolved row's action and verify the effect. */
async function executeAndVerify(
  meta: ProviderTrack,
  trackId: string,
  zone: Zone,
  when: "now" | "next" | "queue",
): Promise<ToolResult> {
  const browse = roonConnection.getBrowse();
  const sessionKey = newSessionKey();
  const log = (step: string, data: unknown) =>
    console.error(`[roon-bridge] playById[${sessionKey}] ${step}:`, JSON.stringify(data));

  const identity: TrackIdentity = { title: meta.title, artist: meta.artist, album: meta.album, trackNumber: meta.trackNumber };
  const resolved = await resolveRoonRow(browse, identity, zone.zone_id, sessionKey, log);
  if ("error" in resolved) {
    return jsonResult({ ok: false, error: resolved.error, detail: resolved.detail, track_id: trackId, requested: identity }, true);
  }

  const drilled = await drillToActions(browse, resolved.itemKey, zone.zone_id, sessionKey);
  if (drilled.message) return jsonResult({ ok: false, error: "message", detail: drilled.message, matched: meta.title }, true);
  if (drilled.error) return jsonResult({ ok: false, error: drilled.error, matched: meta.title }, true);

  const intent = WHEN_TO_INTENT[when];
  const action = resolveActionItem(drilled.actionItems, intent);
  if (!action?.item.item_key) {
    return jsonResult(
      {
        ok: false,
        error: "no_action",
        detail: `No '${intent}' action for "${meta.title}".`,
        available_actions: drilled.actionItems.filter((i) => i.hint !== "header").map((i) => i.title),
      },
      true,
    );
  }

  // Snapshot the queue before (skip for 'now', which replaces playback).
  const verifyAdd = when !== "now";
  let beforeIds = new Set<number>();
  let beforeCount = 0;
  if (verifyAdd) {
    try {
      const pre = await roonConnection.getQueueSnapshot(zone);
      beforeIds = new Set(pre.map((i) => i.queue_item_id));
      beforeCount = pre.length;
    } catch {
      beforeIds = new Set();
    }
  }

  const exec = await promisifyBrowse(browse, {
    hierarchy: "search",
    item_key: action.item.item_key,
    zone_or_output_id: zone.zone_id,
    multi_session_key: sessionKey,
  });
  if (exec.error) return jsonResult({ ok: false, error: String(exec.error), matched: meta.title }, true);

  // Best-effort auto_radio off, matching the other play/queue paths.
  try {
    const transport = roonConnection.getTransport();
    await new Promise<void>((resolve) => transport.change_settings(zone, { auto_radio: false }, () => resolve()));
  } catch {
    /* non-critical */
  }

  const matched = {
    track_id: trackId,
    title: meta.title,
    artist: meta.artist,
    album: meta.album ?? null,
    track_number: meta.trackNumber ?? null,
    resolved_via: resolved.via,
    unambiguous: resolved.unambiguous,
  };

  if (!verifyAdd) {
    // Verify now-playing flipped to our title (bounded poll).
    let nowOk = false;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const z = roonConnection.findZone(zone.zone_id);
      const np = z?.now_playing?.three_line?.line1;
      if (np && normalizeTitle(np) === normalizeTitle(meta.title)) { nowOk = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    return jsonResult({ ok: true, action: action.matched, when, matched, verified: nowOk, zone: zone.display_name });
  }

  // Verify by re-reading the queue until it grows (bounded poll).
  let landed = false;
  let afterCount = beforeCount;
  const deadline = Date.now() + 2500;
  try {
    while (Date.now() < deadline) {
      const after = await roonConnection.getQueueSnapshot(zone);
      afterCount = after.length;
      if (after.length > beforeCount || after.some((i) => !beforeIds.has(i.queue_item_id))) { landed = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch {
    return jsonResult({ ok: true, action: action.matched, when, matched, verified: false, note: "queue growth could not be verified", zone: zone.display_name });
  }

  if (!landed) {
    return jsonResult(
      {
        ok: false,
        error: "add_not_verified",
        detail: `The action reported success but "${meta.title}" did not appear in the queue.`,
        matched,
        action: action.matched,
        queue_count_before: beforeCount,
        queue_count_after: afterCount,
        zone: zone.display_name,
      },
      true,
    );
  }

  return jsonResult({ ok: true, action: action.matched, when, matched, verified: true, queue_count_before: beforeCount, queue_count_after: afterCount, zone: zone.display_name });
}

async function queueOrPlayById(
  trackId: string,
  provider: ProviderName | undefined,
  zoneName: string,
  when: "now" | "next" | "queue",
): Promise<ToolResult> {
  try {
    const zone = roonConnection.findZoneOrThrow(zoneName);
    let meta: ProviderTrack;
    try {
      meta = await initProviders().get(provider).getTrack(trackId);
    } catch (e) {
      return jsonResult({ ok: false, error: "provider_lookup_failed", detail: e instanceof Error ? e.message : String(e), track_id: trackId }, true);
    }
    if (!meta.title || !meta.artist) {
      return jsonResult({ ok: false, error: "incomplete_track", detail: `Provider returned no title/artist for id ${trackId}.`, track_id: trackId }, true);
    }
    return await executeAndVerify(meta, trackId, zone, when);
  } catch (e) {
    return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerPlayByIdTools(server: McpServer): void {
  if (process.env.PLAYLIST_TOOLS === "0") return; // shares the provider layer

  const trackIdArg = z.string().describe("Provider track ID from search_tracks / find_versions (e.g. a Qobuz track id).");
  const providerArg = z.enum(["qobuz", "tidal"]).optional().describe("Music provider; defaults to the configured default.");
  const zoneArg = z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted).");

  server.tool(
    "queue_by_id",
    "Queue the EXACT track identified by a provider track ID (from search_tracks), bypassing fuzzy name search. Resolves the ID to authoritative title/artist/album, pins the exact Roon recording (artist-scoped, album-disambiguated - solves the same-artist/two-albums case that queue_version refuses), runs the action, and verifies the queue actually grew. when: 'queue' adds to end (default), 'next' plays after current, 'now' plays immediately.",
    {
      track_id: trackIdArg,
      provider: providerArg,
      zone: zoneArg,
      when: z.enum(["queue", "next", "now"]).default("queue").describe("'queue' adds to end (default); 'next' after current; 'now' immediately."),
    },
    async ({ track_id, provider, zone, when }) => queueOrPlayById(track_id, provider, zone, when ?? "queue"),
  );

  server.tool(
    "play_by_id",
    "Play the EXACT track identified by a provider track ID (from search_tracks) immediately, bypassing fuzzy name search. Same deterministic ID->exact-recording resolution as queue_by_id; defaults to playing now. Use when='next'/'queue' to enqueue instead.",
    {
      track_id: trackIdArg,
      provider: providerArg,
      zone: zoneArg,
      when: z.enum(["now", "next", "queue"]).default("now").describe("'now' plays immediately (default); 'next' after current; 'queue' adds to end."),
    },
    async ({ track_id, provider, zone, when }) => queueOrPlayById(track_id, provider, zone, when ?? "now"),
  );
}
