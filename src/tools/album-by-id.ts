/**
 * album-by-id: DETERMINISTIC play/queue an ALBUM by provider (Qobuz) album ID.
 *
 * The album counterpart of play-by-id.ts's track resolution. `play_album` /
 * `queue_playlist` (browse.ts) resolve albums through Roon's fuzzy NAME search
 * and pick a scored top-1 - the same "Gas instead of Spoon" mechanism that
 * affects tracks. This gives Maya the two-step deterministic album flow:
 * search_albums (fuzzy, safe, provider-side, no Roon mutation) -> confirm ->
 * play_album_by_id / queue_album_by_id (exact, provider id -> pinned Roon row).
 *
 * Resolution mirrors play-by-id.ts's Path B (album-anchored) MINUS bestMatch:
 *   1. provider.getAlbum(id) -> { title, artist, year }  (authoritative)
 *   2. Roon search "<artist> <title>", Albums category, pin the EXACT row via
 *      pickAlbumRow (normalized title equality, then artist, then year) -
 *      never a fuzzy word-score top-1 guess.
 *   3. Drill to the album's action list and execute when=now|next|queue.
 *   4. Verify: for a play, now-playing must flip; when the album field is
 *      observable it must also match the requested album. For a queue add,
 *      the queue must grow.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import { initProviders } from "../providers/bootstrap.js";
import type { ProviderName, ProviderAlbum } from "../providers/types.js";
import type { Zone } from "node-roon-api-transport";
import type RoonApiBrowse from "node-roon-api-browse";
import { resultingState, immediateBool } from "./resulting-state.js";
import {
  newSessionKey,
  browseAndLoad,
  promisifyBrowse,
  promisifyLoad,
  normalizeTitle,
  pickAlbumRow,
  resolveActionItem,
  waitForStableQueue,
  type BrowseItem,
  type AlbumIdentity,
  type QueueAction,
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

interface ResolvedAlbumRow {
  itemKey: string;
  unambiguous: boolean;
  tiedCount: number;
}

/**
 * Resolve a provider album identity to a single Roon "Albums" browse
 * item_key, deterministically. No bestMatch fallback: an ambiguous or
 * not-found pin fails honestly rather than guessing.
 */
