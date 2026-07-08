/**
 * versions.ts: precise version selection (Maya P0 "studio/library-aware search").
 *
 * The universal Roon search returns many recordings of the same song - the
 * studio cut, live takes, compilation appearances. The scorer in search-core
 * now prefers the studio version by default, but Maya also needs to SEE the
 * candidate versions and queue an EXACT one deterministically, not just trust a
 * fuzzy top match. These two tools deliver that:
 *
 *   - find_versions : read-only. Search and return the ranked candidates with
 *                     enough metadata (title, artist, album-ish subtitle,
 *                     is_live, is_compilation, confidence) to choose. Each
 *                     candidate carries an opaque `ref` token.
 *   - queue_version : take a `ref`, re-resolve it deterministically (exact
 *                     title+subtitle match, never a fresh fuzzy pick), and
 *                     queue/play THAT recording, verified by queue growth.
 *
 * Why a `ref` rather than a raw Roon item_key: browse item_keys are bound to a
 * browse session and expire. The ref encodes the (query, category, title,
 * subtitle) descriptor, so queue_version re-runs the search and selects the row
 * whose title+subtitle match exactly. That is deterministic and survives across
 * separate MCP calls, where a stale item_key would not.
 *
 * Platform note (investigated against node-roon-api-browse): the browse API
 * exposes only title/subtitle/item_key/hint per row - there is NO structured
 * year, format, or library-membership flag, and Roon's Focus filtering is
 * GUI-only (no focus param or hierarchy). So is_live / is_compilation are
 * inferred from text (see classifyVariant), and `source: library` is scoped via
 * Roon's library-only browse hierarchies (albums/artists), which is best-effort
 * and the one behavior to confirm live.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import {
  newSessionKey,
  browseAndLoad,
  searchScoredCandidates,
  resolveActionItem,
  promisifyBrowse,
  stripRoonLinks,
  looksInstrumental,
  type ScoredCandidate,
  type QueueAction,
} from "./search-core.js";
import type { Zone } from "node-roon-api-transport";
import type RoonApiBrowse from "node-roon-api-browse";
import { resultingState, immediateBool } from "./resulting-state.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/** A durable descriptor for one recording, encoded into the candidate `ref`. */
interface VersionRef {
  q: string; // original query
  c?: string; // category
  t: string; // exact title
  s: string; // exact subtitle (artist / album)
  src: "library" | "all";
}

