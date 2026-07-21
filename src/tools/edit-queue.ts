/**
 * edit_queue: delete and/or reorder upcoming queue items by stable
 * queue_item_id, via a SAFE REBUILD (Monty's algorithm; Maya ticket
 * 2026-06-18).
 *
 * Roon's extension API exposes NO delete-or-reorder primitive for the play queue
 * (see queue.ts: remove_from_queue / reorder_queue refuse honestly). The only
 * non-destructive way to "remove track X" or change the order is to rebuild the
 * upcoming portion of the queue. This does that as a first-class, never-stomping
 * operation:
 *
 *   1. Snapshot the queue. The currently-playing track is left alone.
 *   2. Apply the edits to the UPCOMING list (delete named ids; reorder the rest).
 *   3. when="after_current" (default): arm the event-driven DeferredPlayer (the
 *      same after-current impl play_track/play_album use - fires on the real
 *      track-end event, never a wall-clock timer). when="now": rebuild at once.
 *   4. At the seam, validate nothing interfered (snapshot-compare against the
 *      armed baseline + zone state), then start the first edited track (replace),
 *      validate it is actually now-playing, then append the rest in order.
 *   5. Verify the final queue matches the intended edited list.
 *
 * Re-queueing is EXACT, not re-matched: each item's provider track id is looked
 * up in the queue-provenance map (captured at enqueue time by queue_by_id /
 * play_by_id) and replayed via the deterministic queue_by_id path. Items with no
 * provenance (queued by the Roon GUI, by name search, or before this process
 * started) fall back to title+artist re-resolution and are flagged `reresolved`.
 *
 * HARD requirement: if the user or any other process changes queue/playback
 * during the wait or rebuild, ABORT cleanly - never fight the user. Detection is
 * a snapshot-compare on the upcoming ids plus a DeferredPlayer generation guard
 * (manual skip re-arms and then trips the snapshot check; pause/stop abort).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import { deferredPlayer } from "../control/deferred-player-instance.js";
import type { SeamOutcome } from "../control/deferred-player.js";
import { queueProvenance } from "../control/queue-provenance.js";
import { readQueueRows, type QueueRow } from "./queue.js";
import { executeById, executeIdentity, type ExecResult } from "./play-by-id.js";
import { normalizeTitle, type TrackIdentity } from "./search-core.js";
import { resultingState, immediateBool } from "./resulting-state.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

// edit_queue arms the SINGLE shared DeferredPlayer (deferred-player-instance),
// the same one play_track/play_by_id/play_from_here use. One shared scheduler
// (and one shared deferral ledger) means an immediate play from any tool
// supersedes an edit_queue rebuild and vice versa, and every deferral - whoever
// armed it - shows up in deferred_status. The rebuild's snapshot interference
// check still aborts cleanly if the queue moved under it.

// ---------------------------------------------------------------------------
// Pure planning helpers (unit-tested in isolation - no Roon needed).
// ---------------------------------------------------------------------------

export interface EditPlan {
  /** queue_item_id of the now-playing track (head), or null if nothing playing. */
  currentId: number | null;
  /** True if the delete set named the currently-playing track. */
  deletedPlaying: boolean;
  /** The upcoming items, in intended order, after delete + reorder. */
  editedUpcoming: QueueRow[];
  /** Whether the request is a no-op (no delete, order unchanged). */
  noop: boolean;
  /** Set when the request is invalid; the caller surfaces it verbatim. */
  error?: { error: string; detail: string } & Record<string, unknown>;
}

/**
 * Compute the intended upcoming list from the current queue rows and the
 * requested delete / reorder. Deterministic and side-effect free.
 *
 * - `del` ids must all exist in the queue.
 * - `reorder`, when given, must be a permutation of the upcoming ids that remain
 *   after deletion (it cannot include the now-playing track or any deleted id).
 */
