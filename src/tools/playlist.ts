/**
 * Provider-neutral playlist MCP tools. Names carry no provider prefix; an
 * optional `provider` arg overrides the configured default. All Qobuz/Tidal
 * specifics stay behind the MusicProvider port.
 *
 * Gated by env: set PLAYLIST_TOOLS=0 to omit these tools entirely.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initProviders } from "../providers/bootstrap.js";
import type { MusicProvider, ProviderName } from "../providers/types.js";

const providerArg = z
  .enum(["qobuz", "tidal"])
  .optional()
  .describe("Music provider; defaults to the configured default provider");

function resolve(provider?: ProviderName): MusicProvider {
  return initProviders().get(provider);
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(e: unknown) {
  return {
    content: [{ type: "text" as const, text: String(e instanceof Error ? e.message : e) }],
    isError: true as const,
  };
}

export function registerPlaylistTools(server: McpServer): void {
  if (process.env.PLAYLIST_TOOLS === "0") return;

  server.tool(
    "search_tracks",
    "Search a music provider for tracks. Returns track IDs (use them with add_tracks_to_playlist).",
    {
      query: z.string().describe("Search query"),
      limit: z.number().int().positive().max(50).optional().describe("Max results (default 10)"),
      provider: providerArg,
    },
    async ({ query, limit, provider }) => {
      try {
        const tracks = await resolve(provider).searchTracks(query, limit ?? 10);
        if (tracks.length === 0) return ok(`No tracks found for "${query}".`);
        return ok(
          `Tracks for "${query}":\n` +
            tracks
              .map(
                (t) =>
                  `  ID: ${t.id} | ${t.title} — ${t.artist}${t.album ? ` [${t.album}]` : ""}`,
              )
              .join("\n"),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_playlists",
    "List the current user's playlists for a music provider.",
    {
      limit: z.number().int().positive().max(500).optional().describe("Max playlists (default 20)"),
      provider: providerArg,
    },
    async ({ limit, provider }) => {
      try {
        const pls = await resolve(provider).listPlaylists(limit ?? 20);
        if (pls.length === 0) return ok("No playlists.");
        return ok(
          pls
            .map(
              (p) =>
                `  ID: ${p.id} | ${p.name} (${p.trackCount} tracks, ${p.isPublic ? "public" : "private"})`,
            )
            .join("\n"),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_playlist",
    "Get a playlist's details and tracks (with track IDs).",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      limit: z.number().int().positive().max(500).optional().describe("Max tracks (default 50)"),
      provider: providerArg,
    },
    async ({ playlist_id, limit, provider }) => {
      try {
        const { playlist, tracks } = await resolve(provider).getPlaylist(
          playlist_id,
          limit ?? 50,
        );
        return ok(
          `${playlist.name} (${playlist.trackCount} tracks, ${playlist.isPublic ? "public" : "private"})\n` +
            tracks
              .map((t) => `  ID: ${t.id} | ${t.title} — ${t.artist}`)
              .join("\n"),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_playlist",
    "Create a new playlist on a music provider.",
    {
      name: z.string().describe("Playlist name"),
      description: z.string().optional().describe("Optional description"),
      is_public: z.boolean().optional().describe("Public playlist (default false)"),
      provider: providerArg,
    },
    async ({ name, description, is_public, provider }) => {
      try {
        const pl = await resolve(provider).createPlaylist(name, {
          description,
          isPublic: is_public,
        });
        return ok(`Created "${pl.name}". ID: ${pl.id}`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "add_tracks_to_playlist",
    "Add tracks (by track ID) to a playlist. Find IDs with search_tracks.",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      track_ids: z.array(z.string()).min(1).describe("Track IDs to add"),
      provider: providerArg,
    },
    async ({ playlist_id, track_ids, provider }) => {
      try {
        await resolve(provider).addTracks(playlist_id, track_ids);
        return ok(`Added ${track_ids.length} track(s) to playlist ${playlist_id}.`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "remove_tracks_from_playlist",
    "Remove tracks (by track ID) from a playlist.",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      track_ids: z.array(z.string()).min(1).describe("Track IDs to remove"),
      provider: providerArg,
    },
    async ({ playlist_id, track_ids, provider }) => {
      try {
        await resolve(provider).removeTracks(playlist_id, track_ids);
        return ok(`Removed ${track_ids.length} track(s) from playlist ${playlist_id}.`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "rename_playlist",
    "Rename a playlist.",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      name: z.string().describe("New playlist name"),
      provider: providerArg,
    },
    async ({ playlist_id, name, provider }) => {
      try {
        await resolve(provider).renamePlaylist(playlist_id, name);
        return ok(`Renamed playlist ${playlist_id} to "${name}".`);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "reorder_playlist_tracks",
    "Move tracks already in a playlist to a new 0-based position (to_index).",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      track_ids: z.array(z.string()).min(1).describe("Track IDs to move (must already be in the playlist)"),
      to_index: z
        .number()
        .int()
        .min(0)
        .describe("0-based index the tracks should land at"),
      provider: providerArg,
    },
    async ({ playlist_id, track_ids, to_index, provider }) => {
      try {
        await resolve(provider).moveTracks(playlist_id, track_ids, to_index);
        return ok(
          `Moved ${track_ids.length} track(s) to index ${to_index} in playlist ${playlist_id}.`,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "insert_tracks_at",
    "Add tracks to a playlist at a specific 0-based position (append then move).",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      track_ids: z.array(z.string()).min(1).describe("Track IDs to insert"),
      at_index: z
        .number()
        .int()
        .min(0)
        .describe("0-based index where the inserted tracks should land"),
      provider: providerArg,
    },
    async ({ playlist_id, track_ids, at_index, provider }) => {
      try {
        await resolve(provider).insertTracksAt(playlist_id, track_ids, at_index);
        return ok(
          `Inserted ${track_ids.length} track(s) at index ${at_index} in playlist ${playlist_id}.`,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_playlist",
    "Delete a playlist. IRREVERSIBLE — requires confirm: true.",
    {
      playlist_id: z.string().describe("Provider playlist ID"),
      confirm: z
        .boolean()
        .describe("Must be true to actually delete (guards against accidental deletion)"),
      provider: providerArg,
    },
    async ({ playlist_id, confirm, provider }) => {
      if (confirm !== true) {
        return err(
          `Refusing to delete playlist ${playlist_id}: pass confirm: true to proceed.`,
        );
      }
      try {
        await resolve(provider).deletePlaylist(playlist_id);
        return ok(`Deleted playlist ${playlist_id}.`);
      } catch (e) {
        return err(e);
      }
    },
  );
}
