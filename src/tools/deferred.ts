/**
 * deferred_status / cancel_deferred: read and cancel deferred ("at the next
 * track seam") actions.
 *
 * Every play/queue/edit tool that arms a seam action returns a `deferral_id` and
 * records the arming in the shared DeferralLedger. These two tools close the
 * loop so an agent (or Monty) can ask "is the thing I scheduled still coming, or
 * did it already fire / fail / get superseded?" without guessing - the failure
 * that let a caller report "Done" on the strength of a schedule-time ok:true
 * while the seam action silently evaporated.
 *
 *   deferred_status         -> pending deferrals + recent outcomes (read-only)
 *   cancel_deferred(id)     -> cancel the armed deferral with that id
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deferralLedger } from "../control/deferral-ledger.js";
import { deferredPlayer } from "../control/deferred-player-instance.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export function registerDeferredTools(server: McpServer): void {
  server.tool(
    "deferred_status",
    "List deferred (\"at the next track seam\") actions and how they turned out. Every play/queue/edit tool that schedules an action for the end of the current track returns a deferral_id and records it here. Shows what is still ARMED (waiting for the seam) and the recent terminal outcomes: fired_verified (fired and confirmed landed), fired_unverified (fired but landing unconfirmed), failed(reason), aborted(reason), superseded (a newer command replaced it), expired. Use this to confirm a scheduled replace/jump actually happened before reporting it done - never assume a schedule-time ok means it fired.",
    {
      zone: z.string().optional().describe("Filter to one zone by name or ID (omit for all zones)."),
      limit: z.coerce.number().int().positive().max(100).optional().default(20).describe("Max recent entries to return (default 20)."),
    },
    async ({ zone, limit }): Promise<ToolResult> => {
      // Resolve a zone filter to an id when possible (records key by zone_id).
      let zoneId: string | undefined;
      if (zone) {
        try {
          const { roonConnection } = await import("../roon-connection.js");
          zoneId = roonConnection.findZone(zone)?.zone_id ?? undefined;
          // Unknown zone name: fall back to matching the display name in records.
        } catch {
          zoneId = undefined;
        }
      }
      const recent = deferralLedger.recent(limit, zoneId);
      const filtered = zone && !zoneId ? recent.filter((r) => r.zoneName === zone) : recent;
      const pending = deferralLedger.pending().filter((p) => (zoneId ? p.zoneId === zoneId : zone ? p.zoneName === zone : true));
      return jsonResult({
        ok: true,
        armed_id: deferredPlayer.armedId(),
        pending_count: pending.length,
        pending,
        recent: filtered,
      });
    },
  );

  server.tool(
    "cancel_deferred",
    "Cancel an armed deferred action by its deferral_id (from deferred_status or the tool that scheduled it). Only the currently-armed deferral can be canceled; an already-fired, superseded, or otherwise settled deferral cannot be un-done and returns ok:false. The canceled deferral is recorded aborted(canceled).",
    {
      deferral_id: z.string().describe("The deferral_id to cancel."),
    },
    async ({ deferral_id }): Promise<ToolResult> => {
      const rec = deferralLedger.get(deferral_id);
      if (!rec) {
        return jsonResult({ ok: false, error: "unknown_deferral", detail: `No deferral with id ${deferral_id} is on record.` }, true);
      }
      const canceled = deferredPlayer.cancelById(deferral_id, "canceled");
      if (!canceled) {
        return jsonResult(
          {
            ok: false,
            error: "not_cancelable",
            detail: `Deferral ${deferral_id} is not the armed deferral (status: ${rec.status}); it cannot be canceled.`,
            record: rec,
          },
          true,
        );
      }
      return jsonResult({ ok: true, canceled: deferral_id, record: deferralLedger.get(deferral_id) });
    },
  );
}
