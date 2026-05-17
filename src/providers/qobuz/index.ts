/**
 * Qobuz adapter implementing the provider-neutral MusicProvider port.
 *
 * Response field mapping mirrors qobuz-mcp/server.py (proven against a live
 * account). Credentials are assembled lazily and memoized: browser-free
 * app_id/app_secret + token.json user token.
 */

import {
  type MusicProvider,
  type ProviderPlaylist,
  type ProviderTrack,
  ProviderError,
} from "../types.js";
import { QobuzClient } from "./client.js";
import { getQobuzCredentials } from "./token.js";

interface QobuzTrack {
  id?: number | string;
  title?: string;
  duration?: number;
  isrc?: string;
  performer?: { name?: string };
  album?: { title?: string };
  /** Position-scoped id within a playlist; required by playlist/deleteTracks. */
  playlist_track_id?: number | string;
}
interface QobuzPlaylist {
  id?: number | string;
  name?: string;
  description?: string;
  is_public?: boolean;
  tracks_count?: number;
}

function mapTrack(t: QobuzTrack): ProviderTrack {
  return {
    provider: "qobuz",
    id: String(t.id ?? ""),
    title: t.title ?? "",
    artist: t.performer?.name ?? "Unknown",
    album: t.album?.title || undefined,
    durationSec: typeof t.duration === "number" ? t.duration : undefined,
    isrc: t.isrc || undefined,
  };
}
function mapPlaylist(p: QobuzPlaylist): ProviderPlaylist {
  return {
    provider: "qobuz",
    id: String(p.id ?? ""),
    name: p.name ?? "",
    trackCount: p.tracks_count ?? 0,
    isPublic: Boolean(p.is_public),
    description: p.description || undefined,
  };
}

export class QobuzProvider implements MusicProvider {
  readonly name = "qobuz" as const;
  private client: QobuzClient | null = null;
  private userId = "";

  private async api(): Promise<QobuzClient> {
    if (!this.client) {
      const creds = await getQobuzCredentials();
      this.userId = creds.userId;
      this.client = new QobuzClient(creds);
    }
    return this.client;
  }

  async searchTracks(query: string, limit = 10): Promise<ProviderTrack[]> {
    const api = await this.api();
    const data = await api.request("GET", "catalog/search", {
      query,
      type: "tracks",
      limit: Math.min(limit, 50),
      offset: 0,
    });
    const items =
      ((data.tracks as { items?: QobuzTrack[] })?.items) ?? [];
    return items.map(mapTrack);
  }

  async listPlaylists(limit = 20): Promise<ProviderPlaylist[]> {
    const api = await this.api();
    const data = await api.request("GET", "playlist/getUserPlaylists", {
      user_id: this.userId,
      limit,
      offset: 0,
    });
    const items =
      ((data.playlists as { items?: QobuzPlaylist[] })?.items) ?? [];
    return items.map(mapPlaylist);
  }

  async getPlaylist(
    id: string,
    limit = 500,
  ): Promise<{ playlist: ProviderPlaylist; tracks: ProviderTrack[] }> {
    const api = await this.api();
    const data = await api.request("GET", "playlist/get", {
      playlist_id: id,
      limit,
      offset: 0,
      extra: "tracks",
    });
    if (!data.id && !data.name) {
      throw new ProviderError("not_found", `Qobuz playlist ${id} not found`, "qobuz");
    }
    const tracks =
      ((data.tracks as { items?: QobuzTrack[] })?.items) ?? [];
    return {
      playlist: mapPlaylist(data as QobuzPlaylist),
      tracks: tracks.map(mapTrack),
    };
  }

  async createPlaylist(
    name: string,
    opts: { description?: string; isPublic?: boolean } = {},
  ): Promise<ProviderPlaylist> {
    const api = await this.api();
    const data = await api.request("POST", "playlist/create", {
      name,
      description: opts.description ?? "",
      is_public: opts.isPublic ? "1" : "0",
      is_collaborative: "0",
    });
    const pl =
      (data.id ? data : (data.playlist as Record<string, unknown> | undefined)) ??
      undefined;
    if (!pl?.id) {
      throw new ProviderError(
        "api",
        `Qobuz playlist create failed: ${JSON.stringify(data).slice(0, 200)}`,
        "qobuz",
      );
    }
    return mapPlaylist(pl as QobuzPlaylist);
  }

