import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerZoneTools } from "./tools/zone.js";
import { registerPlaybackTools } from "./tools/playback.js";
import { registerVolumeTools } from "./tools/volume.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerQueueTools } from "./tools/queue.js";
import { registerVersionTools } from "./tools/versions.js";
import { registerRoonPlaylistTools } from "./tools/roon-playlists.js";
import { registerPlaylistTools } from "./tools/playlist.js";
import { registerPlayByIdTools } from "./tools/play-by-id.js";
import { registerAlbumByIdTools } from "./tools/album-by-id.js";
import { registerEditQueueTools } from "./tools/edit-queue.js";
import { registerDeferredTools } from "./tools/deferred.js";
import { registerTopologyTools } from "./tools/topology.js";

/**
 * Create and configure a fresh MCP server instance.
 * Each HTTP session gets its own McpServer so that browse state,
 * session counters, etc. are isolated between clients.
 *
 * This is the single source of truth for "every registered tool" - the
 * transport-realism test layer (tests/transport-realism.test.ts) imports it
 * directly so new tools are covered automatically, without hand-listing.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "roon-bridge",
    version: "1.0.0",
  });

  registerZoneTools(server);
  registerPlaybackTools(server);
  registerVolumeTools(server);
  registerBrowseTools(server);
  registerQueueTools(server);
  registerVersionTools(server);
  registerRoonPlaylistTools(server);
  registerPlaylistTools(server);
  registerPlayByIdTools(server);
  registerAlbumByIdTools(server);
  registerEditQueueTools(server);
  registerDeferredTools(server);
  registerTopologyTools(server);

  return server;
}
