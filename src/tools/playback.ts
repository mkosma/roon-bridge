import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";

export function registerPlaybackTools(server: McpServer): void {
  server.tool(
    "play",
    "Start playback in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => transportControl(zone, "play"),
  );

  server.tool(
    "pause",
    "Pause playback in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => transportControl(zone, "pause"),
  );

  server.tool(
    "play_pause",
    "Toggle play/pause in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => transportControl(zone, "playpause"),
  );

  server.tool(
    "stop",
    "Stop playback in a Roon zone and release the audio device",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => transportControl(zone, "stop"),
  );

  server.tool(
    "next_track",
    "Skip to the next track in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => transportControl(zone, "next"),
  );

  server.tool(
    "previous_track",
    "Go to the previous track (or start of current track) in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ zone }) => transportControl(zone, "previous"),
  );

  server.tool(
    "seek",
    "Seek to a position within the currently playing track in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      seconds: z.number().describe("Target position in seconds"),
      relative: z
        .boolean()
        .default(false)
        .describe("If true, seek relative to current position (positive = forward, negative = backward). If false, seek to absolute position."),
    },
    async ({ zone: zoneName, seconds, relative }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const zone = roonConnection.findZoneOrThrow(zoneName);

        return new Promise((resolve) => {
          transport.seek(zone, relative ? "relative" : "absolute", seconds, (error) => {
            if (error) {
              resolve({ content: [{ type: "text", text: `Error: ${error}` }], isError: true });
            } else {
              const desc = relative
                ? `Seeked ${seconds > 0 ? "forward" : "backward"} ${Math.abs(seconds)}s`
                : `Seeked to ${formatSeekTime(seconds)}`;
              resolve({
                content: [{ type: "text", text: `${desc} in zone '${zone.display_name}'.` }],
              });
            }
          });
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "shuffle",
    "Enable or disable shuffle mode in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      enabled: z.boolean().describe("true to enable shuffle, false to disable"),
    },
    async ({ zone: zoneName, enabled }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const zone = roonConnection.findZoneOrThrow(zoneName);

        return new Promise((resolve) => {
          transport.change_settings(zone, { shuffle: enabled }, (error) => {
            if (error) {
              resolve({ content: [{ type: "text", text: `Error: ${error}` }], isError: true });
            } else {
              resolve({
                content: [{
                  type: "text",
                  text: `Shuffle ${enabled ? "enabled" : "disabled"} in zone '${zone.display_name}'.`,
                }],
              });
            }
          });
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "loop",
    "Set the loop mode in a Roon zone",
    {
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      mode: z
        .enum(["loop", "loop_one", "disabled", "next"])
        .describe("Loop mode: 'loop' for all, 'loop_one' for single track, 'disabled' to turn off, 'next' to cycle through modes"),
    },
    async ({ zone: zoneName, mode }): Promise<ToolResult> => {
      try {
        const transport = roonConnection.getTransport();
        const zone = roonConnection.findZoneOrThrow(zoneName);

        return new Promise((resolve) => {
          transport.change_settings(zone, { loop: mode }, (error) => {
            if (error) {
              resolve({ content: [{ type: "text", text: `Error: ${error}` }], isError: true });
            } else {
              const modeMap: Record<string, string> = {
                loop: "Loop all",
                loop_one: "Loop one",
                disabled: "Loop off",
                next: "Cycled to next loop mode",
              };
              resolve({
                content: [{
                  type: "text",
                  text: `${modeMap[mode]} in zone '${zone.display_name}'.`,
                }],
              });
            }
          });
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type Control = "play" | "pause" | "playpause" | "stop" | "previous" | "next";

function formatSeekTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

async function transportControl(
  zoneName: string,
  control: Control,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const transport = roonConnection.getTransport();
    const zone = roonConnection.findZoneOrThrow(zoneName);

    return new Promise((resolve) => {
      transport.control(zone, control, (error) => {
        if (error) {
          resolve({
            content: [{ type: "text", text: `Error: ${error}` }],
            isError: true,
          });
        } else {
          const actionMap: Record<Control, string> = {
            play: "Playing",
            pause: "Paused",
            playpause: "Toggled play/pause",
            stop: "Stopped",
            next: "Skipped to next track",
            previous: "Went to previous track",
          };
          resolve({
            content: [
              { type: "text", text: `${actionMap[control]} in zone '${zone.display_name}'.` },
            ],
          });
        }
      });
    });
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
      isError: true,
    };
  }
}
