import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type { ResultCallback } from "node-roon-api-transport";
import { sharedRamper } from "../control/shared-ramper.js";
import { VolumeRamper } from "../control/volume-ramper.js";
import { readRoonKeyConfig } from "../control/roon-key-config.js";
import { resultingState, boolish } from "./resulting-state.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Floor for derived ramp cadence; matches roon-key's ramp_step_ms minimum. */
const MIN_STEP_MS = 5;

/**
 * smooth_skip fade-feel tuning. Iteration 2 (Maya's 2026-06-08 ticket + live
 * re-verify): the iter-1 "wait for the new track to produce audio, THEN fade
 * in" approach REGRESSED the gap - it sat at the floor through Roon's load
 * window (which it cannot observe the true audible-start of), so the net effect
 * was a longer silent gap and still a hard start. Roon cannot overlap two
 * tracks on a manual skip, and there is no event for "audible audio started"
 * (state=playing / seek>0 lead the endpoint's actual output by its buffer), so
 * waiting can only ever lengthen the gap. We therefore do NOT wait: quick duck,
 * skip, then fade straight back up so the fade-in OVERLAPS the natural load gap
 * and rides the opening when the next track is pre-buffered. Worst case (a long
 * load) it degrades to a plain skip's gap, never worse.
 *
 * out-leg quick (minimal added latency, just ducks the outgoing track); in-leg
 * longer so an audible rise remains after the load gap. Tunable live by Maya.
 */
const DEFAULT_FADE_OUT_MS = 500;
const DEFAULT_FADE_IN_MS = 2500;
/**
 * Fade-out floor as a fraction of the original level: duck low (so the new
 * track starts quiet and the fade-in has real range to ride up) without a hard
 * cut to absolute silence on the outgoing track.
 */
const FADE_FLOOR_RATIO = 0.1;
/** Set SMOOTH_SKIP_DEBUG=1 to log the full volume-vs-time timeline per step. */
const DEBUG = process.env.SMOOTH_SKIP_DEBUG === "1";

/**
 * Per-1-unit-step cadence for the default `change_volume` fade. The fade scales
 * with the size of the change: a routine nudge (~8 units) is ~120ms and reads as
 * immediate, while a large, dangerous jump (24 -> 64 = 40 units) is ~600ms - a
 * fast but clearly audible fade, never a slam. This is the mistake-proofing.
 */
const CHANGE_VOLUME_STEP_MS = 15;

/**
 * A change of this magnitude (in volume units) or smaller is applied instantly
 * even without `snap`. Ramping a 1-2 unit nudge is pointless overhead, and a tiny
 * change is never the blast-the-room danger the default fade exists to prevent.
 */
