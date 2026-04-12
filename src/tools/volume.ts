import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type { ResultCallback } from "node-roon-api-transport";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function promisifyResult(fn: (cb: ResultCallback) => void): Promise<false | string> {
  return new Promise((resolve) => fn((error) => resolve(error)));
}

export function registerVolumeTools(server: McpServer): void {
  server.tool(
    "change_volume",
    "Change the volume of a Roon zone. Each output in a zone may have independent volume controls.",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      value: z.number().describe("Volume value (absolute level, or relative adjustment)"),
      how: z
        .enum(["absolute", "relative", "relative_step"])
        .default("absolute")
        .describe("How to interpret the value: 'absolute' sets exact level, 'relative' adds/subtracts, 'relative_step' adjusts by step increments"),
    },
    async ({ zone, value, how }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);

        const results: string[] = [];
        for (const output of foundZone.outputs) {
          if (!output.volume) continue;
          const error = await promisifyResult((cb) =>
            transport.change_volume(output, how, value, cb),
          );
          if (error) {
            results.push(`${output.display_name}: Error - ${error}`);
          } else {
            results.push(`${output.display_name}: Volume ${how === "absolute" ? "set to" : "adjusted by"} ${value}`);
          }
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No volume-controllable outputs in zone '${foundZone.display_name}'.` }],
          };
        }

        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mute",
    "Mute or unmute a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      mute: z.boolean().describe("true to mute, false to unmute"),
    },
    async ({ zone, mute }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const how = mute ? "mute" : "unmute";

        const results: string[] = [];
        for (const output of foundZone.outputs) {
          if (!output.volume) continue;
          const error = await promisifyResult((cb) => transport.mute(output, how, cb));
          if (error) {
            results.push(`${output.display_name}: Error - ${error}`);
          } else {
            results.push(`${output.display_name}: ${mute ? "Muted" : "Unmuted"}`);
          }
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No volume-controllable outputs in zone '${foundZone.display_name}'.` }],
          };
        }

        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_volume",
    "Get the current volume level and mute status for a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }): Promise<ToolResult> => {
      try {
        roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);

        const lines: string[] = [`Zone: ${foundZone.display_name}`];
        for (const output of foundZone.outputs) {
          if (output.volume) {
            const vol = output.volume;
            const parts = [`${output.display_name}:`];
            if (vol.type === "incremental") {
              parts.push("Incremental volume (no level readout)");
            } else {
              parts.push(`${vol.value}${vol.type === "db" ? " dB" : ""}`);
              if (vol.min != null && vol.max != null) {
                parts.push(`(range: ${vol.min} to ${vol.max})`);
              }
            }
            if (vol.is_muted) parts.push("[MUTED]");
            lines.push(`  ${parts.join(" ")}`);
          } else {
            lines.push(`  ${output.display_name}: No volume control`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );
}
