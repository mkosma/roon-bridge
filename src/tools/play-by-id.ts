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
import type { Zone, QueueItem } from "node-roon-api-transport";
import type RoonApiBrowse from "node-roon-api-browse";
import { deferredPlayer } from "../control/deferred-player-instance.js";
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
  classifyVariant,
  waitForStableQueue,
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

  const identity: TrackIdentity = { title: meta.title, artist: meta.artist, album: meta.album, trackNumber: meta.trackNumber, version: meta.version, durationSec: meta.durationSec };
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

  // Whether the provider id denotes a live recording. Used to read back the
  // landed row and refuse a silent live/studio swap (BUG A safety net): even if
  // the resolver picked right, the RETURN must reflect what actually landed.
  const intendedLive = classifyVariant(meta.title).is_live || /\blive\b/i.test(meta.version ?? "");
  const recordingMismatch = (landedTitle: string | null): boolean =>
    !!landedTitle && classifyVariant(landedTitle).is_live !== intendedLive;

  if (!verifyAdd) {
    // Verify now-playing flipped to our title (bounded poll).
    let nowOk = false;
    let landedTitle: string | null = null;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const z = roonConnection.findZone(zone.zone_id);
      const np = z?.now_playing?.three_line?.line1;
      if (np) landedTitle = np;
      if (np && normalizeTitle(np) === normalizeTitle(meta.title)) { nowOk = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (recordingMismatch(landedTitle)) {
      return jsonResult(
        { ok: false, error: "wrong_recording_queued", detail: `Expected ${intendedLive ? "a live" : "the studio"} recording of "${meta.title}" but "${landedTitle}" played.`, matched, queued_title: landedTitle, zone: zone.display_name },
        true,
      );
    }
    return jsonResult({ ok: true, action: action.matched, when, matched, verified: nowOk, queued_title: landedTitle, zone: zone.display_name });
  }

  // Verify by re-reading the queue until our track appears (bounded poll).
  //
  // Robustness to a CONCURRENT NATURAL ADVANCE (the root cause of the lone
  // queue_by_id ok=False seen 2026-06-20): if the current track ends between the
  // add and the re-read, Roon consumes the played head item, so the queue length
  // need not grow (one added, one consumed = net zero). A bare length-grew test
  // then false-negatives a real success. So we treat the add as landed on EITHER
  // signal that does not depend on net length:
  //   - a queue_item_id appears that was not present before (the added row), OR
  //   - now-playing flipped to our title (an 'Add Next' track whose current
  //     track just ended and which therefore started playing - it leaves the
  //     queue's "upcoming" set as it becomes the head).
  let landed = false;
  let afterCount = beforeCount;
  let landedTitle: string | null = null;
  const wantTitle = normalizeTitle(meta.title);
  const deadline = Date.now() + 2500;
  try {
    while (Date.now() < deadline) {
      const after = await roonConnection.getQueueSnapshot(zone);
      afterCount = after.length;
      const newRow = after.find((i) => !beforeIds.has(i.queue_item_id));
      if (newRow) landedTitle = queueRowTitle(newRow);
      const np = roonConnection.findZone(zone.zone_id)?.now_playing?.three_line?.line1;
      const nowPlayingFlipped = !!np && normalizeTitle(np) === wantTitle;
      if (nowPlayingFlipped && !landedTitle) landedTitle = np!;
      if (after.length > beforeCount || newRow || nowPlayingFlipped) { landed = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch {
    return jsonResult({ ok: true, action: action.matched, when, matched, verified: false, note: "queue growth could not be verified", zone: zone.display_name });
  }

  if (recordingMismatch(landedTitle)) {
    return jsonResult(
      { ok: false, error: "wrong_recording_queued", detail: `Expected ${intendedLive ? "a live" : "the studio"} recording of "${meta.title}" but "${landedTitle}" landed in the queue.`, matched, queued_title: landedTitle, queue_count_before: beforeCount, queue_count_after: afterCount, zone: zone.display_name },
      true,
    );
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

  return jsonResult({ ok: true, action: action.matched, when, matched, verified: true, queued_title: landedTitle, queue_count_before: beforeCount, queue_count_after: afterCount, zone: zone.display_name });
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

// ===========================================================================
// Batch enqueue: queue_tracks / play_tracks - an ORDERED set in one call.
//
// Platform reality (same constraints queue.ts documents): Roon exposes only
// three queue mutators to an extension - "Add Next" (insert right after the
// current track), "Queue" (append to the tail), and transport play_from_here
// (jump). There is NO insert-at-position and NO move. So an ordered set is built
// from the ONE race-free, forward-ordered primitive Roon has - APPEND-TO-TAIL:
// each "Queue" action appends after the previous one, and a track boundary never
// reorders the tail. That guarantees the SET's internal order absolutely.
//
// Positioning per `when` is then layered on top of that ordered build:
//   - 'queue'         : leave the block at the tail.                 [cur, ...prior, block]
//   - 'now'           : Play Now the first track (replaces the queue), then append
//                       the rest to the tail in order.                [block] (plays block[0])
//   - 'after_current' : arm the DeferredPlayer; at the REAL track seam run the
//                       same now-sequence (re-resolved fresh, since item_keys go
//                       stale by the seam). Prior queue discarded, mirroring
//                       play_album/play_track after_current.
//   - 'next'          : place the block immediately after the current track.
//
// 'next' is the one case the append-to-tail primitive cannot position alone:
// [cur, block, ...prior] requires inserting BETWEEN current and the existing
// upcoming items, and Roon's only after-current primitive is "Add Next", which
// inserts immediately-after-current (LIFO) - so a forward set needs reverse
// Add-Next calls. That is exactly the racy reverse-next pattern that scrambled
// Maya's set on 2026-06-20, so it is used ONLY when it is safe:
//   - upcoming queue empty  -> append-to-tail forward IS [cur, block]. Race-free.
//   - prior present + the current track has ample time left (>= SAFE_REVERSE_MS)
//     -> reverse Add-Next from PRE-RESOLVED rows (a single guarded burst, not the
//        naive per-call-search pattern), then VERIFY the order landed.
//   - prior present + current near its boundary -> do NOT risk a scramble; fall
//     back to ordered tail-append (contiguous, in order, no reversal / split /
//     pull-to-front) and report the anchor honestly.
// See HANDBACK for the precise guarantee and the spec tension this resolves.
// ===========================================================================

/** Headroom the current track must have left to attempt a reverse Add-Next for
 *  'next' with a non-empty upcoming queue. Pre-resolved execs are fast; this is
 *  a generous margin so a boundary cannot land mid-burst. */
const SAFE_REVERSE_MS = 8000;

interface ResolvedTrack {
  index: number;
  trackId: string;
  meta: ProviderTrack;
  actionItems: BrowseItem[];
  sessionKey: string;
  resolvedVia: ResolvedRow["via"];
  unambiguous: boolean;
}
interface FailedTrack {
  index: number;
  trackId: string;
  reason: string;
  detail?: string;
}
type TrackOutcome = ResolvedTrack | FailedTrack;

function isResolved(o: TrackOutcome): o is ResolvedTrack {
  return (o as ResolvedTrack).meta !== undefined;
}

/** Resolve ONE provider track id to its drilled action list (read-only; no
 *  queue mutation). Reuses the exact-ID resolver queue_by_id uses. */
async function resolveOneForBatch(
  browse: RoonApiBrowse,
  trackId: string,
  index: number,
  provider: ProviderName | undefined,
  zone: Zone,
): Promise<TrackOutcome> {
  const sessionKey = newSessionKey();
  const log = (step: string, data: unknown) =>
    console.error(`[roon-bridge] queueTracks[${sessionKey}] ${step}:`, JSON.stringify(data));
  let meta: ProviderTrack;
  try {
    meta = await initProviders().get(provider).getTrack(trackId);
  } catch (e) {
    return { index, trackId, reason: "provider_lookup_failed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!meta.title || !meta.artist) {
    return { index, trackId, reason: "incomplete_track", detail: `Provider returned no title/artist for id ${trackId}.` };
  }
  const identity: TrackIdentity = { title: meta.title, artist: meta.artist, album: meta.album, trackNumber: meta.trackNumber, version: meta.version, durationSec: meta.durationSec };
  const resolved = await resolveRoonRow(browse, identity, zone.zone_id, sessionKey, log);
  if ("error" in resolved) {
    return { index, trackId, reason: resolved.error, detail: resolved.detail };
  }
  const drilled = await drillToActions(browse, resolved.itemKey, zone.zone_id, sessionKey);
  if (drilled.message) return { index, trackId, reason: "message", detail: drilled.message };
  if (drilled.error) return { index, trackId, reason: drilled.error };
  return {
    index,
    trackId,
    meta,
    actionItems: drilled.actionItems,
    sessionKey,
    resolvedVia: resolved.via,
    unambiguous: resolved.unambiguous,
  };
}

/** Execute one resolved track's action for an intent, in its own session. */
async function execTrackAction(
  browse: RoonApiBrowse,
  track: ResolvedTrack,
  zone: Zone,
  intent: QueueAction,
): Promise<{ ok: boolean; action?: string; reason?: string }> {
  const action = resolveActionItem(track.actionItems, intent);
  if (!action?.item.item_key) {
    return { ok: false, reason: `no_${intent}_action` };
  }
  const exec = await promisifyBrowse(browse, {
    hierarchy: "search",
    item_key: action.item.item_key,
    zone_or_output_id: zone.zone_id,
    multi_session_key: track.sessionKey,
  });
  if (exec.error) return { ok: false, reason: String(exec.error) };
  return { ok: true, action: action.matched };
}

/** Best-effort auto_radio off, matching the other play/queue paths. */
async function autoRadioOff(zone: Zone): Promise<void> {
  try {
    const transport = roonConnection.getTransport();
    await new Promise<void>((resolve) => transport.change_settings(zone, { auto_radio: false }, () => resolve()));
  } catch {
    /* non-critical */
  }
}

function queueRowTitle(item: QueueItem): string {
  return item.three_line?.line1 ?? item.two_line?.line1 ?? item.one_line?.line1 ?? "";
}

/** Milliseconds left on the current track (0 if nothing is playing). */
function trackTimeLeftMs(zone: Zone): number {
  const np = zone.now_playing;
  if (zone.state !== "playing" || !np || np.length == null) return 0;
  return Math.max(0, (np.length - (np.seek_position ?? 0)) * 1000);
}

/** Items queued AFTER the current track (the "prior upcoming" set). */
function upcomingCount(items: QueueItem[], zone: Zone): number {
  const playing = zone.state === "playing" || zone.state === "paused" || zone.state === "loading";
  return playing && items.length > 0 ? items.length - 1 : items.length;
}

/**
 * Replace the queue with an ordered set, fresh-resolved at call time. Used by
 * the after_current deferral (item_keys captured at arming go stale by the seam,
 * so we re-resolve) and is the now-sequence's core: Play Now the first
 * resolvable track, then append the rest to the tail in order.
 */
async function runReplaceSequence(
  browse: RoonApiBrowse,
  trackIds: string[],
  provider: ProviderName | undefined,
  zone: Zone,
): Promise<void> {
  let replaced = false;
  for (let i = 0; i < trackIds.length; i++) {
    const t = await resolveOneForBatch(browse, trackIds[i], i, provider, zone);
    if (!isResolved(t)) continue;
    await execTrackAction(browse, t, zone, replaced ? "queue" : "play_now");
    replaced = true;
  }
  await autoRadioOff(zone);
}

interface BlockVerification {
  count_queued: number;
  contiguous: boolean;
  in_order: boolean;
  anchor_ok: boolean;
  first_position: number | null; // 1-based position of the block's first row
}

/**
 * Re-read the queue and verify the resolved set landed as a contiguous, in-order
 * block at the expected anchor. Robust to a concurrent natural advance: the block
 * is identified by queue_item_ids absent from the before-snapshot, so a consumed
 * head never hides it.
 */
async function verifyBlock(
  zone: Zone,
  resolved: ResolvedTrack[],
  beforeIds: Set<number>,
  expectedAnchor: "head" | "after-current" | "tail",
): Promise<BlockVerification> {
  const wantTitles = resolved.map((t) => normalizeTitle(t.meta.title));

  // Judge ONLY a SETTLED queue. A large-queue replace can take Roon several
  // seconds to drain and rebuild; a snapshot taken mid-settle may show a
  // transient full block that then collapses to a partial one. The old verify
  // broke out of its poll the instant it saw >= N rows, which on a large 'now'
  // replace (beforeIds empty -> every row counts as "new") was the FIRST
  // snapshot - so it reported order_verified=true off an unsettled queue and
  // missed real track loss (BUG B). Wait for stability, then count what is
  // actually there.
  let after: QueueItem[];
  try {
    after = await waitForStableQueue(() => roonConnection.getQueueSnapshot(zone), {
      quietMs: 300,
      deadlineMs: 12000,
    });
  } catch {
    return { count_queued: 0, contiguous: false, in_order: false, anchor_ok: false, first_position: null };
  }

  let count_queued: number;
  let positions: number[];

  if (expectedAnchor === "head") {
    // 'now' replaced the queue: beforeIds is empty, so new-id identification is
    // meaningless. The set must be a contiguous, in-order run from the HEAD;
    // count only the prefix that genuinely matches in the settled queue.
    let i = 0;
    while (i < wantTitles.length && i < after.length && normalizeTitle(queueRowTitle(after[i])) === wantTitles[i]) i++;
    count_queued = i;
    positions = Array.from({ length: i }, (_, k) => k);
  } else {
    // 'next' / 'queue': the block is the rows whose ids are absent from the
    // before-snapshot, preserving queue order.
    const newRows = after.filter((q) => !beforeIds.has(q.queue_item_id));
    const gotTitles = newRows.map((r) => normalizeTitle(queueRowTitle(r)));
    let wi = 0;
    for (const g of gotTitles) {
      if (wi < wantTitles.length && g === wantTitles[wi]) wi++;
    }
    count_queued = wi;
    positions = newRows
      .map((r) => after.findIndex((a) => a.queue_item_id === r.queue_item_id))
      .filter((p) => p >= 0)
      .sort((a, b) => a - b);
  }

  const in_order = count_queued === resolved.length;
  const contiguous = positions.length > 0 && positions[positions.length - 1] - positions[0] === positions.length - 1;
  const firstIdx = positions.length ? positions[0] : -1;

  let expectedFirst: number;
  if (expectedAnchor === "head") expectedFirst = 0;
  else if (expectedAnchor === "after-current") expectedFirst = 1;
  else expectedFirst = after.length - positions.length; // tail
  const anchor_ok = firstIdx === expectedFirst;

  return {
    count_queued,
    contiguous,
    in_order,
    anchor_ok,
    first_position: firstIdx >= 0 ? firstIdx + 1 : null,
  };
}

async function queueOrPlayTracks(
  trackIds: string[],
  provider: ProviderName | undefined,
  zoneName: string,
  when: "queue" | "next" | "now" | "after_current",
): Promise<ToolResult> {
  try {
    const zone = roonConnection.findZoneOrThrow(zoneName);
    const browse = roonConnection.getBrowse();

    // 1. Pre-resolve every track IN ORDER (read-only; no queue mutation yet).
    const outcomes: TrackOutcome[] = [];
    for (let i = 0; i < trackIds.length; i++) {
      outcomes.push(await resolveOneForBatch(browse, trackIds[i], i, provider, zone));
    }
    const resolved = outcomes.filter(isResolved);

    const trackStatus = (landedIdx?: Set<number>) =>
      outcomes.map((o) =>
        isResolved(o)
          ? {
              index: o.index,
              track_id: o.trackId,
              ok: landedIdx ? landedIdx.has(o.index) : true,
              title: o.meta.title,
              artist: o.meta.artist,
              album: o.meta.album ?? null,
              resolved_via: o.resolvedVia,
              unambiguous: o.unambiguous,
              ...(landedIdx && !landedIdx.has(o.index) ? { reason: "resolved_but_not_verified_in_queue" } : {}),
            }
          : { index: o.index, track_id: o.trackId, ok: false, reason: o.reason, detail: o.detail },
      );

    if (!resolved.length) {
      return jsonResult(
        {
          ok: false,
          when,
          zone: zone.display_name,
          count_requested: trackIds.length,
          count_queued: 0,
          error: "no_tracks_resolved",
          tracks: trackStatus(),
        },
        true,
      );
    }

    // 2. after_current: arm the deferral and return; the replace runs at the seam.
    if (when === "after_current") {
      const np = zone.now_playing;
      if (zone.state === "playing" && np && np.length != null) {
        deferredPlayer
          .scheduleAfterCurrent(zone, () => runReplaceSequence(browse, trackIds, provider, zone))
          .catch((e: unknown) => console.error("[queueTracks] schedule error:", e));
        return jsonResult({
          ok: true,
          when,
          scheduled: true,
          zone: zone.display_name,
          count_requested: trackIds.length,
          count_queued: resolved.length,
          note: `${resolved.length} track(s) will replace the queue in order when "${np.three_line.line1}" ends (re-resolved at the seam; prior queue discarded).`,
          tracks: trackStatus(),
        });
      }
      // Nothing playing - no seam; fall through to an immediate replace.
      when = "now";
    }

    // An immediate action supersedes any armed deferral.
    deferredPlayer.cancel();

    // Snapshot the queue before mutating (skip the before-ids dependence for
    // 'now', which replaces the queue entirely).
    let beforeIds = new Set<number>();
    let priorCount = 0;
    if (when !== "now") {
      try {
        const pre = await roonConnection.getQueueSnapshot(zone);
        beforeIds = new Set(pre.map((i) => i.queue_item_id));
        priorCount = upcomingCount(pre, zone);
      } catch {
        beforeIds = new Set();
      }
    }

    const landed = new Set<number>();
    let usedReverse = false;
    let strategyNote: string | undefined;

    if (when === "now") {
      const first = await execTrackAction(browse, resolved[0], zone, "play_now");
      if (first.ok) landed.add(resolved[0].index);
      for (let k = 1; k < resolved.length; k++) {
        const r = await execTrackAction(browse, resolved[k], zone, "queue");
        if (r.ok) landed.add(resolved[k].index);
      }
    } else if (when === "queue") {
      for (const t of resolved) {
        const r = await execTrackAction(browse, t, zone, "queue");
        if (r.ok) landed.add(t.index);
      }
    } else {
      // when === "next"
      const timeLeft = trackTimeLeftMs(zone);
      if (priorCount === 0) {
        strategyNote = "empty upcoming queue: appended in order right after the current track";
        for (const t of resolved) {
          const r = await execTrackAction(browse, t, zone, "queue");
          if (r.ok) landed.add(t.index);
        }
      } else if (timeLeft >= SAFE_REVERSE_MS) {
        usedReverse = true;
        strategyNote = "inserted after current via reverse Add-Next from pre-resolved rows";
        for (let k = resolved.length - 1; k >= 0; k--) {
          const r = await execTrackAction(browse, resolved[k], zone, "add_next");
          if (r.ok) landed.add(resolved[k].index);
        }
      } else {
        strategyNote =
          "current track near its boundary with items already queued: appended in order at the tail to avoid a reverse-insert race (Roon exposes no race-free list-insert between current and the upcoming queue)";
        for (const t of resolved) {
          const r = await execTrackAction(browse, t, zone, "queue");
          if (r.ok) landed.add(t.index);
        }
      }
    }

    await autoRadioOff(zone);

    // 3. Verify the block landed contiguous and in order at the expected anchor.
    const anchor: "head" | "after-current" | "tail" =
      when === "now" ? "head" : when === "next" && usedReverse ? "after-current" : "tail";
    const v = await verifyBlock(zone, resolved, beforeIds, anchor);

    // Map verification back to per-track ok: a resolved track is "landed" if the
    // action executed AND the block verification accounts for it. When the whole
    // block verified in order, every resolved+executed track is landed.
    const verifiedIdx = new Set<number>();
    if (v.in_order) {
      for (const t of resolved) if (landed.has(t.index)) verifiedIdx.add(t.index);
    } else {
      // Partial: trust the execute-acks (still honest - reports what we know).
      for (const idx of landed) verifiedIdx.add(idx);
    }

    const ok =
      v.count_queued === trackIds.length && // every REQUESTED track landed (no failures)
      v.contiguous &&
      v.in_order;

    return jsonResult(
      {
        ok,
        when,
        zone: zone.display_name,
        count_requested: trackIds.length,
        count_queued: v.count_queued,
        order_verified: v.in_order,
        contiguous: v.contiguous,
        anchor_ok: v.anchor_ok,
        block_first_position: v.first_position,
        strategy: strategyNote,
        tracks: trackStatus(verifiedIdx),
      },
      !ok,
    );
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

  const trackIdsArg = z
    .array(z.string())
    .min(1)
    .describe("ORDERED list of provider track IDs (from search_tracks / find_versions). The resulting queue preserves this exact order.");

  server.tool(
    "queue_tracks",
    "Queue an ORDERED list of EXACT tracks by provider track ID, in ONE atomic call - the sequenced-set primitive single queue_by_id calls cannot do safely. Each ID is resolved to its exact Roon recording (same deterministic resolver as queue_by_id), then the set is enqueued so it lands CONTIGUOUS and IN THE GIVEN ORDER (built via race-free append-to-tail, never a racy reverse-next). Honest per-track status: a track that fails to resolve is flagged with its index and reason, never silently dropped; the rest still queue in correct relative order (best-effort). when: 'next' (default) places the set right after the current track; 'queue' appends to the end; 'now' replaces and plays from the first; 'after_current' waits for the current track to end (event-driven, robust to pause/seek/skip) then plays the set, discarding the prior queue. Limit: with 'next' and items ALREADY queued after the current track, Roon has no race-free insert-between primitive - if the current track has time left the set is inserted after it (reverse Add-Next, verified), otherwise it is appended in order at the tail; see strategy/anchor fields in the return.",
    {
      track_ids: trackIdsArg,
      provider: providerArg,
      zone: zoneArg,
      when: z
        .enum(["queue", "next", "now", "after_current"])
        .default("next")
        .describe("'next' (default) after current; 'queue' to the end; 'now' replace+play; 'after_current' deferred replace at the track seam."),
    },
    async ({ track_ids, provider, zone, when }) => queueOrPlayTracks(track_ids, provider, zone, when ?? "next"),
  );

  server.tool(
    "play_tracks",
    "Play an ORDERED list of EXACT tracks by provider track ID immediately, in ONE call. Same deterministic ID->exact-recording resolution and ordered, honest-status behavior as queue_tracks; defaults to when='now' (replace the queue and play from the first track, the rest following in order). Use when='next'/'queue'/'after_current' to enqueue instead.",
    {
      track_ids: trackIdsArg,
      provider: providerArg,
      zone: zoneArg,
      when: z
        .enum(["now", "next", "queue", "after_current"])
        .default("now")
        .describe("'now' (default) replace+play from first; 'next' after current; 'queue' to the end; 'after_current' deferred replace at the track seam."),
    },
    async ({ track_ids, provider, zone, when }) => queueOrPlayTracks(track_ids, provider, zone, when ?? "now"),
  );
}
