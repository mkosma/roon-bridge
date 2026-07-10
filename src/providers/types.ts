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
  /** Provider-native album id (needed to anchor a deterministic Roon resolve). */
  albumId?: string;
  /** 1-based position within its album, when the provider exposes it. */
  trackNumber?: number;
  /** Release year (4-digit), derived from the provider's release date. */
  year?: number;
  /** Explicit-content flag (Qobuz `parental_warning`). */
  explicit?: boolean;
  /** Version/edition token, e.g. "Live", "Remastered", "Instrumental" (null = none). */
  version?: string;
  /**
   * True when the recording is flagged as instrumental. Providers expose no
   * dedicated boolean; this is inferred from title/version tokens, so it is a
   * best-effort hint, never authoritative.
   */
  instrumental?: boolean;
  /** Hi-res (>CD quality) availability, when the provider exposes it. */
  hires?: boolean;
  /**
   * Whether the track is in the user's provider library/favorites. Only
   * populated by callers that explicitly ask for it (an extra API round-trip).
   */
  inLibrary?: boolean;
}

export interface ProviderPlaylist {
  provider: ProviderName;
  id: string;
  name: string;
  trackCount: number;
  isPublic: boolean;
  description?: string;
}

export interface ProviderAlbum {
  provider: ProviderName;
  /** Provider-native album id. */
  id: string;
  title: string;
  artist: string;
  trackCount: number;
  /** Release year (4-digit), derived from the provider's release date. */
  year?: number;
  /** Explicit-content flag, when the provider exposes one at the album level. */
  explicit?: boolean;
  /** Hi-res (>CD quality) availability, when the provider exposes it. */
  hires?: boolean;
}

export interface MusicProvider {
  readonly name: ProviderName;

  searchTracks(query: string, limit?: number): Promise<ProviderTrack[]>;

  /** Fetch one track's full metadata by its provider-native id. */
  getTrack(id: string): Promise<ProviderTrack>;

  /** Search for albums, returning stable provider-native album ids. */
  searchAlbums(query: string, limit?: number): Promise<ProviderAlbum[]>;

  /** Fetch one album's metadata by its provider-native id. */
  getAlbum(id: string): Promise<ProviderAlbum>;

  /**
   * Given provider track ids, return the subset that are in the user's
   * library/favorites. Implementations should tolerate unknown ids (omit them).
   */
  tracksInLibrary(ids: string[]): Promise<Set<string>>;

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
  /** Move tracks already in the playlist to a 0-based target index. */
  moveTracks(playlistId: string, trackIds: string[], toIndex: number): Promise<void>;
  /** Append the given tracks, then move them to a 0-based target index. */
  insertTracksAt(playlistId: string, trackIds: string[], atIndex: number): Promise<void>;
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
