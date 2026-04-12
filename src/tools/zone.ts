import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type { QueueItem } from "node-roon-api-transport";

export function registerZoneTools(server: McpServer): void {
  server.tool(
    "list_zones",
    "List all available Roon zones with their current playback status",
    {},
    async () => {
      try {
        // Ensure we're connected (will throw if not)
        roonConnection.getTransport();

        const zones = roonConnection.getZones();
        if (zones.length === 0) {
          return {
            content: [{ type: "text", text: "No zones found. Is Roon running?" }],
          };
        }

        const zoneList = zones.map((zone) => {
          const np = zone.now_playing;
          const nowPlaying = np
            ? `${np.three_line.line1}${np.three_line.line2 ? ` - ${np.three_line.line2}` : ""}${np.three_line.line3 ? ` (${np.three_line.line3})` : ""}`
            : "Nothing playing";

          return [
            `Zone: ${zone.display_name}`,
            `  State: ${zone.state}`,
            `  Now Playing: ${nowPlaying}`,
            np?.seek_position != null && np?.length
              ? `  Position: ${formatTime(np.seek_position)} / ${formatTime(np.length)}`
              : null,
            zone.queue_items_remaining
              ? `  Queue: ${zone.queue_items_remaining} items remaining`
              : null,
          ]
            .filter(Boolean)
            .join("\n");
        });

        return {
          content: [{ type: "text", text: zoneList.join("\n\n") }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "now_playing",
    "Get detailed information about what is currently playing in a Roon zone",
    {
      zone: z.string().optional().describe("Zone name or ID. If omitted, returns info for all playing zones"),
    },
    async ({ zone }) => {
      try {
        roonConnection.getTransport();

        if (zone) {
          const z = roonConnection.findZoneOrThrow(zone);
          return {
            content: [{ type: "text", text: formatNowPlaying(z) }],
          };
        }

        // Return all zones that are playing
        const zones = roonConnection.getZones();
        const playing = zones.filter((z) => z.now_playing);

        if (playing.length === 0) {
          return {
            content: [{ type: "text", text: "Nothing is currently playing in any zone." }],
          };
        }

        const result = playing.map(formatNowPlaying).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "set_default_zone",
    "Set the default Roon zone used when no zone is specified in other commands. Persists across restarts.",
    {
      zone: z.string().describe("Zone name or ID to set as default"),
    },
    async ({ zone }) => {
      try {
        const name = roonConnection.setDefaultZone(zone);
        return {
          content: [{ type: "text", text: `Default zone set to '${name}'. All future commands will use this zone unless overridden.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_queue",
    "Get the play queue for a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => {
      try {
        const transport = roonConnection.getTransport();
        const z = roonConnection.findZoneOrThrow(zone);

        const items = await new Promise<QueueItem[]>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Queue request timed out")), 5000);

          const sub = transport.subscribe_queue(z, 100, (response, msg) => {
            if (response === "Subscribed") {
              clearTimeout(timeout);
              resolve(msg.items || []);
              // Unsubscribe after getting the initial data
              try { sub.unsubscribe(); } catch { /* ignore */ }
            }
          });
        });

        if (items.length === 0) {
          return {
            content: [{ type: "text", text: `Queue for '${z.display_name}' is empty.` }],
          };
        }

        const lines = [`Queue for '${z.display_name}' (${items.length} items):\n`];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const duration = item.length ? ` [${formatTime(item.length)}]` : "";
          const artist = item.two_line.line2 ? ` - ${item.two_line.line2}` : "";
          lines.push(`${i + 1}. ${item.two_line.line1}${artist}${duration}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );
}

function formatNowPlaying(zone: { display_name: string; state: string; now_playing?: { seek_position?: number; length?: number; three_line: { line1: string; line2?: string; line3?: string } }; settings?: { shuffle: boolean; loop: string; auto_radio: boolean } }): string {
  const np = zone.now_playing;
  if (!np) {
    return `${zone.display_name}: Nothing playing (${zone.state})`;
  }

  const lines = [
    `Zone: ${zone.display_name}`,
    `State: ${zone.state}`,
    `Track: ${np.three_line.line1}`,
  ];

  if (np.three_line.line2) lines.push(`Artist: ${np.three_line.line2}`);
  if (np.three_line.line3) lines.push(`Album: ${np.three_line.line3}`);

  if (np.seek_position != null && np.length) {
    lines.push(`Position: ${formatTime(np.seek_position)} / ${formatTime(np.length)}`);
  }

  if (zone.settings) {
    const settings = [];
    if (zone.settings.shuffle) settings.push("Shuffle");
    if (zone.settings.loop !== "disabled") settings.push(`Loop: ${zone.settings.loop}`);
    if (zone.settings.auto_radio) settings.push("Radio");
    if (settings.length > 0) lines.push(`Settings: ${settings.join(", ")}`);
  }

  return lines.join("\n");
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
