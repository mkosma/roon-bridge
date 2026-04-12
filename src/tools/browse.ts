import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import type RoonApiBrowse from "node-roon-api-browse";
import type {
  BrowseOptions,
  BrowseResult,
  LoadOptions,
  LoadResult,
  BrowseItem,
} from "node-roon-api-browse";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

let sessionCounter = 0;

function newSessionKey(): string {
  return `mcp-${++sessionCounter}`;
}

function promisifyBrowse(
  browse: RoonApiBrowse,
  opts: BrowseOptions,
): Promise<{ error: false | string; body: BrowseResult }> {
  return new Promise((resolve) =>
    browse.browse(opts, (error, body) => resolve({ error, body })),
  );
}

function promisifyLoad(
  browse: RoonApiBrowse,
  opts: LoadOptions,
): Promise<{ error: false | string; body: LoadResult }> {
  return new Promise((resolve) =>
    browse.load(opts, (error, body) => resolve({ error, body })),
  );
}

/**
 * Strip Roon's internal link format from text.
 * Roon subtitles may contain `[[12345|Artist Name]]` — extract just the name.
 */
function stripRoonLinks(text: string): string {
  return text.replace(/\[\[\d+\|([^\]]+)\]\]/g, "$1");
}

function formatItems(items: BrowseItem[]): string {
  return items
    .filter((item) => item.hint !== "header")
    .map((item, i) => {
      const sub = item.subtitle ? ` - ${stripRoonLinks(item.subtitle)}` : "";
      return `${i + 1}. ${item.title}${sub}`;
    })
    .join("\n");
}

interface BrowseAndLoadResult {
  error: string | null;
  navigated: boolean;
  list?: BrowseResult["list"];
  items?: BrowseItem[];
  message?: string;
}

async function browseAndLoad(
  browse: RoonApiBrowse,
  browseOpts: BrowseOptions,
  loadCount = 100,
): Promise<BrowseAndLoadResult> {
  const result = await promisifyBrowse(browse, browseOpts);

  if (result.error) {
    return { error: String(result.error), navigated: false };
  }

  if (result.body.action === "message") {
    return { error: null, navigated: false, message: result.body.message || "Done" };
  }

  if (result.body.action !== "list" || !result.body.list) {
    return { error: null, navigated: false, list: result.body.list, items: [] };
  }

  const loaded = await promisifyLoad(browse, {
    hierarchy: browseOpts.hierarchy,
    multi_session_key: browseOpts.multi_session_key,
    count: loadCount,
  });

  if (loaded.error) {
    return { error: String(loaded.error), navigated: true };
  }

  return { error: null, navigated: true, list: result.body.list, items: loaded.body.items };
}

function bestMatch(items: BrowseItem[], query: string): BrowseItem | undefined {
  const playable = items.filter((item) => item.item_key && item.hint !== "header");
  if (!playable.length) return undefined;

  const lower = query.toLowerCase().trim();
  const queryWords = lower.split(/\s+/).filter((w) => w.length > 1);

  let topScore = -Infinity;
  let topItem = playable[0];

  for (let i = 0; i < playable.length; i++) {
    const item = playable[i];
    const titleLower = item.title.toLowerCase().trim();
    const subtitleLower = stripRoonLinks(item.subtitle || "").toLowerCase();
    let score = 0;

    for (const word of queryWords) {
      if (titleLower.includes(word)) score += 10;
    }

    for (const word of queryWords) {
      if (subtitleLower.includes(word)) score += 5;
    }

    const firstArtist = subtitleLower.split(",")[0].trim();
    for (const word of queryWords) {
      if (word.length > 2 && firstArtist.includes(word)) score += 8;
    }

    if (/\b(tribute|cover[s]?|karaoke|medley|in the style of)\b/i.test(titleLower)) {
      score -= 50;
    }

    score += Math.max(0, 5 - i);

    if (score > topScore) {
      topScore = score;
      topItem = item;
    }
  }

  return topItem;
}

function findAction(items: BrowseItem[], type: "play" | "queue"): BrowseItem | undefined {
  const actionable = items.filter((item) => item.item_key && item.hint !== "header");

  if (type === "play") {
    return (
      actionable.find((item) => item.title.trim().toLowerCase() === "play now") ||
      actionable.find((item) => item.title.trim().toLowerCase() === "play album") ||
      actionable.find(
        (item) =>
          item.title.toLowerCase().startsWith("play") &&
          !item.title.toLowerCase().includes("radio"),
      ) ||
      actionable[0]
    );
  }

  return (
    actionable.find((item) => item.title.trim().toLowerCase() === "queue") ||
    actionable.find((item) => item.title.toLowerCase().includes("queue")) ||
    actionable.find((item) => item.title.trim().toLowerCase() === "play album") ||
    actionable.find(
      (item) =>
        item.title.toLowerCase().startsWith("play") &&
        !item.title.toLowerCase().includes("radio"),
    ) ||
    actionable.find((item) => item.title.trim().toLowerCase() === "play now") ||
    actionable[0]
  );
}