  async addTracks(playlistId: string, trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    const api = await this.api();
    await api.request("POST", "playlist/addTracks", {
      playlist_id: playlistId,
      track_ids: trackIds.join(","),
    });
  }

  /** Page through every track row (Qobuz caps a page at 500). */
  private async fetchAllItems(playlistId: string): Promise<QobuzTrack[]> {
    const api = await this.api();
    const pageSize = 500;
    const out: QobuzTrack[] = [];
    let offset = 0;
    for (;;) {
      const raw = await api.request("GET", "playlist/get", {
        playlist_id: playlistId,
        limit: pageSize,
        offset,
        extra: "tracks",
      });
      const t = raw.tracks as { items?: QobuzTrack[]; total?: number } | undefined;
      const items = t?.items ?? [];
      out.push(...items);
      const total = t?.total ?? out.length;
      offset += items.length;
      if (items.length === 0 || offset >= total) break;
    }
    return out;
  }

  /** playlist_track_id for each requested catalog id, in playlist order. */
  private positionIdsFor(items: QobuzTrack[], trackIds: string[]): string[] {
    const wanted = new Set(trackIds.map(String));
    return items
      .filter((t) => wanted.has(String(t.id ?? "")))
      .map((t) => t.playlist_track_id)
      .filter((v): v is number | string => v !== undefined)
      .map(String);
  }

  async removeTracks(playlistId: string, trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    const api = await this.api();
    // deleteTracks works on per-playlist row ids, not catalog ids — resolve
    // them from the full (paged) playlist so big playlists work too.
    const items = await this.fetchAllItems(playlistId);
    const positionIds = this.positionIdsFor(items, trackIds);
    if (positionIds.length === 0) {
      throw new ProviderError(
        "not_found",
        `None of the given tracks are in playlist ${playlistId}`,
        "qobuz",
      );
    }
    await api.request("POST", "playlist/deleteTracks", {
      playlist_id: playlistId,
      playlist_track_ids: positionIds.join(","),
    });
  }

  /**
   * NOTE: Qobuz's playlist/updateTracksPosition `insert_before` is not a
   * clean target index — probing shows its effective landing position
   * shifts with move direction (it appears to operate on an internal
   * post-removal representation). Treat toIndex as "near here", not exact.
   * Verified good enough for restore/relocate; not for pixel-precise order.
   */
  async moveTracks(
    playlistId: string,
    trackIds: string[],
    toIndex: number,
  ): Promise<void> {
    if (trackIds.length === 0) return;
    const api = await this.api();
    const items = await this.fetchAllItems(playlistId);
    const positionIds = this.positionIdsFor(items, trackIds);
    if (positionIds.length === 0) {
      throw new ProviderError(
        "not_found",
        `None of the given tracks are in playlist ${playlistId}`,
        "qobuz",
      );
    }
    const idx = Math.max(0, Math.min(toIndex, items.length - 1));
    await api.request("POST", "playlist/updateTracksPosition", {
      playlist_id: playlistId,
      playlist_track_ids: positionIds.join(","),
      insert_before: idx,
    });
  }

  async insertTracksAt(
    playlistId: string,
    trackIds: string[],
    atIndex: number,
  ): Promise<void> {
    if (trackIds.length === 0) return;
    const api = await this.api();
    // Qobuz addTracks is append-only, so append then move the new rows.
    const before = await this.fetchAllItems(playlistId);
    await api.request("POST", "playlist/addTracks", {
      playlist_id: playlistId,
      track_ids: trackIds.join(","),
    });
    const after = await this.fetchAllItems(playlistId);
    // New rows are the appended tail beyond the prior length.
    const appended = after.slice(before.length);
    const newPositionIds = appended
      .map((t) => t.playlist_track_id)
      .filter((v): v is number | string => v !== undefined)
      .map(String);
    if (newPositionIds.length === 0) return;
    const idx = Math.max(0, Math.min(atIndex, after.length - 1));
    await api.request("POST", "playlist/updateTracksPosition", {
      playlist_id: playlistId,
      playlist_track_ids: newPositionIds.join(","),
      insert_before: idx,
    });
  }

  async renamePlaylist(playlistId: string, name: string): Promise<void> {
    const api = await this.api();
    await api.request("POST", "playlist/update", {
      playlist_id: playlistId,
      name,
    });
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    const api = await this.api();
    await api.request("POST", "playlist/delete", { playlist_id: playlistId });
  }
}
