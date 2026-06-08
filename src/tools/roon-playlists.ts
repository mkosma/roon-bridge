/**
 * roon-playlists.ts: read Roon's OWN playlists (Maya spec P1-B).
 *
 * The provider playlist tools (playlist.ts) talk to Qobuz/Tidal and cannot see
 * Roon-native playlists such as "Hearted Albums & Songs" (~1,655 tracks) or
 * "Roon Discoveries". Those live in the Roon browse tree under the top-level
 * "Playlists" node (the same place Roon's own apps read them).
 *
 * This module navigates the generic `browse` hierarchy:
 *   root -> "Playlists" -> <playlist by name/index> -> tracks (paginated)
 *
 * It exposes:
 *   - list_roon_playlists           : name + browse item_key for each playlist.
 *   - get_roon_playlist             : full track list by name or item_key,
 *                                     paginated (offset/limit), with stable
 *                                     per-row browse item_key ids and a total.
 *
 * Pagination uses Roon's load offset/count so a 1,655-track playlist streams in
 * bounded pages rather than materializing all at once.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import {
  newSessionKey,
  browseAndLoad,
  promisifyLoad,
  stripRoonLinks,
  type BrowseItem,
} from "./search-core.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const HIER = "browse";

/**
 * Roon's playlist browse node prepends action rows before the real tracks - the
 * play-all controls ("Play Playlist", "Shuffle", "Start Radio", ...). They leak
 * in as phantom tracks (e.g. position 1 = `{ title: "Play Playlist", artist:
 * null }`). They carry an action-style title and no artist subtitle, so we drop
 * any header row and any row whose title is a known browse action. Real tracks
 * never collide with these titles in practice.
 */
const PLAYLIST_ACTION_TITLE =
  /^(play playlist|play now|play album|play artist|play|shuffle|add next|queue|add to queue|start radio)$/i;

function isPlaylistActionRow(i: BrowseItem): boolean {
  return i.hint === "header" || PLAYLIST_ACTION_TITLE.test(i.title.trim());
}

/**
 * Reach the list of Roon-native playlists. Navigates browse root, finds the
 * "Playlists" node, and returns its loaded items plus the session key (so a
 * follow-up drill stays in the same browse session).
 */
async function openPlaylistsNode(): Promise<
  | { ok: true; sessionKey: string; items: BrowseItem[] }
  | { ok: false; error: string }
> {
  const browse = roonConnection.getBrowse();
  const sessionKey = newSessionKey();

  // Reset to browse root for this session.
  const root = await browseAndLoad(browse, { hierarchy: HIER, pop_all: true, multi_session_key: sessionKey });
  if (root.error) return { ok: false, error: root.error };
  if (!root.items?.length) return { ok: false, error: "browse root empty" };

  const playlistsNode = root.items.find(
    (i) => i.item_key && i.title.trim().toLowerCase() === "playlists",
  );
  if (!playlistsNode?.item_key) {
    return {
      ok: false,
      error: `No "Playlists" node at browse root. Saw: ${root.items.map((i) => i.title).join(", ")}`,
    };
  }

  // Load all playlists (could be a few hundred; page through fully).
  const listed = await browseAndLoad(
    browse,
    { hierarchy: HIER, item_key: playlistsNode.item_key, multi_session_key: sessionKey },
    1000,
    0,
  );
  if (listed.error) return { ok: false, error: listed.error };

  return { ok: true, sessionKey, items: (listed.items ?? []).filter((i) => i.hint !== "header") };
}