export function encodeRef(ref: VersionRef): string {
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeRef(token: string): VersionRef | null {
  try {
    const obj = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (obj && typeof obj.t === "string" && typeof obj.s === "string") return obj as VersionRef;
    return null;
  } catch {
    return null;
  }
}

/** Map a "library" | "all" scope to a browse hierarchy + the category to use. */
function hierarchyFor(source: "library" | "all", category: string | undefined): { hierarchy: string; note?: string } {
  if (source !== "library") return { hierarchy: "search" };
  // Roon exposes library-only hierarchies for albums and artists, but not for
  // tracks. For track scope we fall back to universal search and say so.
  if (category === "album") return { hierarchy: "albums" };
  if (category === "artist") return { hierarchy: "artists" };
  return {
    hierarchy: "search",
    note: "Roon exposes no library-only track hierarchy; searched all sources. Scope album/artist queries to the library, or filter with exclude_live.",
  };
}

/** Shape a scored candidate into the JSON the picker returns. */
function toCandidateJson(c: ScoredCandidate, query: string, category: string | undefined, source: "library" | "all", index: number) {
  return {
    index,
    title: c.title,
    artist: c.artist || null,
    // Subtitle is usually "Artist" or "Artist / Album"; surface it raw so Maya
    // can read the album when Roon provides it (the API gives no album field).
    subtitle: c.subtitle || null,
    is_live: c.is_live,
    is_compilation: c.is_compilation,
    instrumental: looksInstrumental(c.title, c.subtitle),
    confidence: Number(c.confidence.toFixed(2)),
    // Roon's browse item_key for this row. It is session- AND stack-scoped (it
    // expires once this browse session moves on), so it is exposed for
    // transparency only - it is NOT a stable cross-call handle. Use `ref` (or a
    // provider track ID from search_tracks) to queue an exact recording later.
    item_key: c.item.item_key ?? null,
    ref: encodeRef({ q: query, c: category, t: c.title, s: c.subtitle, src: source }),
  };
}

/**
 * Drill a matched item's browse node down to its action list, mirroring the
 * deeper-navigation logic the play/queue paths use. Returns the action items.
 */
async function drillToActions(
  browse: RoonApiBrowse,
  itemKey: string,
  zoneId: string | undefined,
  sessionKey: string,
): Promise<{ error?: string; message?: string; actionItems: import("./search-core.js").BrowseItem[] }> {
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

const WHEN_TO_INTENT: Record<string, QueueAction> = {
  queue: "queue",
  next: "add_next",
  now: "play_now",
};

export function registerVersionTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // find_versions - show the candidate recordings for a song, ranked, with the
  // studio-vs-live signal, so Maya can pick the exact one.
  // ---------------------------------------------------------------------------
  server.tool(
    "find_versions",
    "Search for a track (or album) and return the candidate VERSIONS ranked, each with is_live / is_compilation / instrumental / confidence, the Roon item_key, and an opaque `ref`. Use this to see whether a live take, remaster, or compilation is masquerading as the studio cut, then pass a chosen candidate's `ref` to queue_version to queue THAT exact recording. Studio versions are ranked first by default. NOTE: Roon's browse API exposes only title/subtitle/item_key per row - NOT duration, explicit, year, or a provider track ID. For that metadata plus a directly-queueable ID, use search_tracks (Qobuz) + queue_by_id.",
    {
      query: z.string().describe("Song or album to find versions of (include the artist for precision)."),
      category: z
        .enum(["track", "album"])
        .default("track")
        .describe("What kind of result to rank (default track)."),
      zone: z.string().optional().default("").describe("Zone for browse context (uses default zone if omitted)."),
      source: z
        .enum(["library", "all"])
        .default("all")
        .describe("'all' searches library + Qobuz/Tidal (default); 'library' scopes to Monty's library (album/artist only - Roon has no library-only track hierarchy)."),
      exclude_live: z
        .boolean()
        .default(false)
        .describe("Drop candidates flagged as live recordings from the results."),
      limit: z.coerce.number().int().min(1).max(50).default(10).describe("Max candidates to return (default 10)."),
    },
    async ({ query, category, zone, source, exclude_live, limit }): Promise<ToolResult> => {
      try {
        const browse = roonConnection.getBrowse();
        const zoneObj = zone ? roonConnection.findZoneOrThrow(zone) : null;
        const { hierarchy, note } = hierarchyFor(source, category);

        const res = await searchScoredCandidates(browse, query, zoneObj?.zone_id, category, newSessionKey(), hierarchy);
        if (res.error) return jsonResult({ ok: false, error: res.error, query }, true);

        let candidates = res.candidates;
        if (exclude_live) candidates = candidates.filter((c) => !c.is_live);
        const shaped = candidates.slice(0, limit).map((c, i) => toCandidateJson(c, query, category, source, i + 1));

        if (!shaped.length) {
          return jsonResult({
            ok: true,
            query,
            category,
            source,
            candidates: [],
            ...(note ? { note } : {}),
            message: exclude_live
              ? `No non-live results for "${query}".`
              : `No ${category} results for "${query}".`,
          });
        }

        return jsonResult({
          ok: true,
          query,
          category,
          source,
          ...(note ? { note } : {}),
          count: shaped.length,
          candidates: shaped,
          fields_note:
            "duration / explicit / year / provider track ID are NOT available from Roon's browse API; use search_tracks for those plus a queue_by_id-able ID. is_live / is_compilation / instrumental are inferred from title+subtitle text.",
          hint: "Queue an exact version with queue_version(ref), or get a provider ID from search_tracks and use queue_by_id.",
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // queue_version - deterministically queue/play the exact recording a `ref`
  // points at, re-resolved by exact title+subtitle (never a fresh fuzzy pick),
  // and verified by queue growth.
  // ---------------------------------------------------------------------------
  server.tool(
    "queue_version",
    "Queue (or play) the EXACT recording identified by a `ref` from find_versions. Re-resolves the ref deterministically by exact title+subtitle match - not a fuzzy top pick - then runs the chosen action and verifies the queue actually grew. Use this to pin the studio cut after find_versions shows live/comp variants. SAFE DEFAULT: never cuts the current track. when: 'queue' adds to end (default), 'next' plays after the current track, 'replace' interrupts now and replaces the queue with this recording (the harness-safe one-call stomp; immediate:true is the legacy equivalent).",
    {
      ref: z.string().describe("A candidate `ref` returned by find_versions."),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)."),
      immediate: immediateBool
        .optional()
        .default(false)
        .describe("Interrupt/replace the currently-playing track RIGHT NOW. Default false = never cut the current track. Prefer when:\"replace\" for the same effect without a boolean."),
      when: z
        .enum(["queue", "next", "replace"])
        .default("queue")
        .describe("Placement: 'queue' adds to end (default); 'next' plays after the current track; 'replace' interrupts and replaces the queue RIGHT NOW. Ignored when immediate:true (which forces replace)."),
    },
    async ({ ref, zone, immediate, when: whenArg }): Promise<ToolResult> => {
      try {
        // `immediate` / when:"replace" are the only switches that authorize
        // cutting the current track; otherwise use the safe placement.
        const when: "queue" | "next" | "now" = (immediate || whenArg === "replace") ? "now" : whenArg === "next" ? "next" : "queue";
        const decoded = decodeRef(ref);
        if (!decoded) return jsonResult({ ok: false, error: "bad_ref", detail: "ref did not decode; get a fresh one from find_versions." }, true);

        const zoneObj: Zone = roonConnection.findZoneOrThrow(zone);
        const browse = roonConnection.getBrowse();
        const sessionKey = newSessionKey();
        const { hierarchy } = hierarchyFor(decoded.src ?? "all", decoded.c);

        const res = await searchScoredCandidates(browse, decoded.q, zoneObj.zone_id, decoded.c, sessionKey, hierarchy);
        if (res.error) return jsonResult({ ok: false, error: res.error, ref: decoded }, true);

        // Deterministic selection: exact title + subtitle, not a re-ranked top.
        const exact = res.candidates.filter(
          (c) => c.title === decoded.t && stripRoonLinks(c.subtitle || "") === decoded.s,
        );
        if (!exact.length) {
          return jsonResult(
            {
              ok: false,
              error: "ref_not_found",
              detail: `The recording "${decoded.t}" / "${decoded.s}" is no longer in the results for "${decoded.q}". Re-run find_versions for a fresh ref.`,
              available: res.candidates.slice(0, 8).map((c) => ({ title: c.title, subtitle: c.subtitle })),
            },
            true,
          );
        }
        if (exact.length > 1) {
          return jsonResult(
            {
              ok: false,
              error: "ambiguous_ref",
              detail: `${exact.length} recordings share the title "${decoded.t}" and subtitle "${decoded.s}"; cannot pin one deterministically.`,
            },
            true,
          );
        }
        const target = exact[0];

        const drilled = await drillToActions(browse, target.item_key, zoneObj.zone_id, sessionKey);
        if (drilled.message) return jsonResult({ ok: false, error: "message", detail: drilled.message, matched: target.title }, true);
        if (drilled.error) return jsonResult({ ok: false, error: drilled.error, matched: target.title }, true);

        const intent = WHEN_TO_INTENT[when];
        const action = resolveActionItem(drilled.actionItems, intent);
        if (!action?.item.item_key) {
          return jsonResult(
            {
              ok: false,
              error: "no_action",
              detail: `No '${intent}' action for "${target.title}".`,
              available_actions: drilled.actionItems.filter((i) => i.hint !== "header").map((i) => i.title),
            },
            true,
          );
        }

        // Snapshot the queue before, to prove the add landed. (Skip for 'now',
        // which replaces playback rather than growing the queue.)
        const verifyAdd = when !== "now";
        let beforeIds = new Set<number>();
        let beforeCount = 0;
        if (verifyAdd) {
          try {
            const pre = await roonConnection.getQueueSnapshot(zoneObj);
            beforeIds = new Set(pre.map((i) => i.queue_item_id));
            beforeCount = pre.length;
          } catch {
            beforeIds = new Set();
          }
        }

        const exec = await promisifyBrowse(browse, {
          hierarchy: "search",
          item_key: action.item.item_key,
          zone_or_output_id: zoneObj.zone_id,
          multi_session_key: sessionKey,
        });
        if (exec.error) return jsonResult({ ok: false, error: String(exec.error), matched: target.title }, true);

        // Best-effort auto_radio off, matching the other play/queue paths.
        try {
          const transport = roonConnection.getTransport();
          await new Promise<void>((resolve) => transport.change_settings(zoneObj, { auto_radio: false }, () => resolve()));
        } catch {
          /* non-critical */
        }

        const matched = {
          title: target.title,
          artist: target.artist || null,
          subtitle: target.subtitle || null,
          is_live: target.is_live,
          is_compilation: target.is_compilation,
        };

        if (!verifyAdd) {
          return jsonResult({ ok: true, action: action.matched, when, matched, zone: zoneObj.display_name, resulting_state: await resultingState(zoneObj) });
        }

        // Verify by re-reading the queue until it grows (bounded poll).
        let landed = false;
        const deadline = Date.now() + 2500;
        let afterCount = beforeCount;
        try {
          while (Date.now() < deadline) {
            const after = await roonConnection.getQueueSnapshot(zoneObj);
            afterCount = after.length;
            if (after.length > beforeCount || after.some((i) => !beforeIds.has(i.queue_item_id))) {
              landed = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
        } catch {
          // Could not re-read; report unverified rather than a false failure.
          return jsonResult({ ok: true, action: action.matched, when, matched, verified: false, note: "queue growth could not be verified", zone: zoneObj.display_name });
        }

        if (!landed) {
          return jsonResult(
            {
              ok: false,
              error: "add_not_verified",
              detail: `The action reported success but "${target.title}" did not appear in the queue.`,
              matched,
              action: action.matched,
              queue_count_before: beforeCount,
              queue_count_after: afterCount,
              zone: zoneObj.display_name,
            },
            true,
          );
        }

        return jsonResult({ ok: true, action: action.matched, when, matched, verified: true, queue_count_before: beforeCount, queue_count_after: afterCount, zone: zoneObj.display_name, resulting_state: await resultingState(zoneObj) });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );
}
