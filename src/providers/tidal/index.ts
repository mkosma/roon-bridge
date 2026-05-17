/**
 * Tidal adapter skeleton. Proves the port is pluggable: it satisfies
 * MusicProvider's type contract and can be registered, but every method
 * fails fast with a clear "not implemented" until someone fills it in.
 * See README.md for the contract and Tidal's OAuth device-flow auth.
 */

import {
  type MusicProvider,
  type ProviderPlaylist,
  type ProviderTrack,
  ProviderError,
} from "../types.js";

function notImplemented(method: string): never {
  throw new ProviderError(
    "config",
    `Tidal adapter is not implemented yet (${method}). See src/providers/tidal/README.md.`,
    "tidal",
  );
}

export class TidalProvider implements MusicProvider {
  readonly name = "tidal" as const;

  async searchTracks(): Promise<ProviderTrack[]> {
    notImplemented("searchTracks");
  }
  async listPlaylists(): Promise<ProviderPlaylist[]> {
    notImplemented("listPlaylists");
  }
  async getPlaylist(): Promise<{ playlist: ProviderPlaylist; tracks: ProviderTrack[] }> {
    notImplemented("getPlaylist");
  }
  async createPlaylist(): Promise<ProviderPlaylist> {
    notImplemented("createPlaylist");
  }
  async addTracks(): Promise<void> {
    notImplemented("addTracks");
  }
  async removeTracks(): Promise<void> {
    notImplemented("removeTracks");
  }
  async moveTracks(): Promise<void> {
    notImplemented("moveTracks");
  }
  async insertTracksAt(): Promise<void> {
    notImplemented("insertTracksAt");
  }
  async renamePlaylist(): Promise<void> {
    notImplemented("renamePlaylist");
  }
  async deletePlaylist(): Promise<void> {
    notImplemented("deletePlaylist");
  }
}
