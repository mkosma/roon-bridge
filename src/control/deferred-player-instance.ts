/**
 * The fleet's single DeferredPlayer instance.
 *
 * "Play/replace at the next track seam" must be coordinated across every tool
 * that can arm it (play_album/play_track/play_after_current in browse.ts and
 * queue_tracks/play_tracks after_current in play-by-id.ts). One shared scheduler
 * means an immediate playback from ANY of those tools supersedes a deferral
 * armed by ANY other - which a per-module instance could not guarantee.
 */

import { DeferredPlayer } from "./deferred-player.js";
import { roonConnection } from "../roon-connection.js";

export const deferredPlayer = new DeferredPlayer(roonConnection);