async function searchAndPlay(
  query: string,
  zoneName: string,
  category?: string,
  actionType: "play" | "queue" = "play",
): Promise<ToolResult> {
  try {
    const browse = roonConnection.getBrowse();
    const zone = roonConnection.findZoneOrThrow(zoneName);
    const sessionKey = newSessionKey();
    const hierarchy = "search";
    const log = (step: string, data: unknown) =>
      console.error(`[roon-bridge] searchAndPlay[${sessionKey}] ${step}:`, JSON.stringify(data, null, 2));

    log("start", { query, zoneName: zone.display_name, zoneId: zone.zone_id, category, actionType });

    // Step 1: Start search
    const searchData = await browseAndLoad(browse, {
      hierarchy,
      input: query,
      pop_all: true,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step1-search", {
      error: searchData.error,
      navigated: searchData.navigated,
      itemCount: searchData.items?.length,
      items: searchData.items?.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
    });

    if (searchData.error) {
      return { content: [{ type: "text", text: `Search error: ${searchData.error}` }], isError: true };
    }

    if (!searchData.items?.length) {
      return { content: [{ type: "text", text: `No results found for "${query}".` }] };
    }

    // Step 2: Find the right category
    const categories = searchData.items;
    let targetCategory: BrowseItem | undefined;

    if (category) {
      const catLower = category.toLowerCase();
      targetCategory = categories.find(
        (item) =>
          item.item_key &&
          (item.title.toLowerCase() === catLower + "s" || item.title.toLowerCase() === catLower),
      );
      if (!targetCategory) {
        targetCategory = categories.find(
          (item) =>
            item.item_key &&
            item.title.toLowerCase().includes(catLower) &&
            item.hint !== "header",
        );
      }
    }

    if (!targetCategory) {
      targetCategory = categories.find((item) => item.item_key && item.hint !== "header");
    }

    log("step2-category", { selected: targetCategory?.title, hint: targetCategory?.hint, item_key: targetCategory?.item_key });

    if (!targetCategory?.item_key) {
      return {
        content: [{ type: "text", text: `Search results for "${query}":\n${formatItems(categories)}\n\nNo playable category found.` }],
      };
    }

    // Step 3: Drill into category
    const categoryData = await browseAndLoad(browse, {
      hierarchy,
      item_key: targetCategory.item_key,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step3-categoryItems", {
      error: categoryData.error,
      navigated: categoryData.navigated,
      listTitle: categoryData.list?.title,
      listCount: categoryData.list?.count,
      itemCount: categoryData.items?.length,
      items: categoryData.items?.slice(0, 10).map((i) => ({ title: i.title, subtitle: i.subtitle, hint: i.hint, item_key: i.item_key })),
    });

    if (categoryData.error) {
      return { content: [{ type: "text", text: `Error browsing ${targetCategory.title}: ${categoryData.error}` }], isError: true };
    }

    if (!categoryData.items?.length) {
      return { content: [{ type: "text", text: `No ${targetCategory.title.toLowerCase()} found for "${query}".` }] };
    }

    // Step 4: Select best match
    const matchedResult = bestMatch(categoryData.items, query);

    log("step4-bestMatch", { selected: matchedResult?.title, subtitle: matchedResult?.subtitle, hint: matchedResult?.hint, item_key: matchedResult?.item_key });

    if (!matchedResult?.item_key) {
      return {
        content: [{ type: "text", text: `${targetCategory.title} for "${query}":\n${formatItems(categoryData.items)}\n\nNo playable item found.` }],
      };
    }

    // Step 5: Get action list
    const actionData = await browseAndLoad(browse, {
      hierarchy,
      item_key: matchedResult.item_key,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step5-actionList", {
      error: actionData.error,
      navigated: actionData.navigated,
      message: actionData.message,
      listTitle: actionData.list?.title,
      listHint: actionData.list?.hint,
      itemCount: actionData.items?.length,
      items: actionData.items?.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
    });

    if (actionData.message) {
      return {
        content: [{ type: "text", text: `${actionData.message} ("${matchedResult.title}" in zone '${zone.display_name}')` }],
      };
    }

    if (actionData.error) {
      return { content: [{ type: "text", text: `Error: ${actionData.error}` }], isError: true };
    }

    if (!actionData.items?.length) {
      return { content: [{ type: "text", text: `No actions available for "${matchedResult.title}".` }], isError: true };
    }

    // Step 5b: Navigate deeper if needed
    let actionItems = actionData.items;
    let currentListHint = actionData.list?.hint;
    const MAX_NAV_DEPTH = 3;

    for (let depth = 0; depth < MAX_NAV_DEPTH; depth++) {
      if (currentListHint === "action_list") break;

      const hasActions = actionItems.some((item) => item.hint === "action");
      if (hasActions) break;

      const navigable = actionItems.filter(
        (item) => item.item_key && (item.hint === "action_list" || item.hint === "list"),
      );
      if (!navigable.length) break;

      if (navigable.length > 1) {
        log(`step5-skip-drill`, { reason: "multiple navigable items (content list)", count: navigable.length });
        break;
      }

      const nextItem = navigable[0];

      log(`step5-deeper-${depth}`, { title: nextItem?.title, hint: nextItem?.hint, item_key: nextItem?.item_key });

      const deeper = await browseAndLoad(browse, {
        hierarchy,
        item_key: nextItem!.item_key!,
        zone_or_output_id: zone.zone_id,
        multi_session_key: sessionKey,
      });

      log(`step5-deeper-${depth}-result`, {
        error: deeper.error,
        navigated: deeper.navigated,
        message: deeper.message,
        listHint: deeper.list?.hint,
        itemCount: deeper.items?.length,
        items: deeper.items?.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
      });

      if (deeper.message) {
        return {
          content: [{ type: "text", text: `${deeper.message} ("${matchedResult.title}" in zone '${zone.display_name}')` }],
        };
      }

      if (deeper.error || !deeper.items?.length) break;
      actionItems = deeper.items;
      currentListHint = deeper.list?.hint;
    }

    // Step 6: Find and execute action
    const targetAction = findAction(actionItems, actionType);

    log("step6-action", { actionType, selected: targetAction?.title, hint: targetAction?.hint, item_key: targetAction?.item_key });

    if (!targetAction?.item_key) {
      return {
        content: [{ type: "text", text: `Available actions for "${matchedResult.title}":\n${formatItems(actionItems)}\n\nNo "${actionType}" action found.` }],
      };
    }

    // Step 7: Execute
    let playResult = await promisifyBrowse(browse, {
      hierarchy,
      item_key: targetAction.item_key,
      zone_or_output_id: zone.zone_id,
      multi_session_key: sessionKey,
    });

    log("step7-execute", {
      error: playResult.error,
      action: playResult.body.action,
      message: playResult.body.message,
      is_error: playResult.body.is_error,
      item: playResult.body.item,
      list: playResult.body.list,
    });

    if (playResult.error) {
      return { content: [{ type: "text", text: `Error: ${playResult.error}` }], isError: true };
    }

    // Step 7b: Handle sub-menus
    if (playResult.body.action === "list" && playResult.body.list) {
      const subItems = await promisifyLoad(browse, {
        hierarchy,
        multi_session_key: sessionKey,
        count: 20,
      });

      if (!subItems.error && subItems.body.items?.length) {
        log("step7-submenu", {
          listTitle: playResult.body.list.title,
          items: subItems.body.items.map((i) => ({ title: i.title, hint: i.hint, item_key: i.item_key })),
        });

        const subAction = findAction(subItems.body.items, actionType);
        if (subAction?.item_key) {
          log("step7-submenu-action", { selected: subAction.title, hint: subAction.hint });

          playResult = await promisifyBrowse(browse, {
            hierarchy,
            item_key: subAction.item_key,
            zone_or_output_id: zone.zone_id,
            multi_session_key: sessionKey,
          });

          log("step7-submenu-execute", {
            error: playResult.error,
            action: playResult.body.action,
            message: playResult.body.message,
          });

          if (playResult.error) {
            return { content: [{ type: "text", text: `Error: ${playResult.error}` }], isError: true };
          }
        }
      }
    }

    // Step 8: Disable auto_radio
    try {
      const transport = roonConnection.getTransport();
      await new Promise<void>((resolve) => {
        transport.change_settings(zone, { auto_radio: false }, () => resolve());
      });
    } catch {
      // Non-critical
    }

    const subtitle = matchedResult.subtitle ? ` by ${stripRoonLinks(matchedResult.subtitle)}` : "";
    const actionVerb = actionType === "queue" ? "Queued" : "Now playing";
    return {
      content: [{ type: "text", text: `${actionVerb}: "${matchedResult.title}"${subtitle} in zone '${zone.display_name}'.` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
      isError: true,
    };
  }
}

export function registerBrowseTools(server: McpServer): void {
  server.tool(
    "search",
    "Search the Roon music library. Returns matching artists, albums, tracks, playlists, etc.",
    {
      query: z.string().describe("Search query (artist name, album title, track name, etc.)"),
      zone: z.string().optional().describe("Zone name or ID (optional, provides playback context)"),
    },
    async ({ query, zone }): Promise<ToolResult> => {
      try {
        const browse = roonConnection.getBrowse();
        const zoneObj = zone ? roonConnection.findZoneOrThrow(zone) : null;
        const sessionKey = newSessionKey();
        const hierarchy = "search";

        const searchData = await browseAndLoad(browse, {
          hierarchy,
          input: query,
          pop_all: true,
          zone_or_output_id: zoneObj?.zone_id,
          multi_session_key: sessionKey,
        });

        if (searchData.error) {
          return { content: [{ type: "text", text: `Search error: ${searchData.error}` }], isError: true };
        }

        if (!searchData.items?.length) {
          return { content: [{ type: "text", text: `No results for "${query}".` }] };
        }

        const allResults: string[] = [`Search results for "${query}":`];

        for (const cat of searchData.items) {
          if (!cat.item_key || cat.hint === "header") continue;

          const catData = await browseAndLoad(browse, {
            hierarchy,
            item_key: cat.item_key,
            zone_or_output_id: zoneObj?.zone_id,
            multi_session_key: sessionKey,
          }, 5);

          if (catData.error || !catData.items?.length) {
            if (catData.navigated) {
              await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
            }
            continue;
          }

          const count = catData.list?.count || catData.items.length;
          allResults.push(`\n${catData.list?.title || cat.title} (${count}):`);
          for (const item of catData.items) {
            if (item.hint === "header") continue;
            const sub = item.subtitle ? ` - ${stripRoonLinks(item.subtitle)}` : "";
            allResults.push(`  - ${item.title}${sub}`);
          }

          if (catData.navigated) {
            await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
          }
        }

        if (allResults.length <= 1) {
          return { content: [{ type: "text", text: `No results for "${query}".` }] };
        }

        if (zone) {
          allResults.push(`\nUse play_artist, play_album, play_playlist, or play_track to play a result.`);
        }

        return { content: [{ type: "text", text: allResults.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "play_artist",
    "Search for an artist and start playing their music in a Roon zone",
    {
      artist: z.string().describe("Artist name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ artist, zone }) => searchAndPlay(artist, zone, "artist"),
  );

  server.tool(
    "play_album",
    "Search for an album and start playing it in a Roon zone",
    {
      album: z.string().describe("Album name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ album, zone }) => searchAndPlay(album, zone, "album"),
  );

  server.tool(
    "play_playlist",
    "Search for a playlist and start playing it in a Roon zone",
    {
      playlist: z.string().describe("Playlist name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ playlist, zone }) => searchAndPlay(playlist, zone, "playlist"),
  );

  server.tool(
    "play_track",
    "Search for a specific track/song and start playing it in a Roon zone",
    {
      track: z.string().describe("Track/song name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ track, zone }) => searchAndPlay(track, zone, "track"),
  );

  server.tool(
    "add_to_queue",
    "Search for a track, album, artist, or playlist and add it to the queue in a Roon zone",
    {
      query: z.string().describe("Search query (track name, album title, artist name, etc.)"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      category: z
        .enum(["track", "album", "artist", "playlist"])
        .optional()
        .describe("Category to search in (optional, auto-detects if not specified)"),
    },
    async ({ query, zone, category }) => searchAndPlay(query, zone, category, "queue"),
  );

  server.tool(
    "play_after_current",
    "Search for a track and play it immediately when the current track ends. Returns instantly — the play is scheduled in the background.",
    {
      track: z.string().describe("Track/song name to search for and play when the current track ends"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ track, zone: zoneName }): Promise<ToolResult> => {
      try {
        const zoneObj = roonConnection.findZoneOrThrow(zoneName);
        const np = zoneObj.now_playing;

        if (!np || zoneObj.state !== "playing" || np.length == null || np.seek_position == null) {
          // Nothing currently playing — fire immediately
          return searchAndPlay(track, zoneName, "track", "play");
        }

        const remaining = Math.max(0, np.length - np.seek_position);
        // Trigger slightly early so Roon has time to load and start seamlessly
        const delayMs = Math.max(0, (remaining - 0.8) * 1000);
        const nowPlayingTitle = np.three_line.line1;

        setTimeout(() => {
          searchAndPlay(track, zoneName, "track", "play").catch((err) =>
            console.error(`[roon-bridge] play_after_current error:`, err),
          );
        }, delayMs);

        const mins = Math.floor(remaining / 60);
        const secs = Math.floor(remaining % 60);
        return {
          content: [{
            type: "text",
            text: `Scheduled: "${track}" will play in ~${mins}:${secs.toString().padStart(2, "0")} when "${nowPlayingTitle}" finishes in zone '${zoneObj.display_name}'.`,
          }],
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