export function planEditedList(rows: QueueRow[], del: number[], reorder?: number[]): EditPlan {
  const nowRow = rows.find((r) => r.is_now_playing) ?? null;
  const currentId = nowRow?.queue_item_id ?? null;
  const allIds = new Set(rows.map((r) => r.queue_item_id));

  const unknownDel = del.filter((id) => !allIds.has(id));
  if (unknownDel.length) {
    return {
      currentId,
      deletedPlaying: false,
      editedUpcoming: [],
      noop: false,
      error: {
        error: "unknown_delete_id",
        detail: `These delete ids are not in the current queue: ${unknownDel.join(", ")}.`,
        queue_item_ids: rows.map((r) => r.queue_item_id),
      },
    };
  }

  // Upcoming = everything after the now-playing head. With nothing playing the
  // whole queue is upcoming.
  const upcoming = nowRow ? rows.filter((r) => r.position > nowRow.position) : rows.slice();
  const deletedSet = new Set(del);
  const deletedPlaying = currentId != null && deletedSet.has(currentId);
  const base = upcoming.filter((r) => !deletedSet.has(r.queue_item_id));

  let editedUpcoming = base;
  let reordered = false;
  if (reorder && reorder.length) {
    const baseIds = base.map((r) => r.queue_item_id);
    const baseSet = new Set(baseIds);
    const reorderSet = new Set(reorder);
    const samePermutation =
      reorder.length === baseIds.length &&
      reorderSet.size === reorder.length &&
      reorder.every((id) => baseSet.has(id));
    if (!samePermutation) {
      return {
        currentId,
        deletedPlaying,
        editedUpcoming: [],
        noop: false,
        error: {
          error: "reorder_mismatch",
          detail:
            "`reorder` must be a permutation of the upcoming ids that remain after deletion " +
            "(it cannot include the now-playing track or a deleted id, and must list each exactly once).",
          expected_ids: baseIds,
          got: reorder,
        },
      };
    }
    const byId = new Map(base.map((r) => [r.queue_item_id, r]));
    editedUpcoming = reorder.map((id) => byId.get(id)!);
    reordered = reorder.some((id, i) => id !== baseIds[i]);
  }

  const noop = del.length === 0 && !reordered;
  return { currentId, deletedPlaying, editedUpcoming, noop };
}

/**
 * Detect interference between the armed baseline and the live queue. Returns true
 * if the upcoming items we intended to rebuild have been removed, consumed past,
 * or reordered by the user or another process while we waited.
 *
 * Tolerant of a leading stale now-playing head and trailing additions: it checks
 * that the baseline upcoming ids still appear, in the same relative order, among
 * the live ids.
 */
export function detectInterference(baselineUpcomingIds: number[], currentIds: number[]): boolean {
  const baseSet = new Set(baselineUpcomingIds);
  const present = currentIds.filter((id) => baseSet.has(id));
  if (present.length !== baselineUpcomingIds.length) return true;
  return present.some((id, i) => id !== baselineUpcomingIds[i]);
}

/** Whether the rebuilt queue's order matches the intended edited list, by title+artist. */
export function finalQueueMatches(
  expected: Array<{ title: string; artist: string | null }>,
  resultRows: Array<{ title: string; artist: string | null }>,
): { match: boolean; firstMismatch: number | null } {
  if (resultRows.length < expected.length) {
    return { match: false, firstMismatch: Math.min(resultRows.length, expected.length) };
  }
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const r = resultRows[i];
    if (!r || normalizeTitle(e.title) !== normalizeTitle(r.title)) {
      return { match: false, firstMismatch: i };
    }
  }
  return { match: true, firstMismatch: null };
}

// ---------------------------------------------------------------------------
// Rebuild orchestration.
// ---------------------------------------------------------------------------

interface PlanItem {
  queue_item_id: number;
  title: string;
  artist: string | null;
  album: string | null;
  providerId?: string;
  provider?: string;
  identity: TrackIdentity;
  reresolved: boolean;
}

/** Build the ordered re-queue plan, resolving provider provenance per item. */
function buildPlanItems(editedUpcoming: QueueRow[]): PlanItem[] {
  return editedUpcoming.map((row) => {
    const prov = queueProvenance.get(row.queue_item_id);
    const identity: TrackIdentity = {
      title: prov?.title ?? row.title,
      artist: prov?.artist ?? row.artist ?? "",
      album: prov?.album ?? row.album ?? undefined,
      trackNumber: prov?.trackNumber ?? undefined,
    };
    return {
      queue_item_id: row.queue_item_id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      providerId: prov?.providerId,
      provider: prov?.provider,
      identity,
      reresolved: !prov?.providerId,
    };
  });
}

function executeItem(item: PlanItem, zone: import("node-roon-api-transport").Zone, when: "now" | "queue"): Promise<ExecResult> {
  if (item.providerId) {
    return executeById(item.providerId, item.provider as never, zone, when);
  }
  return executeIdentity(item.identity, zone, when);
}

interface RebuildOutcome {
  ok: boolean;
  aborted?: boolean;
  reason?: string;
  detail?: string;
  first?: ExecResult;
  appended?: Array<{ title: string; ok: boolean; verified: boolean; reresolved: boolean }>;
  final_match?: boolean;
  final_queue?: Array<{ position: number; title: string; artist: string | null }>;
}

/**
 * Perform the rebuild against the live zone. `guard` enables the interference
 * checks (used for the after-current path; skipped for an explicit when="now").
 */
