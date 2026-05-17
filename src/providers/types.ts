/**
 * Provider-neutral music-service contract.
 *
 * roon-bridge speaks Roon for playback/browse. Playlist *write* lives behind
 * this port so the MCP tool surface stays provider-agnostic: adding Tidal (or
 * swapping providers) means implementing MusicProvider, not changing tools.
 */

export type ProviderName = "qobuz" | "tidal";

export interface ProviderTrack {
  provider: ProviderName;
  /** Provider-native track id. */
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  /** Cross-provider join key — enables e.g. cloning a Qobuz playlist to Tidal. */
  isrc?: string;
}

export interface ProviderPlaylist {
  provider: ProviderName;
  id: string;
  name: string;
  trackCount: number;
  isPublic: boolean;
  description?: string;
}

export interface MusicProvider {
  readonly name: ProviderName;

  searchTracks(query: string, limit?: number): Promise<ProviderTrack[]>;

  listPlaylists(limit?: number): Promise<ProviderPlaylist[]>;
  getPlaylist(
    id: string,
    limit?: number,
  ): Promise<{ playlist: ProviderPlaylist; tracks: ProviderTrack[] }>;

  createPlaylist(
    name: string,
    opts?: { description?: string; isPublic?: boolean },
  ): Promise<ProviderPlaylist>;
  addTracks(playlistId: string, trackIds: string[]): Promise<void>;
  removeTracks(playlistId: string, trackIds: string[]): Promise<void>;
  renamePlaylist(playlistId: string, name: string): Promise<void>;
  deletePlaylist(playlistId: string): Promise<void>;
}

/** Kinds of provider failure callers may want to branch on. */
export type ProviderErrorKind =
  | "auth" // token missing/expired — user must run the refresher
  | "not_found"
  | "rate_limited"
  | "api" // provider returned an error response
  | "config"; // provider not enabled / not registered

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider?: ProviderName,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
