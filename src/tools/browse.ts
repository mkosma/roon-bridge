import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roonConnection } from "../roon-connection.js";
import {
  newSessionKey,
  promisifyBrowse,
  promisifyLoad,
  stripRoonLinks,
  formatItems,
  browseAndLoad,
  scoreCandidates,
  bestMatch,
  resolveActionItem,
  type BrowseItem,
} from "./search-core.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Legacy play/queue intent mapped onto the search-core action vocabulary. */
function findAction(items: BrowseItem[], type: "play" | "queue"): BrowseItem | undefined {
  const resolved = resolveActionItem(items, type === "play" ? "play_now" : "queue");
  return resolved?.item;
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

    // Step 4: Select best match (scored, with a confidence signal so a loose
    // match is visible in the result rather than silently substituted).
    const ranked = scoreCandidates(categoryData.items, query, category !== "playlist");
    const matchedResult = ranked[0]?.item ?? bestMatch(categoryData.items, query);
    const matchConfidence = ranked[0]?.confidence ?? 0;
    const runnerUp = ranked[1];

    log("step4-bestMatch", { selected: matchedResult?.title, subtitle: matchedResult?.subtitle, confidence: matchConfidence, hint: matchedResult?.hint, item_key: matchedResult?.item_key });

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

    // Step 7: Execute. For a queue add, capture the pre-action queue so we can
    // verify the add actually landed afterward.
    let preAddIds: Set<number> | null = null;
    let preAddCount = 0;
    if (actionType === "queue") {
      try {
        const pre = await roonConnection.getQueueSnapshot(zone);
        preAddIds = new Set(pre.map((i) => i.queue_item_id));
        preAddCount = pre.length;
      } catch {
        preAddIds = null;
      }
    }

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

    // Step 7c: Verify a QUEUE add actually landed. The browse action can
    // return success while the item never enters the queue (the "Tonight -
    // RÜFÜS DU SOL" defect). Re-read the queue and confirm growth before
    // claiming success.
    if (actionType === "queue" && preAddIds) {
      try {
        const beforeIds = preAddIds;
        let after = await roonConnection.getQueueSnapshot(zone);
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          if (after.length > preAddCount || after.some((i) => !beforeIds.has(i.queue_item_id))) break;
          await new Promise((r) => setTimeout(r, 150));
          after = await roonConnection.getQueueSnapshot(zone);
        }

        const landed = after.length > preAddCount || after.some((i) => !beforeIds.has(i.queue_item_id));
        if (!landed) {
          return {
            content: [{
              type: "text",
              text: `Add NOT verified: the action reported success but "${matchedResult.title}" did not appear in the queue for '${zone.display_name}'. Try add_to_queue with category, or queue_next.`,
            }],
            isError: true,
          };
        }
      } catch (verifyErr) {
        log("step7c-verify-error", String(verifyErr));
        // Fall through; we could not verify but won't falsely claim failure.
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
    const confPct = Math.round(matchConfidence * 100);
    const confNote =
      matchConfidence < 0.5 && runnerUp
        ? ` [loose match, ${confPct}% confidence; runner-up: "${runnerUp.title}"${runnerUp.artist ? ` - ${runnerUp.artist}` : ""}]`
        : ` [match confidence ${confPct}%]`;
    return {
      content: [{ type: "text", text: `${actionVerb}: "${matchedResult.title}"${subtitle} in zone '${zone.display_name}'.${confNote}` }],
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
    "Search the Roon music library. Returns matching artists, albums, tracks, playlists, etc. Use `category` to narrow and paginate within one category.",
    {
      query: z.string().describe("Search query (artist name, album title, track name, etc.)"),
      zone: z.string().optional().describe("Zone name or ID (optional, provides playback context)"),
      category: z
        .enum(["artist", "album", "track", "playlist", "composer", "genre"])
        .optional()
        .describe("Narrow to a single category. When set, `offset` paginates within it."),
      limit: z
        .coerce.number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Max items per category (default 100, max 1000). Loops internally for values > 100."),
      offset: z
        .coerce.number()
        .int()
        .min(0)
        .default(0)
        .describe("Pagination offset — only meaningful with `category`."),
    },
    async ({ query, zone, category, limit, offset }): Promise<ToolResult> => {
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

        const playableCats = searchData.items.filter((c) => c.item_key && c.hint !== "header");
        let categoriesToLoad: BrowseItem[];

        if (category) {
          const catLower = category.toLowerCase();
          const exact = playableCats.find(
            (c) => c.title.toLowerCase() === catLower || c.title.toLowerCase() === catLower + "s",
          );
          const fuzzy = exact ?? playableCats.find((c) => c.title.toLowerCase().includes(catLower));
          if (!fuzzy) {
            return { content: [{ type: "text", text: `No "${category}" results for "${query}".` }] };
          }
          categoriesToLoad = [fuzzy];
        } else {
          categoriesToLoad = playableCats;
        }

        const allResults: string[] = [`Search results for "${query}":`];

        for (const cat of categoriesToLoad) {
          const catOffset = category ? offset : 0;
          const catData = await browseAndLoad(
            browse,
            {
              hierarchy,
              item_key: cat.item_key!,
              zone_or_output_id: zoneObj?.zone_id,
              multi_session_key: sessionKey,
            },
            limit,
            catOffset,
          );

          if (catData.error || !catData.items?.length) {
            if (catData.navigated) {
              await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
            }
            continue;
          }

          const visibleItems = catData.items.filter((item) => item.hint !== "header");
          const total = catData.total ?? visibleItems.length;
          const title = catData.list?.title || cat.title;
          const start = catOffset + 1;
          const end = catOffset + visibleItems.length;
          const header =
            total > visibleItems.length
              ? `\n${title} (showing ${start}-${end} of ${total}):`
              : `\n${title} (${total}):`;
          allResults.push(header);
          for (const item of visibleItems) {
            const sub = item.subtitle ? ` - ${stripRoonLinks(item.subtitle)}` : "";
            allResults.push(`  - ${item.title}${sub}`);
          }
          if (catData.nextOffset != null) {
            const catName = title.toLowerCase().replace(/s$/, "");
            allResults.push(
              `  [${total - end} more — call search with category="${catName}", offset=${catData.nextOffset}]`,
            );
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
