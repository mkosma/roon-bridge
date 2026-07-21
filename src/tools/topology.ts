/**
 * topology: zone grouping + playback transfer (Maya P0 deliverable 4 - surface
 * useful node-roon-api transport commands the bridge was not exposing).
 *
 * The investigation found the transport service exposes group_outputs,
 * ungroup_outputs, and transfer_zone - none of which the bridge surfaced. These
 * are the genuinely useful gaps for a fleet DJ: build/break a synchronized zone
 * (e.g. "WiiM + 1"), and move the current track + queue to another room.
 *
 * Each tool verifies its effect by re-reading the zone map (which the bridge
 * keeps current via subscribe_zones), never trusting the bare command result -
 * the same discipline as queue_next / queue_by_id.
 *
 * NOTE: these mutate live audio topology, so they were NOT executed against the
 * live system during the build; their browse-free transport calls and verify
 * logic are unit-tested against a mock, and live verification is Maya's.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import { lastCommandStore } from "../control/last-command.js";
import { currentCommandSource } from "../control/command-context.js";
import type { Zone, Output } from "node-roon-api-transport";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/** All outputs of a zone (grouping operates on outputs, not zones). */
function outputsOf(zone: Zone): Output[] {
  return zone.outputs ?? [];
}

/** Poll the zone map briefly until `pred` holds, so we verify the real effect. */
async function waitFor(pred: () => boolean, ms = 2500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return pred();
}

export function registerTopologyTools(server: McpServer): void {
  server.tool(
    "transfer_zone",
    "Move the current track + queue from one zone to another (native Roon transfer_zone). Verified by re-reading the destination zone's now-playing. Use to shift what's playing to another room without rebuilding the queue.",
    {
      from_zone: z.string().describe("Source zone name or ID (where playback is now)."),
      to_zone: z.string().describe("Destination zone name or ID."),
    },
    async ({ from_zone, to_zone }): Promise<ToolResult> => {
      try {
        const from = roonConnection.findZoneOrThrow(from_zone);
        const to = roonConnection.findZoneOrThrow(to_zone);
        if (from.zone_id === to.zone_id) {
          return jsonResult({ ok: false, error: "same_zone", detail: "Source and destination are the same zone." }, true);
        }
        const movedTitle = from.now_playing?.three_line?.line1 ?? null;
        await roonConnection.transferZone(from, to);
        const source = currentCommandSource();
        lastCommandStore.record(from.zone_id, "transfer_zone", source);
        lastCommandStore.record(to.zone_id, "transfer_zone", source);

        const verified = await waitFor(() => {
          const dst = roonConnection.findZone(to.zone_id);
          return !!dst?.now_playing && (movedTitle == null || dst.now_playing.three_line.line1 === movedTitle);
        });
        return jsonResult({
          ok: true,
          from: from.display_name,
          to: to.display_name,
          moved: movedTitle,
          verified,
          ...(verified ? {} : { note: "transfer issued but destination now-playing was not confirmed; check the zone." }),
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  server.tool(
    "group_zones",
    "Group two or more zones into one synchronized zone (native Roon group_outputs), e.g. to build a multi-room 'WiiM + 1' group. The first zone's queue is preserved. Verified by re-reading the zone map until the outputs share a zone.",
    {
      zones: z.array(z.string()).min(2).describe("Zone names or IDs to group (>= 2). The first zone's queue is kept."),
    },
    async ({ zones }): Promise<ToolResult> => {
      try {
        const resolved = zones.map((z) => roonConnection.findZoneOrThrow(z));
        const outputs = resolved.flatMap(outputsOf);
        if (outputs.length < 2) {
          return jsonResult({ ok: false, error: "not_enough_outputs", detail: "Need at least two outputs across the named zones to group." }, true);
        }
        const outputIds = outputs.map((o) => o.output_id);
        await roonConnection.groupOutputs(outputs);
        {
          const source = currentCommandSource();
          for (const z of resolved) lastCommandStore.record(z.zone_id, "group_zones", source);
        }

        // Verify: some zone now contains all the requested outputs together.
        const verified = await waitFor(() =>
          roonConnection.getZones().some((zone) => {
            const ids = new Set(outputsOf(zone).map((o) => o.output_id));
            return outputIds.every((id) => ids.has(id));
          }),
        );
        const grouped = roonConnection
          .getZones()
          .find((zone) => {
            const ids = new Set(outputsOf(zone).map((o) => o.output_id));
            return outputIds.every((id) => ids.has(id));
          });
        if (grouped) lastCommandStore.record(grouped.zone_id, "group_zones", currentCommandSource());
        return jsonResult({
          ok: true,
          requested_zones: resolved.map((z) => z.display_name),
          grouped_zone: grouped?.display_name ?? null,
          verified,
          ...(verified ? {} : { note: "group issued but a combined zone was not confirmed; check Roon." }),
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  server.tool(
    "ungroup_zone",
    "Split a grouped zone back into independent outputs (native Roon ungroup_outputs). Verified by re-reading the zone map until the outputs no longer share one zone.",
    {
      zone: z.string().describe("A grouped zone name or ID to break apart."),
    },
    async ({ zone }): Promise<ToolResult> => {
      try {
        const z = roonConnection.findZoneOrThrow(zone);
        const outputs = outputsOf(z);
        if (outputs.length < 2) {
          return jsonResult({ ok: false, error: "not_grouped", detail: `Zone '${z.display_name}' has fewer than two outputs; nothing to ungroup.` }, true);
        }
        const outputIds = outputs.map((o) => o.output_id);
        await roonConnection.ungroupOutputs(outputs);
        lastCommandStore.record(z.zone_id, "ungroup_zone", currentCommandSource());

        const verified = await waitFor(() =>
          !roonConnection.getZones().some((zz) => {
            const ids = new Set(outputsOf(zz).map((o) => o.output_id));
            return outputIds.every((id) => ids.has(id));
          }),
        );
        return jsonResult({
          ok: true,
          ungrouped: z.display_name,
          output_count: outputs.length,
          verified,
          ...(verified ? {} : { note: "ungroup issued but separation was not confirmed; check Roon." }),
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );
}