export function registerRoonPlaylistTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_roon_playlists
  // ---------------------------------------------------------------------------
  server.tool(
    "list_roon_playlists",
    "List Roon's OWN playlists (e.g. 'Hearted Albums & Songs', 'Roon Discoveries') - the ones the Qobuz/Tidal playlist tools cannot see. Returns each playlist's name and a stable browse item_key usable with get_roon_playlist.",
    {},
    async (): Promise<ToolResult> => {
      try {
        const opened = await openPlaylistsNode();
        if (!opened.ok) return jsonResult({ ok: false, error: opened.error }, true);
        return jsonResult({
          ok: true,
          count: opened.items.length,
          playlists: opened.items.map((i) => ({
            name: i.title,
            subtitle: i.subtitle ? stripRoonLinks(i.subtitle) : null,
            item_key: i.item_key,
          })),
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_roon_playlist
  // ---------------------------------------------------------------------------
  server.tool(
    "get_roon_playlist",
    "Read a Roon-native playlist's full track list by name (case-insensitive) or item_key, paginated. Targets large lists like 'Hearted Albums & Songs' (~1,655). Returns tracks with stable browse item_keys and the total count.",
    {
      name: z.string().optional().describe("Playlist name (case-insensitive). Provide this OR item_key."),
      item_key: z.string().optional().describe("Playlist browse item_key from list_roon_playlists."),
      offset: z.coerce.number().int().min(0).default(0).describe("0-based track offset for pagination."),
      limit: z.coerce.number().int().min(1).max(1000).default(200).describe("Max tracks to return (default 200, max 1000)."),
    },
    async ({ name, item_key, offset, limit }): Promise<ToolResult> => {
      try {
        if (!name && !item_key) {
          return jsonResult({ ok: false, error: "provide name or item_key" }, true);
        }

        const browse = roonConnection.getBrowse();
        let sessionKey: string;
        let playlistKey = item_key;
        let playlistName = name ?? "";

        // Resolve name -> item_key (and get a session pointed at Playlists).
        const opened = await openPlaylistsNode();
        if (!opened.ok) return jsonResult({ ok: false, error: opened.error }, true);
        sessionKey = opened.sessionKey;

        if (!playlistKey) {
          const wanted = (name ?? "").trim().toLowerCase();
          const match =
            opened.items.find((i) => i.title.trim().toLowerCase() === wanted) ||
            opened.items.find((i) => i.title.toLowerCase().includes(wanted));
          if (!match?.item_key) {
            return jsonResult(
              {
                ok: false,
                error: "playlist_not_found",
                requested: name,
                available: opened.items.map((i) => i.title),
              },
              true,
            );
          }
          playlistKey = match.item_key;
          playlistName = match.title;
        } else {
          const known = opened.items.find((i) => i.item_key === playlistKey);
          if (known) playlistName = known.title;
        }

        // Drill into the playlist. The first level is usually the track list
        // (hint "list"); sometimes it's an intermediate node we must enter.
        const entered = await browseAndLoad(
          browse,
          { hierarchy: HIER, item_key: playlistKey, multi_session_key: sessionKey },
          1,
          0,
        );
        if (entered.error) return jsonResult({ ok: false, error: entered.error, playlist: playlistName }, true);

        const rawTotal = entered.list?.count ?? 0;
        const listTitle = entered.list?.title ?? playlistName;

        // Roon prepends action rows (e.g. "Play Playlist") at the head of the
        // list. Probe the head to count them so positions, total, and
        // pagination offsets are all expressed in terms of real tracks.
        let leadingActionRows = 0;
        const probe = await promisifyLoad(browse, {
          hierarchy: HIER,
          multi_session_key: sessionKey,
          offset: 0,
          count: 10,
        });
        if (probe.error) {
          return jsonResult({ ok: false, error: String(probe.error), playlist: listTitle }, true);
        }
        for (const it of probe.body.items ?? []) {
          if (isPlaylistActionRow(it)) leadingActionRows++;
          else break;
        }
        const total = Math.max(0, rawTotal - leadingActionRows);

        // Page the tracks with Roon load offset/count, shifted past the action
        // rows so the caller's offset addresses real tracks.
        const pageItems: BrowseItem[] = [];
        let cursor = offset + leadingActionRows;
        const rawHardEnd = Math.min(
          offset + limit + leadingActionRows,
          rawTotal || offset + limit + leadingActionRows,
        );
        while (cursor < rawHardEnd) {
          const count = Math.min(100, rawHardEnd - cursor);
          const loaded = await promisifyLoad(browse, {
            hierarchy: HIER,
            multi_session_key: sessionKey,
            offset: cursor,
            count,
          });
          if (loaded.error) {
            return jsonResult({ ok: false, error: String(loaded.error), playlist: listTitle, loaded_so_far: pageItems.length }, true);
          }
          const items = loaded.body.items ?? [];
          pageItems.push(...items);
          cursor += items.length;
          if (items.length < count) break;
        }

        const tracks = pageItems
          .filter((i) => !isPlaylistActionRow(i))
          .map((i, idx) => ({
            position: offset + idx + 1,
            item_key: i.item_key ?? null,
            title: i.title,
            artist: i.subtitle ? stripRoonLinks(i.subtitle) : null,
          }));

        const nextOffset = total > 0 && offset + tracks.length < total ? offset + tracks.length : null;

        return jsonResult({
          ok: true,
          playlist: listTitle,
          total,
          offset,
          returned: tracks.length,
          next_offset: nextOffset,
          tracks,
        });
      } catch (e) {
        return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) }, true);
      }
    },
  );
}
