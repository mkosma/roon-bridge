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
import { DeferredPlayer } from "../control/deferred-player.js";
import type RoonApiBrowse from "node-roon-api-browse";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// One shared scheduler for event-driven "play after the current track" (Obj 5).
const deferredPlayer = new DeferredPlayer(roonConnection);

/** Legacy play/queue intent mapped onto the search-core action vocabulary. */
function findAction(items: BrowseItem[], type: "play" | "queue"): BrowseItem | undefined {
  const resolved = resolveActionItem(items, type === "play" ? "play_now" : "queue");
  return resolved?.item;
}

/**
 * Find a library-membership action in a Roon action list.
 *
 * Roon's browse action menu for a streaming-service album/artist exposes an
 * "Add to Library" action (and, once in the library, "Remove from Library")
 * as ordinary action items - the same item_key + execute mechanism as Play
 * Now / Queue. There is no separate library API; toggling library membership
 * is just executing this browse action. Some sources/locales label it
 * "Add to Favorites" / "Favorite", so match those too.
 */
function findLibraryAction(items: BrowseItem[], kind: "add" | "remove"): BrowseItem | undefined {
  const actionable = items.filter((item) => item.item_key && item.hint !== "header");
  const t = (item: BrowseItem) => item.title.trim().toLowerCase();
  if (kind === "add") {
    return (
      actionable.find((i) => t(i) === "add to library") ||
      actionable.find((i) => t(i).includes("add to library")) ||
      actionable.find((i) => t(i).includes("add to favorites")) ||
      actionable.find((i) => t(i) === "favorite")
    );
  }
  return (
    actionable.find((i) => t(i) === "remove from library") ||
    actionable.find((i) => t(i).includes("remove from library")) ||
    actionable.find((i) => t(i).includes("remove from favorites")) ||
    actionable.find((i) => t(i) === "unfavorite")
  );
}

interface ResolvedActions {
  error?: string;
  message?: string;
  matched?: BrowseItem;
  actionItems?: BrowseItem[];
}

/**
 * Search for an item, pick the best match, and navigate to its action list -
 * the same steps 1-5b that searchAndPlay performs, factored so add_to_library
 * can reach (and re-read, for verification) an item's action menu without
 * executing a playback action.
 */