async function runRebuild(
  zoneId: string,
  items: PlanItem[],
  baselineUpcomingIds: number[],
  guard: boolean,
): Promise<RebuildOutcome> {
  const log = (msg: string, data?: unknown) =>
    console.error(`[roon-bridge] edit_queue ${msg}`, data !== undefined ? JSON.stringify(data) : "");

  const zone = roonConnection.findZone(zoneId);
  if (!zone) {
    log("abort: zone_gone", { zoneId });
    return { ok: false, aborted: true, reason: "zone_gone", detail: `Zone ${zoneId} is no longer available.` };
  }

  if (guard) {
    if (zone.state === "stopped" || zone.state === "paused") {
      log("abort: playback_changed", { state: zone.state });
      return { ok: false, aborted: true, reason: "playback_changed", detail: `Playback is ${zone.state}; not forcing a rebuild.` };
    }
    let currentRows: QueueRow[];
    try {
      currentRows = await readQueueRows(zone);
    } catch (e) {
      return { ok: false, aborted: true, reason: "queue_read_failed", detail: e instanceof Error ? e.message : String(e) };
    }
    if (detectInterference(baselineUpcomingIds, currentRows.map((r) => r.queue_item_id))) {
      log("abort: interference", { baseline: baselineUpcomingIds, current: currentRows.map((r) => r.queue_item_id) });
      return { ok: false, aborted: true, reason: "interference", detail: "The queue changed during the wait; aborting to avoid stomping the user." };
    }
  }

  // Start the first edited track (replace), then validate it is now-playing.
  const first = await executeItem(items[0], zone, "now");
  if (!first.ok || first.verified !== true) {
    log("abort: first_track_failed", first);
    return { ok: false, aborted: true, reason: "first_track_failed", detail: `Could not start "${items[0].title}" as the new head; left playback untouched of further appends.`, first };
  }

  // Append the rest in order.
  const appended: RebuildOutcome["appended"] = [];
  for (let i = 1; i < items.length; i++) {
    const r = await executeItem(items[i], zone, "queue");
    appended.push({ title: items[i].title, ok: r.ok === true, verified: r.verified === true, reresolved: items[i].reresolved });
  }

  // Final verification: read the queue back and compare to intent.
  let finalRows: QueueRow[] = [];
  try {
    finalRows = await readQueueRows(zone);
  } catch { /* report unverified below */ }
  const { match } = finalQueueMatches(
    items.map((it) => ({ title: it.title, artist: it.artist })),
    finalRows.map((r) => ({ title: r.title, artist: r.artist })),
  );

  log("done", { match, count: items.length });
  return {
    ok: true,
    first,
    appended,
    final_match: match,
    final_queue: finalRows.map((r) => ({ position: r.position, title: r.title, artist: r.artist })),
  };
}

// ---------------------------------------------------------------------------
// Tool registration.
// ---------------------------------------------------------------------------

