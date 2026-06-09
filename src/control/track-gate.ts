/**
 * waitForTrackStart: gate a smooth_skip fade-IN on the NEW track actually
 * producing audio, not just on the skip command returning.
 *
 * The defect this fixes: after a manual skip, the skip control callback returns
 * during the dead-air gap, BEFORE the next track is playing. If the fade-in
 * starts then, volume is already back up by the time audio begins and the track
 * just hard-starts with no audible fade. So we wait until Roon reports the zone
 * playing a DIFFERENT track with its seek position advancing (real audio is
 * flowing) before letting the fade-in run.
 *
 * Event-driven, mirroring DeferredPlayer: we watch the zone's "zone-seek" tick
 * (emitted only while audio progresses) and "zones-changed". A timeout fallback
 * guarantees the fade-in (and the volume-restore guarantee) still happens even
 * if the expected events never arrive (paused, edge cases, a failed skip).
 */

import type { Zone, NowPlaying } from "node-roon-api-transport";

/** The slice of roonConnection the gate needs; lets tests inject a fake. */
export interface ZoneEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Stable identity for a track, so a skip is detected as a key change. */
export function trackKeyOf(np: NowPlaying | null | undefined): string {
  if (!np) return "";
  return `${np.three_line?.line1 ?? ""}|${np.three_line?.line2 ?? ""}|${np.length ?? ""}`;
}

/** True once the zone is playing a different track than before with audio flowing. */
function newTrackHasAudio(zone: Zone | null, prevTrackKey: string): boolean {
  if (!zone || zone.state !== "playing") return false;
  const np = zone.now_playing;
  if (!np) return false;
  if (trackKeyOf(np) === prevTrackKey) return false;
  return (np.seek_position ?? 0) > 0;
}

export interface TrackStartOptions {
  timeoutMs: number;
}

/**
 * Resolve once the zone (by id) is playing a NEW track with its seek advancing,
 * or after `timeoutMs` as a fallback. Returns "playing" when gated on real
 * audio, "timeout" when it fell back.
 *
 * `getZone` reads the current zone snapshot (the same closure the caller uses
 * elsewhere); `zoneId` filters the per-zone seek events.
 */
export function waitForTrackStart(
  source: ZoneEventSource,
  getZone: () => Zone | null,
  zoneId: string,
  prevTrackKey: string,
  opts: TrackStartOptions,
): Promise<"playing" | "timeout"> {
  // Already there (the new track was detectable before we attached): resolve now.
  if (newTrackHasAudio(getZone(), prevTrackKey)) {
    return Promise.resolve("playing");
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (how: "playing" | "timeout"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.off("zone-seek", onSeek);
      source.off("zones-changed", onChange);
      resolve(how);
    };

    const check = (): void => {
      if (newTrackHasAudio(getZone(), prevTrackKey)) finish("playing");
    };
    const onSeek = (...args: unknown[]): void => {
      if (String(args[0]) === zoneId) check();
    };
    const onChange = (): void => check();

    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
    source.on("zone-seek", onSeek);
    source.on("zones-changed", onChange);
    // Re-check in case the track flipped between the initial test and attach.
    check();
  });
}