async function resolveActionItems(
  browse: RoonApiBrowse,
  query: string,
  zoneId: string | undefined,
  category: string | undefined,
  sessionKey: string,
): Promise<ResolvedActions> {
  const hierarchy = "search";

  const searchData = await browseAndLoad(browse, {
    hierarchy,
    input: query,
    pop_all: true,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (searchData.error) return { error: `Search error: ${searchData.error}` };
  if (!searchData.items?.length) return { error: `No results found for "${query}".` };

  let targetCategory: BrowseItem | undefined;
  if (category) {
    const catLower = category.toLowerCase();
    targetCategory =
      searchData.items.find(
        (i) => i.item_key && (i.title.toLowerCase() === catLower + "s" || i.title.toLowerCase() === catLower),
      ) ||
      searchData.items.find(
        (i) => i.item_key && i.title.toLowerCase().includes(catLower) && i.hint !== "header",
      );
  }
  targetCategory ??= searchData.items.find((i) => i.item_key && i.hint !== "header");
  if (!targetCategory?.item_key) return { error: `No "${category ?? "playable"}" results for "${query}".` };

  const categoryData = await browseAndLoad(browse, {
    hierarchy,
    item_key: targetCategory.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (categoryData.error) return { error: `Error browsing ${targetCategory.title}: ${categoryData.error}` };
  if (!categoryData.items?.length) return { error: `No ${targetCategory.title.toLowerCase()} found for "${query}".` };

  const matched = bestMatch(categoryData.items, query);
  if (!matched?.item_key) return { error: `No playable match for "${query}".` };

  const actionData = await browseAndLoad(browse, {
    hierarchy,
    item_key: matched.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (actionData.message) return { matched, message: actionData.message };
  if (actionData.error) return { error: `Error: ${actionData.error}` };
  if (!actionData.items?.length) return { matched, actionItems: [] };

  // Navigate deeper to the actual action list when Roon nests it one level.
  let actionItems = actionData.items;
  let currentListHint = actionData.list?.hint;
  for (let depth = 0; depth < 3; depth++) {
    if (currentListHint === "action_list") break;
    if (actionItems.some((i) => i.hint === "action")) break;
    const navigable = actionItems.filter(
      (i) => i.item_key && (i.hint === "action_list" || i.hint === "list"),
    );
    if (navigable.length !== 1) break;
    const deeper = await browseAndLoad(browse, {
      hierarchy,
      item_key: navigable[0].item_key!,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    if (deeper.message) return { matched, message: deeper.message };
    if (deeper.error || !deeper.items?.length) break;
    actionItems = deeper.items;
    currentListHint = deeper.list?.hint;
  }

  return { matched, actionItems };
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

/**
 * Play a match, honoring `when`. `now` replaces immediately (current behavior).
 * `after_current` arms an event-driven deferral so the queue-replace fires at
 * the end of the current track - clean queue AND no mid-track stomp - instead
 * of the agent trying (and failing) to time it. If nothing is playing there is
 * no seam to wait for, so it plays now.
 */
async function playWithWhen(
  query: string,
  zoneName: string,
  category: "album" | "track",
  when: "now" | "after_current",
): Promise<ToolResult> {
  if (when === "after_current") {
    let zone;
    try {
      zone = roonConnection.findZoneOrThrow(zoneName);
    } catch (error) {
      return {
        content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
        isError: true,
      };
    }

    const np = zone.now_playing;
    if (zone.state === "playing" && np && np.length != null) {
      // Fire and forget: the replace runs server-side at the track seam.
      deferredPlayer
        .scheduleAfterCurrent(zone, () => searchAndPlay(query, zoneName, category, "play"))
        .catch((e: unknown) => console.error("[playWithWhen] schedule error:", e));
      return {
        content: [{
          type: "text",
          text: `Scheduled: "${query}" will replace the queue in '${zone.display_name}' when "${np.three_line.line1}" ends (no mid-track cut).`,
        }],
      };
    }
    // Nothing playing - no seam to wait for; play now.
  }

  // An immediate play supersedes any armed deferral.
  deferredPlayer.cancel();
  return searchAndPlay(query, zoneName, category, "play");
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
    "Search for an album and play it in a Roon zone. when='now' (default) replaces the queue immediately; when='after_current' defers the replace until the current track ends - server-side and event-driven, so the queue stays clean and the playing track is never cut mid-way.",
    {
      album: z.string().describe("Album name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      when: z
        .enum(["now", "after_current"])
        .default("now")
        .describe("'now' replaces immediately; 'after_current' waits for the current track to end, then replaces"),
    },
    async ({ album, zone, when }) => playWithWhen(album, zone, "album", when ?? "now"),
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
    "Search for a specific track/song and play it in a Roon zone. when='now' (default) replaces the queue immediately; when='after_current' defers the replace until the current track ends - server-side and event-driven, so the queue stays clean and the playing track is never cut mid-way.",
    {
      track: z.string().describe("Track/song name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      when: z
        .enum(["now", "after_current"])
        .default("now")
        .describe("'now' replaces immediately; 'after_current' waits for the current track to end, then replaces"),
    },
    async ({ track, zone, when }) => playWithWhen(track, zone, "track", when ?? "now"),
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
    "Search for a track and replace the queue with it when the current track ends. Event-driven (waits for the real track-change, robust to pause/seek/skip), not a wall-clock timer. Equivalent to play_track with when='after_current'.",
    {
      track: z.string().describe("Track/song name to search for and play when the current track ends"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
    },
    async ({ track, zone: zoneName }) => playWithWhen(track, zoneName, "track", "after_current"),
  );

  server.tool(
    "add_to_library",
    "Search for an album or artist and add it to the Roon library. Roon exposes 'Add to Library' as a browse action (the same mechanism as Play Now / Queue); this tool finds the best match, executes that action, and verifies by re-reading the item's action menu to confirm it flipped to 'Remove from Library'. Reports what it matched and whether the add was verified. If Roon does not expose an add-to-library action for the match, it reports unsupported_operation honestly rather than faking success.",
    {
      query: z.string().describe("Album or artist to find and add to the Roon library"),
      zone: z.string().optional().default("").describe("Zone for browse context (uses default zone if omitted)"),
      category: z
        .enum(["album", "artist"])
        .default("album")
        .describe("Whether the query names an album or an artist"),
    },
    async ({ query, zone, category }): Promise<ToolResult> => {
      try {
        const browse = roonConnection.getBrowse();
        const zoneObj = roonConnection.findZoneOrThrow(zone);
        const zoneId = zoneObj.zone_id;
        const cat = category ?? "album";

        const resolved = await resolveActionItems(browse, query, zoneId, cat, newSessionKey());
        if (resolved.error) {
          return { content: [{ type: "text", text: resolved.error }], isError: true };
        }
        if (resolved.message) {
          // Roon returned a terminal message instead of an action list.
          return {
            content: [{ type: "text", text: `${resolved.message} (for "${resolved.matched?.title ?? query}")` }],
            isError: true,
          };
        }

        const matched = resolved.matched!;
        const actionItems = resolved.actionItems ?? [];
        const matchedInfo = {
          title: matched.title,
          subtitle: matched.subtitle ? stripRoonLinks(matched.subtitle) : null,
        };

        const addAction = findLibraryAction(actionItems, "add");
        const removeAction = findLibraryAction(actionItems, "remove");

        // Already in the library: the menu offers Remove, not Add. Idempotent success.
        if (!addAction && removeAction) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, already_in_library: true, matched: matchedInfo, verified: true }),
            }],
          };
        }

        // No add-to-library action surfaced: report honestly, list what was available.
        if (!addAction) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "unsupported_operation",
                reason: "Roon did not expose an 'Add to Library' action for this match.",
                matched: matchedInfo,
                available_actions: actionItems.filter((i) => i.hint !== "header").map((i) => i.title),
              }),
            }],
            isError: true,
          };
        }

        // Execute the add.
        const exec = await promisifyBrowse(browse, {
          hierarchy: "search",
          item_key: addAction.item_key!,
          zone_or_output_id: zoneId,
          multi_session_key: newSessionKey(),
        });
        if (exec.error) {
          return {
            content: [{ type: "text", text: `Error adding "${matched.title}" to library: ${exec.error}` }],
            isError: true,
          };
        }

        // Verify with a fresh navigation: the menu should now offer Remove, not Add.
        const reResolved = await resolveActionItems(browse, query, zoneId, cat, newSessionKey());
        let verified = false;
        if (!reResolved.error && reResolved.actionItems) {
          verified =
            !!findLibraryAction(reResolved.actionItems, "remove") &&
            !findLibraryAction(reResolved.actionItems, "add");
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: "Add to Library",
              matched: matchedInfo,
              verified,
              ...(verified
                ? {}
                : { note: "Add action executed, but membership could not be confirmed by re-read; verify in Roon." }),
            }),
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