async function resolveAlbumRow(
  browse: RoonApiBrowse,
  identity: AlbumIdentity,
  zoneId: string | undefined,
  sessionKey: string,
  log: (step: string, data: unknown) => void,
): Promise<ResolvedAlbumRow | { error: string; detail?: string }> {
  const albumQuery = `${identity.artist} ${identity.title}`.trim();
  const search = await browseAndLoad(browse, {
    hierarchy: "search",
    input: albumQuery,
    pop_all: true,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (search.error) return { error: "search_error", detail: search.error };
  if (!search.items?.length) return { error: "album_not_found", detail: `No results for "${albumQuery}".` };

  const albumsCat =
    search.items.find((i) => i.item_key && i.title.toLowerCase() === "albums") ||
    search.items.find((i) => i.item_key && i.title.toLowerCase().includes("album"));
  if (!albumsCat?.item_key) return { error: "album_not_found", detail: `No album category for "${albumQuery}".` };

  const albumList = await browseAndLoad(browse, {
    hierarchy: "search",
    item_key: albumsCat.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (albumList.error || !albumList.items?.length) {
    return { error: "album_not_found", detail: `No albums listed for "${albumQuery}".` };
  }

  const pick = pickAlbumRow(albumList.items, identity);
  log("album-pick", { matched: pick?.item.title, unambiguous: pick?.unambiguous, tied: pick?.tiedCount });
  if (!pick) {
    return { error: "album_not_found", detail: `No exact title match for "${identity.title}" by ${identity.artist}.` };
  }
  return { itemKey: pick.item.item_key!, unambiguous: pick.unambiguous, tiedCount: pick.tiedCount };
}

const MAX_NAV_DEPTH = 3;

/**
 * Drill a matched album item's browse node down to its action list. Albums
 * resolve to an action list in one hop in the common case; the shallow loop
 * covers the rare popup-then-list shape without the track-level same-
 * recording disambiguation play-by-id.ts needs (an album has no live/studio
 * variant split to resolve).
 */
async function drillToAlbumActions(
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
  for (let depth = 0; depth < MAX_NAV_DEPTH; depth++) {
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

export type ExecResult = { ok: boolean } & Record<string, unknown>;

/**
 * Fire a resolved action item and, if Roon responds with a nested submenu
 * instead of executing directly, drill one level further and click the
 * matching leaf action there.
 *
 * ROOT CAUSE of the silent no-op this closes: browsing an Albums-category row
 * sometimes lands on the quick action popup (leaf items, hint:"action" -
 * clicking one executes immediately), but sometimes lands on the album's full
 * detail page instead, whose only action-shaped entry is a wrapper like "Play
 * Album" (see browse.ts's `isAlbumPage` split, and `executeQueueAction`'s
 * "step 7b parity" comment, which already does this for the artist-queue
 * path). Executing that wrapper returns `action: "list"` - a confirm/choice
 * submenu (Play Now / Shuffle / Start Radio, or a queue-position choice) -
 * NOT the actual play/queue effect. The old code treated `exec.error == null`
 * as "done" and moved straight to verification, so it silently opened a
 * submenu, never clicked the real leaf action inside it, and then correctly
 * observed nothing had changed - reported as "not verified" / `add_not_verified`
 * while the zone stayed exactly as it started. Track-level execute
 * (play-by-id.ts) never needed this: a Tracks-category row's action popup is
 * always leaf actions directly, with no "Play Album"-style wrapper level.
 */
/**
 * A real album's action chain can nest MORE than one "list" response deep -
 * e.g. an album detail page's "Play Album" wrapper opens its OWN Play
 * Now/Add Next/Queue submenu, so one click lands on a list, a second click
 * lands on ANOTHER list, and only the third actually executes. Loop on
 * `action === "list"` (bounded) until a terminal response or no further
 * matching leaf is found, rather than assuming exactly one level of nesting.
 */
const MAX_SUBMENU_DEPTH = 3;

async function execWithSubmenu(
  browse: RoonApiBrowse,
  itemKey: string,
  itemHint: string | null | undefined,
  zoneId: string | undefined,
  sessionKey: string,
  intent: QueueAction,
): Promise<{ error: false | string; body: Awaited<ReturnType<typeof promisifyBrowse>>["body"] }> {
  const trace = (step: string, data: unknown) =>
    console.error(`[roon-bridge] execWithSubmenu[${sessionKey}] ${step}:`, JSON.stringify(data));
  let exec = await promisifyBrowse(browse, {
    hierarchy: "search",
    item_key: itemKey,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  trace("click-0", { hint: itemHint, error: exec.error, action: exec.body?.action, list: exec.body?.list });
  if (exec.error) return exec;
  // hint:"action" is a true Roon leaf - once clicked, it has fired, full stop,
  // no matter what the response body looks like afterward (Roon sometimes
  // echoes back a content list as post-action UI feedback, e.g. the album
  // page again after a real Queue click - that is NOT a further choice to
  // make, and re-drilling it double-fires the action). Only hint:"action_list"
  // (a genuine wrapper/container) warrants looking for a nested leaf to click.
  let lastHint = itemHint;

  for (let depth = 1; depth <= MAX_SUBMENU_DEPTH && lastHint === "action_list" && exec.body.action === "list" && exec.body.list; depth++) {
    const sub = await promisifyLoad(browse, { hierarchy: "search", multi_session_key: sessionKey, count: 20 });
    trace(`submenu-loaded-${depth}`, { error: sub.error, items: sub.body?.items?.map((i) => ({ title: i.title, hint: i.hint })) });
    if (sub.error || !sub.body.items?.length) break;

    const subAction = resolveActionItem(sub.body.items, intent);
    trace(`submenu-matched-${depth}`, { intent, matched: subAction?.item ? { title: subAction.item.title, hint: subAction.item.hint } : null });
    if (!subAction?.item.item_key) break;

    exec = await promisifyBrowse(browse, {
      hierarchy: "search",
      item_key: subAction.item.item_key,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    lastHint = subAction.item.hint;
    trace(`click-${depth}`, { hint: lastHint, error: exec.error, action: exec.body?.action, list: exec.body?.list });
    if (exec.error) return exec;
  }
  return exec;
}

/**
 * Resolve an AlbumIdentity to its exact Roon row, execute the `when` action,
 * and verify the effect. Mirrors play-by-id.ts's executeIdentity, scoped to
 * albums (no queue-provenance recording - that map is track-shaped).
 */
export async function executeAlbumIdentity(
  identity: AlbumIdentity,
  zone: Zone,
  when: "now" | "next" | "queue",
  opts: { albumId?: string; provider?: ProviderName } = {},
): Promise<ExecResult> {
  const albumId = opts.albumId ?? null;
  const browse = roonConnection.getBrowse();
  const sessionKey = newSessionKey();
  const log = (step: string, data: unknown) =>
    console.error(`[roon-bridge] albumById[${sessionKey}] ${step}:`, JSON.stringify(data));

  const resolved = await resolveAlbumRow(browse, identity, zone.zone_id, sessionKey, log);
  if ("error" in resolved) {
    return { ok: false, error: resolved.error, detail: resolved.detail, album_id: albumId, requested: identity };
  }

  const drilled = await drillToAlbumActions(browse, resolved.itemKey, zone.zone_id, sessionKey);
  if (drilled.message) return { ok: false, error: "message", detail: drilled.message, matched: identity.title };
  if (drilled.error) return { ok: false, error: drilled.error, matched: identity.title };
  log("drilled-actionItems", drilled.actionItems.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })));

  const intent = WHEN_TO_INTENT[when];
  const action = resolveActionItem(drilled.actionItems, intent);
  log("resolved-action", { intent, matched: action?.item ? { title: action.item.title, hint: action.item.hint } : null });
  if (!action?.item.item_key) {
    return {
      ok: false,
      error: "no_action",
      detail: `No '${intent}' action for "${identity.title}".`,
      available_actions: drilled.actionItems.filter((i) => i.hint !== "header").map((i) => i.title),
    };
  }

  const matched = {
    album_id: albumId,
    title: identity.title,
    artist: identity.artist,
    year: identity.year ?? null,
    unambiguous: resolved.unambiguous,
  };

  if (when !== "now") {
    // Verify the WHOLE album landed, not just that the queue grew. A
    // growth-only check (queue length > before, or any new item id) reports
    // success even when Roon under-commits the album - only some tracks land
    // (the BUG-C under-add). Snapshot before, execute, wait for the queue to
    // SETTLE (no change for quietMs, mirroring the old queueAlbum path), and
    // count the tracks that actually landed against the album's real track
    // count (identity.expectedTrackCount, from the provider). No expected
    // count available -> fall back to the old growth-only honesty (>0 lands).
    let beforeIds = new Set<number>();
    let beforeCount = 0;
    try {
      const pre = await roonConnection.getQueueSnapshot(zone);
      beforeIds = new Set(pre.map((i) => i.queue_item_id));
      beforeCount = pre.length;
    } catch {
      /* fall through with an empty before-set */
    }

    const exec = await execWithSubmenu(browse, action.item.item_key, action.item.hint, zone.zone_id, sessionKey, intent);
    if (exec.error) return { ok: false, error: String(exec.error), matched: identity.title };
    await autoRadioOff(zone);

    let tracksAdded = 0;
    let afterCount = beforeCount;
    try {
      const after = await waitForStableQueue(() => roonConnection.getQueueSnapshot(zone), { quietMs: 300, deadlineMs: 12000 });
      const newItems = after.filter((i) => !beforeIds.has(i.queue_item_id));
      tracksAdded = Math.max(newItems.length, after.length - beforeCount);
      afterCount = after.length;
    } catch (verifyErr) {
      return {
        ok: false,
        error: "add_not_verified",
        detail: `The action reported success but the queue for "${identity.title}" could not be verified: ${String(verifyErr)}.`,
        matched,
        action: action.matched,
        queue_count_before: beforeCount,
        zone: zone.display_name,
      };
    }

    const expected = identity.expectedTrackCount ?? 0;
    const full = expected > 0 ? tracksAdded >= expected : tracksAdded > 0;

    if (!full) {
      return {
        ok: false,
        error: "album_under_added",
        detail: `Only ${tracksAdded} of ${expected || "?"} track(s) from "${identity.title}" landed in the queue.`,
        matched,
        action: action.matched,
        tracks_added: tracksAdded,
        tracks_expected: expected || null,
        queue_count_before: beforeCount,
        queue_count_after: afterCount,
        zone: zone.display_name,
      };
    }

    return {
      ok: true,
      action: action.matched,
      when,
      matched,
      verified: true,
      tracks_added: tracksAdded,
      tracks_expected: expected || null,
      queue_count_before: beforeCount,
      queue_count_after: afterCount,
      zone: zone.display_name,
    };
  }

  // when === "now": capture what is playing before, execute, then verify
  // now-playing flipped - and, when the album field is observable, that it
  // matches the requested album (a stronger check than the browse play_album
  // path can do, since that path never has authoritative album metadata).
  const beforeNP = roonConnection.findZone(zone.zone_id)?.now_playing?.three_line?.line1 ?? null;

  const exec = await execWithSubmenu(browse, action.item.item_key, action.item.hint, zone.zone_id, sessionKey, intent);
  if (exec.error) return { ok: false, error: String(exec.error), matched: identity.title };
  await autoRadioOff(zone);

  let landedTitle: string | null = null;
  let landedAlbum: string | null = null;
  let verified = false;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const z = roonConnection.findZone(zone.zone_id);
    const np = z?.now_playing;
    const title = np?.three_line?.line1 ?? null;
    const album = np?.three_line?.line3 ?? null;
    if (title != null) { landedTitle = title; landedAlbum = album ?? null; }
    const playing = z?.state === "playing" || z?.state === "loading" || z?.state == null;
    if (title != null && title !== beforeNP && playing) { verified = true; break; }
    await new Promise((r) => setTimeout(r, 150));
  }

  const albumMismatch =
    verified && landedAlbum != null && normalizeTitle(landedAlbum) !== normalizeTitle(identity.title);
  if (albumMismatch) {
    return {
      ok: false,
      error: "wrong_album_played",
      detail: `Expected album "${identity.title}" but "${landedAlbum}" started playing.`,
      matched,
      queued_title: landedTitle,
      queued_album: landedAlbum,
      zone: zone.display_name,
    };
  }

  if (!verified) {
    return {
      ok: true,
      warning: `WARNING - not verified: "${identity.title}" was accepted for play in zone '${zone.display_name}', but now-playing did not flip to confirm it. Confirm with now_playing.`,
      action: action.matched,
      when,
      matched,
      verified: false,
      queued_title: landedTitle,
      zone: zone.display_name,
    };
  }

  return {
    ok: true,
    action: action.matched,
    when,
    matched,
    verified: true,
    queued_title: landedTitle,
    queued_album: landedAlbum,
    zone: zone.display_name,
  };
}

async function autoRadioOff(zone: Zone): Promise<void> {
  try {
    const transport = roonConnection.getTransport();
    await new Promise<void>((resolve) => transport.change_settings(zone, { auto_radio: false }, () => resolve()));
  } catch {
    /* non-critical */
  }
}

/**
 * Resolve a provider album id to authoritative metadata, then execute+verify.
 * The deterministic entry point shared by the MCP tools.
 */
export async function executeAlbumById(
  albumId: string,
  provider: ProviderName | undefined,
  zone: Zone,
  when: "now" | "next" | "queue",
): Promise<ExecResult> {
  let meta: ProviderAlbum;
  try {
    meta = await initProviders().get(provider).getAlbum(albumId);
  } catch (e) {
    return { ok: false, error: "provider_lookup_failed", detail: e instanceof Error ? e.message : String(e), album_id: albumId };
  }
  if (!meta.title || !meta.artist) {
    return { ok: false, error: "incomplete_album", detail: `Provider returned no title/artist for album id ${albumId}.`, album_id: albumId };
  }
  const identity: AlbumIdentity = {
    title: meta.title,
    artist: meta.artist,
    year: meta.year,
    expectedTrackCount: meta.trackCount > 0 ? meta.trackCount : undefined,
  };
  return executeAlbumIdentity(identity, zone, when, { albumId, provider: meta.provider ?? provider });
}

export async function playOrQueueAlbumById(
  albumId: string,
  provider: ProviderName | undefined,
  zoneName: string,
  when: "now" | "next" | "queue",
): Promise<ToolResult> {
  try {
    const zone = roonConnection.findZoneOrThrow(zoneName);
    const result = await executeAlbumById(albumId, provider, zone, when);
    const resulting_state = await resultingState(zone);
    const { warning, ...rest } = result as ExecResult & { warning?: string };
    if (warning) {
      return {
        content: [{ type: "text", text: `${warning}\n${JSON.stringify({ ...rest, resulting_state }, null, 2)}` }],
        isError: !result.ok,
      };
    }
    return jsonResult({ ...result, resulting_state }, !result.ok);
  } catch (e) {
    return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerAlbumByIdTools(server: McpServer): void {
  if (process.env.PLAYLIST_TOOLS === "0") return; // shares the provider layer

  const providerArg = z.enum(["qobuz", "tidal"]).optional().describe("Music provider; defaults to the configured default.");
  const albumIdArg = z.string().describe("Provider album ID from search_albums (e.g. a Qobuz album id).");
  const zoneArg = z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted).");
  const immediateArg = immediateBool
    .optional()
    .default(false)
    .describe(
      "Interrupt/replace the currently-playing track RIGHT NOW. Default false = never cut the current track. Prefer when:\"replace\" for the same effect without a boolean.",
    );

  server.tool(
    "search_albums",
    "Search a music provider for albums. Returns each album's ID plus artist, year, track count, explicit flag, and hi-res availability. Feed an ID to play_album_by_id / queue_album_by_id to play/queue the EXACT album (pinned by title+artist+year, never a fuzzy name guess) - the deterministic counterpart to play_album.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().int().positive().max(50).optional().describe("Max results (default 10)"),
      provider: providerArg,
    },
    async ({ query, limit, provider }) => {
      try {
        const p = initProviders().get(provider);
        const albums = await p.searchAlbums(query, limit ?? 10);
        if (albums.length === 0) return { content: [{ type: "text", text: `No albums found for "${query}".` }] };
        return {
          content: [{
            type: "text",
            text:
              `Albums for "${query}":\n` +
              albums
                .map((a) => {
                  const flags: string[] = [];
                  if (a.year) flags.push(String(a.year));
                  if (a.explicit) flags.push("explicit");
                  if (a.hires) flags.push("hi-res");
                  flags.push(`${a.trackCount} tracks`);
                  return `  ID: ${a.id} | ${a.title} - ${a.artist} (${flags.join(", ")})`;
                })
                .join("\n"),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }], isError: true };
      }
    },
  );

  server.tool(
    "play_album_by_id",
    "Play the EXACT album identified by a provider album ID (from search_albums), bypassing fuzzy name search. Resolves the ID to authoritative title/artist/year, pins the exact Roon album row (title+artist+year, never a fuzzy top-1 guess), runs the action, and verifies now-playing flipped (and, when observable, that the album field matches). SAFE DEFAULT: does NOT cut the current track - it plays after current (when='next', default). when='replace' plays it RIGHT NOW, replacing the queue (immediate:true is the legacy equivalent). Use when='queue' to append instead.",
    {
      album_id: albumIdArg,
      provider: providerArg,
      zone: zoneArg,
      immediate: immediateArg,
      when: z.enum(["next", "queue", "replace"]).default("next").describe("Placement: 'next' after current (default); 'queue' adds to end; 'replace' interrupts and replaces the queue RIGHT NOW. Ignored when immediate:true (which forces replace)."),
    },
    async ({ album_id, provider, zone, immediate, when }) =>
      playOrQueueAlbumById(album_id, provider, zone, (immediate || when === "replace") ? "now" : (when === "queue" ? "queue" : "next")),
  );

  server.tool(
    "queue_album_by_id",
    "Queue the EXACT album identified by a provider album ID (from search_albums), bypassing fuzzy name search. Same deterministic ID -> exact-album resolution as play_album_by_id. SAFE DEFAULT: never cuts the current track. when:'queue' adds to end (default), 'next' plays after current, 'replace' interrupts now and replaces the queue with this album (immediate:true is the legacy equivalent).",
    {
      album_id: albumIdArg,
      provider: providerArg,
      zone: zoneArg,
      immediate: immediateArg,
      when: z.enum(["queue", "next", "replace"]).default("queue").describe("Placement: 'queue' adds to end (default), 'next' plays after current, 'replace' interrupts now and replaces the queue with this album. Ignored when immediate:true (which forces replace)."),
    },
    async ({ album_id, provider, zone, immediate, when }) =>
      playOrQueueAlbumById(album_id, provider, zone, (immediate || when === "replace") ? "now" : (when === "next" ? "next" : "queue")),
  );
}
