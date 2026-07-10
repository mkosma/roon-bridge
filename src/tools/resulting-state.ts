/**
 * Shared post-action state read and harness-safe interrupt argument.
 *
 * Two things every mutating tool needs, factored here so they behave
 * identically everywhere:
 *
 *   1. resultingState(zone) - a compact snapshot of what the zone looks like
 *      AFTER a mutation (now-playing, queue head/count, volume). Appended to a
 *      mutating tool's success payload so the caller does not have to issue a
 *      follow-up get_queue / now_playing read to learn what actually happened,
 *      and so a claim of success always carries the state that backs it.
 *
 *   2. immediateBool - the boolean interrupt switch, hardened against the MCP
 *      harness that stringifies scalars. Some clients send `"true"` / `"false"`
 *      (strings) instead of real booleans; a plain z.boolean() rejects those with
 *      -32602 before the handler ever runs (the 2026-07-05 "play The National"
 *      failure). This accepts either form. NOT z.coerce.boolean(), which maps the
 *      string "false" to true - the opposite of safe.
 */

import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import { VolumeRamper } from "../control/volume-ramper.js";
import type { Zone, QueueItem } from "node-roon-api-transport";

/** The state block appended to every mutating tool's success payload. */
export interface ResultingState {
  zone: string;
  state: string | null;
  now_playing: { track: string | null; artist: string | null; seek_position: number | null } | null;
  queue_head: string[];
  queue_count: number | null;
  volume: { value: number | null } | null;
  read_at: string;
}

function queueTitle(item: QueueItem): string {
  return item.three_line?.line1 ?? item.two_line?.line1 ?? item.one_line?.line1 ?? "(unknown)";
}

/**
 * Read the zone's current state after a mutation. Best-effort and never throws:
 * any field it cannot read is reported as null / empty rather than failing the
 * mutation that already happened. Re-reads the zone for freshness (the passed
 * Zone object may pre-date the mutation) and pulls the queue head/count from a
 * one-shot snapshot.
 */
export async function resultingState(zone: Zone): Promise<ResultingState> {
  let fresh: Zone = zone;
  try {
    fresh = roonConnection.findZone(zone.zone_id) ?? zone;
  } catch {
    fresh = zone;
  }

  const np = fresh.now_playing;
  const now_playing = np
    ? {
        track: np.three_line?.line1 ?? np.two_line?.line1 ?? np.one_line?.line1 ?? null,
        artist: np.three_line?.line2 ?? np.two_line?.line2 ?? null,
        seek_position: np.seek_position ?? null,
      }
    : null;

  let queue_head: string[] = [];
  let queue_count: number | null = null;
  try {
    if (typeof roonConnection.getQueueSnapshot === "function") {
      const items = await roonConnection.getQueueSnapshot(fresh, 200);
      queue_count = items.length;
      // "next" = the upcoming items after the now-playing head (the runway).
      const playing = fresh.state === "playing" || fresh.state === "paused" || fresh.state === "loading";
      const upcoming = playing && items.length > 0 ? items.slice(1) : items;
      queue_head = upcoming.slice(0, 3).map(queueTitle);
    }
  } catch {
    /* leave queue fields at their best-effort defaults */
  }

  let volume: { value: number | null } | null = null;
  try {
    volume = { value: VolumeRamper.currentMaxVolume(fresh) };
  } catch {
    volume = null;
  }

  return {
    zone: fresh.display_name,
    state: fresh.state ?? null,
    now_playing,
    queue_head,
    queue_count,
    volume,
    read_at: new Date().toISOString(),
  };
}

/**
 * Harness-safe boolean: accepts a real boolean OR the strings "true"/"false"
 * (which a scalar-stringifying MCP client sends), normalizing to a boolean.
 * Every public tool boolean param must use this instead of a plain
 * z.boolean() - enforced by tests/no-plain-boolean.test.ts. Wrap with
 * `.optional().default(false).describe(...)` at each call site same as a
 * plain z.boolean() would be.
 */
export function boolish(): z.ZodEffects<z.ZodUnion<[z.ZodBoolean, z.ZodEnum<["true", "false"]>]>, boolean, boolean | "true" | "false"> {
  return z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true");
}

/** The single shared instance used for the `immediate` interrupt switch. */
export const immediateBool = boolish();