const SMALL_CHANGE_UNITS = 2;

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
    "Change the volume of a Roon zone. By DEFAULT the change applies as a short audible fade (a fast server-side ramp), not an instant jump, so a large change can never slam the room - this is the mistake-proofing for the paused-at-100, hit-play class of accident. The fade scales with the size of the change (a small nudge is near-instant; a big jump like 24->64 is a ~600ms fade). Set snap=true to apply the change instantly (the old behavior). Changes of 2 units or less apply instantly even without snap. A new volume command supersedes any ramp in progress. Honors grouped zones (e.g. WiiM + 1).",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      value: z.number().describe("Volume value (absolute level, or relative adjustment)"),
      how: z
        .enum(["absolute", "relative", "relative_step"])
        .default("absolute")
        .describe("How to interpret the value: 'absolute' sets exact level, 'relative' adds/subtracts, 'relative_step' adjusts by hardware step increments (always instant)"),
      snap: boolish()
        .default(false)
        .describe("If true, jump to the new level instantly (the old behavior); otherwise apply it as a short audible fade. Small changes (<=2 units) snap regardless."),
    },
    async ({ zone, value, how, snap }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const getZone = () => roonConnection.findZone(foundZone.display_name);

        // Decide instant vs ramp. relative_step is a hardware-style incremental
        // nudge with no numeric unit we can ramp; it is always applied instantly.
        // A zone with no numeric-volume outputs likewise can only be set directly.
        const currentMax = VolumeRamper.currentMaxVolume(foundZone);
        const canRamp = how !== "relative_step" && currentMax !== null;
        const magnitude = canRamp
          ? how === "absolute"
            ? Math.abs(value - (currentMax as number))
            : Math.abs(value)
          : null;
        const instant =
          snap === true || !canRamp || (magnitude !== null && magnitude <= SMALL_CHANGE_UNITS);

        if (instant) {
          // Cancel any ramp in progress so this command supersedes it, then apply
          // the change immediately - exactly today's per-output transport call.
          sharedRamper.cancel();

          const results: string[] = [];
          const failedOutputs: Array<{ output: string; error: string }> = [];
          for (const output of foundZone.outputs) {
            if (!output.volume) continue;
            const error = await promisifyResult((cb) =>
              transport.change_volume(output, how, value, cb),
            );
            if (error) {
              results.push(`${output.display_name}: Error - ${error}`);
              failedOutputs.push({ output: output.display_name, error: String(error) });
            } else {
              results.push(`${output.display_name}: Volume ${how === "absolute" ? "set to" : "adjusted by"} ${value}`);
            }
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No volume-controllable outputs in zone '${foundZone.display_name}'.` }],
            };
          }

          // Grouped-zone honesty: a partial write (one output errored, e.g. a
          // Muse dropout) is a FAILURE, not a success - flag isError with the
          // per-output detail so a caller checking the flag is not misled.
          const partialFailure = failedOutputs.length > 0;
          const resulting_state = await resultingState(foundZone, "change_volume");
          return {
            content: [{
              type: "text",
              text:
                results.join("\n") + "\n" +
                JSON.stringify({ ok: !partialFailure, ...(partialFailure ? { error: "partial_volume_failure", failed_outputs: failedOutputs } : {}), resulting_state }),
            }],
            isError: partialFailure,
          };
        }

        // Default: ramp as a short audible fade. rampAbsolute/rampDelta increment
        // the ramper generation, so this also supersedes an in-progress ramp.
        // Fire and forget; the ramp runs server-side and we return immediately.
        if (how === "absolute") {
          sharedRamper
            .rampAbsolute(value, getZone, transport, CHANGE_VOLUME_STEP_MS)
            .catch((e: unknown) => console.error("[change_volume] error:", e));
        } else {
          sharedRamper
            .rampDelta(value, getZone, transport, CHANGE_VOLUME_STEP_MS)
            .catch((e: unknown) => console.error("[change_volume] error:", e));
        }

        const target = how === "absolute" ? value : (currentMax as number) + value;
        const resulting_state = await resultingState(foundZone, "change_volume");
        return {
          content: [
            {
              type: "text",
              text:
                `Fading '${foundZone.display_name}' from ${currentMax} to ${target} (snap=true to jump instantly). ` +
                `Ramp started, not yet complete.\n` +
                JSON.stringify({ ok: true, ramp: "in_progress", target, resulting_state }),
            },
          ],
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
        const resulting_state = await resultingState(foundZone, "ramp_volume");
        return {
          content: [{
            type: "text",
            text:
              `Ramping '${foundZone.display_name}' from ${currentMax} to ${target} over ${dur}. Ramp started, not yet complete.\n` +
              JSON.stringify({ ok: true, ramp: "in_progress", target, resulting_state }),
          }],
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
    "Soften a manual track change: quickly duck the zone down, change track (next or previous), then fade straight back up so the rise overlaps the opening of the new track. Roon cannot overlap two tracks on a manual skip and exposes no 'audible audio started' signal, so this does NOT wait for the new track (waiting only lengthens the silent gap); it fades up blindly over the natural load gap and rides the opening when the next track is pre-buffered, degrading to a plain skip's gap in the worst case (never worse). Fades are shaped (smooth, non-steppy). The original volume is always restored, even if the skip fails, so there is no stuck-at-low failure mode. A new volume command supersedes the fades.",
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
        .describe(`Duration in ms of the fade-OUT duck. Default ${DEFAULT_FADE_OUT_MS} (quick, adds minimal latency).`),
      fade_in_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Duration in ms of the fade-IN, overlapping the new track's start. Default ${DEFAULT_FADE_IN_MS}.`),
      floor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Absolute volume to duck to before skipping. Lower = more headroom for an audible rise. Default ~10% of the current level."),
      fade_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Convenience: set both legs to this duration. Overridden by fade_out_ms / fade_in_ms when those are given."),
    },
    async ({ zone, direction, fade_out_ms, fade_in_ms, floor: floorArg, fade_ms }): Promise<ToolResult> => {
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
        const floor = Math.min(original, floorArg ?? Math.round(original * FADE_FLOOR_RATIO));

        // Provable timeline: log volume vs the zone's reported state/seek so a
        // live pass can show exactly when the rise happens relative to audio.
        const t0 = Date.now();
        const mark = (msg: string): void => {
          const z = getZone();
          const seek = z?.now_playing?.seek_position ?? "?";
          console.error(`[smooth_skip +${Date.now() - t0}ms] ${msg} | state=${z?.state ?? "?"} seek=${seek}`);
        };
        const stepProbe = DEBUG
          ? (level: number, i: number, n: number): void => mark(`vol=${level} (step ${i}/${n})`)
          : undefined;
        mark(`start: original=${original} floor=${floor} out=${outMs}ms in=${inMs}ms dir=${dir}`);

        try {
          // Quick perceptual duck to the floor on the OUTGOING track. This does
          // not add silence - the old track just plays quieter for outMs. The
          // "perceptual" curve (main's rampCurve) dwells on the low units, where
          // each 1-unit step is a bigger dB jump, so the tail settles into the
          // floor smoothly instead of stepping (ticket diagnosis #2).
          await sharedRamper.rampCurve(floor, getZone, transport, outMs, "perceptual", stepProbe);
          mark("ducked, issuing skip");
          // Perform the manual skip. No wait after this: fading up immediately
          // overlaps Roon's load gap rather than sitting silent through it.
          await new Promise<void>((resolve, reject) => {
            transport.control(foundZone, dir, (err) => {
              if (err) reject(new Error(String(err)));
              else resolve();
            });
          });
          mark("skip issued, fading up");
        } finally {
          // Always fade back up to the original level from wherever we ended up,
          // so a failed skip never leaves the zone stuck low. "perceptual" again
          // so the new track swells up smoothly out of the floor, spending the
          // most time in the low range where steps are most audible.
          await sharedRamper.rampCurve(original, getZone, transport, inMs, "perceptual", stepProbe);
          mark(`fade-in done, restored to ${original}`);
        }

        const verb = dir === "next" ? "skipped to next" : "went to previous";
        const resulting_state = await resultingState(foundZone, "smooth_skip");
        return {
          content: [{
            type: "text",
            text:
              `Smooth skip: ducked to ${floor}, ${verb} track, faded back up to ${original} in zone '${foundZone.display_name}'.\n` +
              JSON.stringify({ ok: true, resulting_state }),
          }],
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
      mute: boolish().describe("true to mute, false to unmute"),
    },
    async ({ zone, mute }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const foundZone = roonConnection.findZoneOrThrow(zone);
        const how = mute ? "mute" : "unmute";

        const results: string[] = [];
        const failedOutputs: Array<{ output: string; error: string }> = [];
        for (const output of foundZone.outputs) {
          if (!output.volume) continue;
          const error = await promisifyResult((cb) => transport.mute(output, how, cb));
          if (error) {
            results.push(`${output.display_name}: Error - ${error}`);
            failedOutputs.push({ output: output.display_name, error: String(error) });
          } else {
            results.push(`${output.display_name}: ${mute ? "Muted" : "Unmuted"}`);
          }
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No volume-controllable outputs in zone '${foundZone.display_name}'.` }],
          };
        }

        const partialFailure = failedOutputs.length > 0;
        const resulting_state = await resultingState(foundZone, "mute");
        return {
          content: [{
            type: "text",
            text:
              results.join("\n") + "\n" +
              JSON.stringify({ ok: !partialFailure, ...(partialFailure ? { error: "partial_mute_failure", failed_outputs: failedOutputs } : {}), resulting_state }),
          }],
          isError: partialFailure,
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

        const resulting_state = await resultingState(foundZone, "mute_toggle");
        return {
          content: [{
            type: "text",
            text: `${willUnmute ? "Unmuted" : "Muted"} zone '${foundZone.display_name}'.\n` + JSON.stringify({ ok: true, resulting_state }),
          }],
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
      instant: boolish()
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

        const resulting_state = await resultingState(foundZone, "volume_preset");
        return {
          content: [{
            type: "text",
            text:
              `Preset ${index} -> volume ${target}${useInstant ? " (instant)" : ""} in zone '${foundZone.display_name}'.` +
              `${useInstant ? "" : " Ramp started, not yet complete."}\n` +
              JSON.stringify({ ok: true, ...(useInstant ? {} : { ramp: "in_progress" }), target, resulting_state }),
          }],
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
