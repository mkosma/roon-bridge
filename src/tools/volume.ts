import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type { ResultCallback } from "node-roon-api-transport";
import { sharedRamper } from "../control/shared-ramper.js";
import { VolumeRamper } from "../control/volume-ramper.js";
import { readRoonKeyConfig } from "../control/roon-key-config.js";
import { waitForTrackStart, trackKeyOf } from "../control/track-gate.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Floor for derived ramp cadence; matches roon-key's ramp_step_ms minimum. */
const MIN_STEP_MS = 5;

/**
 * smooth_skip fade-feel tuning (see Maya's 2026-06-08 ticket). These are the
 * starting points for the live FEEL pass; the out-leg is a quick clean fade,
 * the in-leg a slightly longer ride-in over the opening of the new track.
 */
const DEFAULT_FADE_OUT_MS = 1100;
const DEFAULT_FADE_IN_MS = 1800;
/**
 * Fade-out floor as a fraction of the original level: duck to a low bed rather
 * than full silence, so the gap between tracks reads as a dip, not dead air.
 */
const FADE_FLOOR_RATIO = 0.12;
/** Max wait for the new track to start producing audio before fading in anyway. */
const TRACK_START_TIMEOUT_MS = 2500;

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
    "Smoothly ramp a Roon zone's volume as an audible fade, instead of the instant jump change_volume produces. Set how='absolute' to ramp to a target level, or how='relative' to ramp by a signed delta. The ramp runs server-side and the call returns immediately; a new ramp or any volume command supersedes one in progress. Honors grouped zones (e.g. WiiM + 1) and each output's volume limits. For a long, ultra-gradual fade (e.g. a sunrise wake over 20-45 min) pass a large duration_ms with curve='ease' or 'perceptual'. Roon volume is integer-stepped, so the finest possible change is 1 unit; curve and duration spread those unit steps to where the ear least notices them, but cannot make them sub-unit.",
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
        .describe("Total fade duration in milliseconds. If omitted, uses the configured ramp_step_ms cadence (~20ms per 1-unit step). Supports long durations (to ~45 min / 2,700,000ms) without drift; a superseding volume command still cancels it."),
      curve: z
        .enum(["linear", "ease", "perceptual"])
        .default("linear")
        .describe("How to distribute the integer steps across duration_ms. 'linear': even spacing. 'ease': gentle S-curve, slow at both ends (the wake feel). 'perceptual': dwell weighted by each step's dB jump, slower in the low range where steps are most audible. Only takes effect when duration_ms is given."),
    },
    async ({ zone, value, how, duration_ms, curve }): Promise<ToolResult> => {
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

        // Fire and forget: kick the server-side ramp and return immediately,
        // exactly like the HTTP /control/volume_ramp path. With an explicit
        // duration, shape the integer steps across it via rampCurve (drift-free,
        // curve-aware); otherwise keep the configured even-cadence path.
        const rampShape = curve ?? "linear";
        if (duration_ms != null) {
          sharedRamper
            .rampCurve(target, getZone, transport, duration_ms, rampShape)
            .catch((e: unknown) => console.error("[ramp_volume] error:", e));
        } else {
          sharedRamper
            .rampAbsolute(target, getZone, transport, configuredStepMs())
            .catch((e: unknown) => console.error("[ramp_volume] error:", e));
        }

        const dur = duration_ms != null ? `${duration_ms}ms (${rampShape})` : `${steps} steps`;
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
    "Fake a crossfade across a manual track change: smoothly fade the zone down, change track (next or previous), then fade back up as the new track starts. Roon's native crossfade only smooths natural track ends; a manual skip otherwise drops to silence. The fade-out is shaped (smooth, non-steppy tail) and ducks to a low floor rather than full silence; the fade-in is gated on the new track actually producing audio, so it rides the opening of the track instead of being wasted on the dead-air gap. The original volume is always restored, even if the skip fails, so there is no stuck-at-0 failure mode. A new volume command supersedes the fades.",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      direction: z
        .enum(["next", "previous"])
        .default("next")
        .describe("Which way to skip: 'next' track or 'previous' track"),
      fade_out_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Duration in ms of the fade-OUT leg. Default ${DEFAULT_FADE_OUT_MS} (a quick clean duck).`),
      fade_in_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Duration in ms of the fade-IN leg, riding the new track's start. Default ${DEFAULT_FADE_IN_MS}.`),
      fade_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Convenience: set both legs to this duration. Overridden by fade_out_ms / fade_in_ms when those are given."),
    },
    async ({ zone, direction, fade_out_ms, fade_in_ms, fade_ms }): Promise<ToolResult> => {
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
        const outMs = fade_out_ms ?? fade_ms ?? DEFAULT_FADE_OUT_MS;
        const inMs = fade_in_ms ?? fade_ms ?? DEFAULT_FADE_IN_MS;
        const floor = Math.round(original * FADE_FLOOR_RATIO);
        const prevTrackKey = trackKeyOf(foundZone.now_playing);

        try {
          // Shaped fade-out (easeIn) to a low floor, not full silence, so the
          // tail stays smooth and the inter-track gap reads as a dip, not dead air.
          await sharedRamper.rampShaped(floor, getZone, transport, outMs, "in");
          // Perform the manual skip.
          await new Promise<void>((resolve, reject) => {
            transport.control(foundZone, dir, (err) => {
              if (err) reject(new Error(String(err)));
              else resolve();
            });
          });
          // Wait for the NEW track to actually start producing audio before
          // fading in, so the fade-in rides the opening instead of the dead gap.
          await waitForTrackStart(roonConnection, getZone, foundZone.zone_id, prevTrackKey, {
            timeoutMs: TRACK_START_TIMEOUT_MS,
          });
        } finally {
          // Always fade back up to the original level from wherever we ended up,
          // so a failed skip never leaves the zone stuck low. Shaped easeOut so
          // the new track swells up smoothly out of the floor.
          await sharedRamper.rampShaped(original, getZone, transport, inMs, "out");
        }

        const verb = dir === "next" ? "skipped to next" : "went to previous";
        return {
          content: [{ type: "text", text: `Smooth skip: ducked to ${floor}, ${verb} track, rode the fade-in back to ${original} in zone '${foundZone.display_name}'.` }],
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

  server.tool(
    "mute_toggle",
    "Toggle mute for a Roon zone: if every volume output is muted, unmute all; otherwise mute all. Mirrors the HTTP /control/mute_toggle used by roon-key. Use this when you want a single toggle rather than setting an explicit mute state.",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const getZone = () => roonConnection.findZone(foundZone.display_name);

        const volOutputs = foundZone.outputs.filter((o) => o.volume);
        if (volOutputs.length === 0) {
          return {
            content: [{ type: "text", text: `No volume-controllable outputs in zone '${foundZone.display_name}'.` }],
          };
        }
        // Mirror the ramper's own rule: all-muted -> unmute, else mute.
        const willUnmute = volOutputs.every((o) => o.volume?.is_muted === true);

        await sharedRamper.toggleMute(getZone, transport);

        return {
          content: [{ type: "text", text: `${willUnmute ? "Unmuted" : "Muted"} zone '${foundZone.display_name}'.` }],
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
    "volume_preset",
    "Set a Roon zone to one of the configured roon-key volume presets, addressed by 1-based index. Smoothly ramps by default, or jumps instantly with instant=true. Presets are read from roon-key config; mirrors HTTP /control/volume_preset.",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      index: z.number().int().positive().describe("1-based preset index into the configured presets list"),
      instant: z
        .boolean()
        .default(false)
        .describe("If true, jump instantly; otherwise ramp smoothly to the preset level"),
    },
    async ({ zone, index, instant }): Promise<ToolResult> => {
      try {
        const cfg = readRoonKeyConfig();
        if (index > cfg.presets.length) {
          return {
            content: [{ type: "text", text: `Preset index ${index} out of range (${cfg.presets.length} presets configured: ${cfg.presets.join(", ")}).` }],
            isError: true,
          };
        }
        const target = cfg.presets[index - 1];

        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const getZone = () => roonConnection.findZone(foundZone.display_name);
        const useInstant = instant === true;

        if (useInstant) {
          await sharedRamper.instantAbsolute(target, getZone, transport);
        } else {
          // Fire and forget the ramp, like the HTTP preset path.
          sharedRamper
            .rampAbsolute(target, getZone, transport, cfg.ramp_step_ms)
            .catch((e: unknown) => console.error("[volume_preset] error:", e));
        }

        return {
          content: [{ type: "text", text: `Preset ${index} -> volume ${target}${useInstant ? " (instant)" : ""} in zone '${foundZone.display_name}'.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );
}
