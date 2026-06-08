import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type { ResultCallback } from "node-roon-api-transport";
import { sharedRamper } from "../control/shared-ramper.js";
import { VolumeRamper } from "../control/volume-ramper.js";
import { readRoonKeyConfig } from "../control/roon-key-config.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Floor for derived ramp cadence; matches roon-key's ramp_step_ms minimum. */
const MIN_STEP_MS = 5;

function promisifyResult(fn: (cb: ResultCallback) => void): Promise<false | string> {
  return new Promise((resolve) => fn((error) => resolve(error)));
}

/** Per-step cadence (ms) to ramp `steps` 1-unit increments over durationMs. */
function stepMsForDuration(steps: number, durationMs: number): number {
  if (steps <= 0) return MIN_STEP_MS;
  return Math.max(MIN_STEP_MS, Math.round(durationMs / steps));
}

/** Configured ramp cadence, or undefined to fall back to the ramper default. */
function configuredStepMs(): number | undefined {
  try {
    return readRoonKeyConfig().ramp_step_ms;
  } catch {
    return undefined;
  }
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
    "ramp_volume",
    "Smoothly ramp a Roon zone's volume as an audible fade, instead of the instant jump change_volume produces. Set how='absolute' to ramp to a target level, or how='relative' to ramp by a signed delta. The ramp runs server-side and the call returns immediately; a new ramp or any volume command supersedes one in progress. Honors grouped zones (e.g. WiiM + 1) and each output's volume limits.",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      value: z.number().describe("Target level when how='absolute', or signed delta when how='relative'"),
      how: z
        .enum(["absolute", "relative"])
        .default("absolute")
        .describe("'absolute' ramps to the exact level; 'relative' ramps by the value (positive up, negative down)"),
      duration_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Total fade duration in milliseconds. If omitted, uses the configured ramp_step_ms cadence (~20ms per 1-unit step)."),
    },
    async ({ zone, value, how, duration_ms }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const getZone = () => roonConnection.findZone(foundZone.display_name);

        const currentMax = VolumeRamper.currentMaxVolume(foundZone);
        if (currentMax === null) {
          return {
            content: [{ type: "text", text: `No numeric-volume outputs in zone '${foundZone.display_name}' to ramp.` }],
          };
        }

        const target = how === "absolute" ? value : currentMax + value;
        const steps = Math.abs(target - currentMax);
        if (steps === 0) {
          return {
            content: [{ type: "text", text: `Zone '${foundZone.display_name}' is already at ${target}; nothing to ramp.` }],
          };
        }

        const stepMs = duration_ms != null ? stepMsForDuration(steps, duration_ms) : configuredStepMs();

        // Fire and forget: kick the server-side ramp and return immediately,
        // exactly like the HTTP /control/volume_ramp path.
        sharedRamper
          .rampAbsolute(target, getZone, transport, stepMs)
          .catch((e: unknown) => console.error("[ramp_volume] error:", e));

        const dur = duration_ms != null ? `${duration_ms}ms` : `${steps} steps`;
        return {
          content: [{ type: "text", text: `Ramping '${foundZone.display_name}' from ${currentMax} to ${target} over ${dur}.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "smooth_skip",
    "Fake a crossfade across a manual track change: smoothly fade the zone out, change track (next or previous), then fade back to the original level. Roon's native crossfade only smooths natural track ends; a manual skip otherwise drops to silence. The original volume is always restored, even if the skip fails, so there is no stuck-at-0 failure mode. A new volume command supersedes the fades.",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      direction: z
        .enum(["next", "previous"])
        .default("next")
        .describe("Which way to skip: 'next' track or 'previous' track"),
      fade_ms: z
        .number()
        .int()
        .positive()
        .default(1500)
        .describe("Duration in milliseconds of each fade leg (out, then in). Default 1500."),
    },
    async ({ zone, direction, fade_ms }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const getZone = () => roonConnection.findZone(foundZone.display_name);

        const original = VolumeRamper.currentMaxVolume(foundZone);
        if (original === null) {
          return {
            content: [{ type: "text", text: `No numeric-volume outputs in zone '${foundZone.display_name}'; cannot fade.` }],
          };
        }

        const dir = direction === "previous" ? "previous" : "next";
        const fadeMs = fade_ms ?? 1500;

        try {
          // Fade out to silence, then perform the manual skip.
          await sharedRamper.rampAbsolute(0, getZone, transport, stepMsForDuration(original, fadeMs));
          await new Promise<void>((resolve, reject) => {
            transport.control(foundZone, dir, (err) => {
              if (err) reject(new Error(String(err)));
              else resolve();
            });
          });
        } finally {
          // Always fade back to the original level from wherever we ended up,
          // so a failed skip never leaves the zone stuck at 0.
          const cur = VolumeRamper.currentMaxVolume(getZone() ?? foundZone) ?? 0;
          await sharedRamper.rampAbsolute(
            original,
            getZone,
            transport,
            stepMsForDuration(Math.abs(original - cur), fadeMs),
          );
        }

        const verb = dir === "next" ? "skipped to next" : "went to previous";
        return {
          content: [{ type: "text", text: `Smooth skip: faded out, ${verb} track, faded back to ${original} in zone '${foundZone.display_name}'.` }],
        };
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