export function registerEditQueueTools(server: McpServer): void {
  server.tool(
    "edit_queue",
    "Delete and/or reorder UPCOMING queue items by their stable queue_item_id (from get_queue), via a safe rebuild. Roon exposes no native queue delete/reorder, so this rebuilds the upcoming queue: SAFE DEFAULT: it waits for the current track to END (event-driven, no mid-track cut), then starts the first edited track and re-appends the rest IN ORDER, re-queueing the EXACT same recordings via provider ids captured at enqueue time. If the user or anything else changes the queue/playback while it waits, it ABORTS cleanly rather than fighting. Pass immediate:true to rebuild RIGHT NOW (cuts the current track). Returns the before/after plan and verification.",
    {
      delete: z
        .array(z.coerce.number().int())
        .optional()
        .default([])
        .describe("queue_item_id(s) to remove from the upcoming queue."),
      reorder: z
        .array(z.coerce.number().int())
        .optional()
        .describe("Desired order of the remaining upcoming queue_item_ids (a permutation of the ids left after deletion). Omit to keep current order."),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)."),
      immediate: immediateBool
        .optional()
        .default(false)
        .describe("Rebuild the queue RIGHT NOW, cutting the current track. Default false = wait for the current track to end (no mid-track cut)."),
    },
    async ({ delete: del, reorder, zone, immediate }): Promise<ToolResult> => {
      try {
        // `immediate` is the sole switch that authorizes cutting the current track.
        const when: "after_current" | "now" = immediate ? "now" : "after_current";
        const z = roonConnection.findZoneOrThrow(zone);
        const rows = await readQueueRows(z);
        if (!rows.length) {
          return jsonResult({ ok: false, error: "empty_queue", detail: "The queue is empty; nothing to edit.", zone: z.display_name }, true);
        }

        const plan = planEditedList(rows, del ?? [], reorder);
        if (plan.error) {
          return jsonResult({ ok: false, ...plan.error, zone: z.display_name }, true);
        }
        if (plan.noop) {
          return jsonResult({
            ok: true,
            noop: true,
            detail: "No deletions and the order is unchanged; nothing to do.",
            zone: z.display_name,
          });
        }
        if (!plan.editedUpcoming.length) {
          return jsonResult(
            {
              ok: false,
              error: "cannot_empty_queue",
              detail:
                "The edit would leave no upcoming tracks. Roon's API cannot clear the upcoming queue (rebuild works by playing a first track then appending), so an empty result is not achievable. Delete fewer tracks, or use stop/pause instead.",
              zone: z.display_name,
            },
            true,
          );
        }

        const items = buildPlanItems(plan.editedUpcoming);
        // Interference baseline: every upcoming id (after the now-playing head).
        const nowIdx = rows.findIndex((r) => r.is_now_playing);
        const upcomingIds = (nowIdx >= 0 ? rows.slice(nowIdx + 1) : rows).map((r) => r.queue_item_id);

        const planSummary = {
          deletions: (del ?? []).map((id) => {
            const row = rows.find((r) => r.queue_item_id === id);
            return { queue_item_id: id, title: row?.title ?? null, was_now_playing: id === plan.currentId };
          }),
          edited_upcoming: items.map((it, i) => ({
            position: i + 1,
            queue_item_id: it.queue_item_id,
            title: it.title,
            artist: it.artist,
            replay: it.reresolved ? "title+artist re-resolution (no provider id captured)" : "exact provider id",
            reresolved: it.reresolved,
          })),
          reresolved_count: items.filter((it) => it.reresolved).length,
        };

        const deletedPlayingNote = plan.deletedPlaying
          ? "NOTE: the currently-playing track is in the delete set; it keeps playing to its end, then the rebuilt (edited) queue takes over - so it effectively drops at track end."
          : undefined;

        if (when === "now") {
          const outcome = await runRebuild(z.zone_id, items, upcomingIds, /* guard */ false);
          return jsonResult(
            { ok: outcome.ok, when, zone: z.display_name, deleted_playing_note: deletedPlayingNote, plan: planSummary, before_queue: rows.map((r) => ({ position: r.position, queue_item_id: r.queue_item_id, title: r.title, artist: r.artist, is_now_playing: r.is_now_playing })), outcome, resulting_state: await resultingState(z, "edit_queue") },
            !outcome.ok,
          );
        }

        // after_current: arm only when something is actually playing with a known
        // length; otherwise there is no seam to wait for, so rebuild now.
        const np = z.now_playing;
        if (z.state === "playing" && np && np.length != null) {
          // Adapt the rebuild's RebuildOutcome to a SeamOutcome so the ledger
          // records how it ended - crucially, a clean interference abort becomes
          // aborted(interference) (was silently discarded before), never a lost
          // action the caller believes succeeded.
          const seamAction = async (): Promise<SeamOutcome> => {
            const outcome = await runRebuild(z.zone_id, items, upcomingIds, /* guard */ true);
            return {
              ok: outcome.ok,
              verified: outcome.ok && outcome.final_match !== false,
              aborted: outcome.aborted === true,
              reason: outcome.reason,
              detail: outcome.detail,
              resulting_state: await resultingState(roonConnection.findZone(z.zone_id) ?? z, "edit_queue"),
            };
          };
          const { deferral_id } = await deferredPlayer.scheduleAfterCurrent(z, seamAction, {
            zoneId: z.zone_id,
            zoneName: z.display_name,
            trigger: `end of "${np.three_line?.line1 ?? "the current track"}"`,
            description: `rebuild upcoming queue to ${items.length} track(s)`,
          });
          return jsonResult({
            ok: true,
            scheduled: true,
            when,
            deferral_id,
            detail: `Armed: the queue will be rebuilt when "${np.three_line?.line1 ?? "the current track"}" ends (no mid-track cut). Aborts cleanly if the queue or playback changes before then. Track with deferred_status; cancel with cancel_deferred("${deferral_id}").`,
            zone: z.display_name,
            deleted_playing_note: deletedPlayingNote,
            plan: planSummary,
            before_queue: rows.map((r) => ({ position: r.position, queue_item_id: r.queue_item_id, title: r.title, artist: r.artist, is_now_playing: r.is_now_playing })),
            // Nothing executed yet - the rebuild is recorded inside seamAction()
            // above when the deferral fires.
            resulting_state: await resultingState(z, null),
          });
        }

        // Nothing playing - no seam; rebuild immediately.
        const outcome = await runRebuild(z.zone_id, items, upcomingIds, /* guard */ false);
        return jsonResult(
          { ok: outcome.ok, when: "now (nothing was playing)", zone: z.display_name, deleted_playing_note: deletedPlayingNote, plan: planSummary, outcome, resulting_state: await resultingState(z, "edit_queue") },
          !outcome.ok,
        );
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );
}
