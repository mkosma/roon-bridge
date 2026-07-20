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
  bestMatch,
  resolveActionItem,
  waitForStableQueue,
  type BrowseItem,
} from "./search-core.js";
import {
  selectUnique,
  type ResolveCategory,
  type UniqueCandidate,
  type RankedCandidate,
} from "./resolve-unique.js";
import { deferredPlayer } from "../control/deferred-player-instance.js";
import type { SeamAction, SeamOutcome } from "../control/deferred-player.js";
import { resultingState, immediateBool, boolish } from "./resulting-state.js";
import { queueOrPlayTracks } from "./play-by-id.js";
import { playOrQueueAlbumById } from "./album-by-id.js";
import { initProviders } from "../providers/bootstrap.js";
import type RoonApiBrowse from "node-roon-api-browse";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Classify a searchAndPlay ToolResult into a SeamOutcome for the deferral
 * ledger. searchAndPlay appends a JSON blob ({ ok, verified, error,
 * resulting_state }) to its text and sets isError on hard failures; we read
 * both. A low-confidence refusal is a clean stand-down (aborted), not a failure.
 */
function seamOutcomeFrom(res: ToolResult): SeamOutcome {
  const text = res.content.map((c) => c.text).join("\n");
  let parsed: Record<string, unknown> = {};
  const m = text.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try {
      parsed = JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      /* leave parsed empty; fall back to isError below */
    }
  }
  const error = typeof parsed.error === "string" ? parsed.error : undefined;
  const resulting_state = parsed.resulting_state;
  // A refused resolution (ambiguous / not_found) is an intended stand-down, not
  // a fault - the deferral aborts cleanly rather than logging a failure.
  if (error === "ambiguous" || error === "not_found") {
    return { ok: false, verified: false, aborted: true, reason: error, detail: text.split("\n")[0], resulting_state };
  }
  if (res.isError || parsed.ok === false) {
    return { ok: false, verified: false, reason: error ?? "play_failed", detail: text.split("\n")[0], resulting_state };
  }
  const verified = parsed.verified === true;
  return { ok: true, verified, reason: verified ? undefined : "not_verified", detail: verified ? undefined : text.split("\n")[0], resulting_state };
}

/** What kind of action a play-path caller wants to execute. */
type ActionType = "play" | "queue" | "shuffle";

/** Map the play-path action vocabulary onto search-core's intents. */
function intentFor(type: ActionType): "play_now" | "queue" | "shuffle" {
  if (type === "queue") return "queue";
  if (type === "shuffle") return "shuffle";
  return "play_now";
}

/** Legacy play/queue/shuffle intent mapped onto the search-core action vocabulary. */
function findAction(items: BrowseItem[], type: ActionType): BrowseItem | undefined {
  const resolved = resolveActionItem(items, intentFor(type));
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

/**
 * Find the native Shuffle action on an item's OPENED page.
 *
 * Roon's first action level for a playlist/album (the search-result popup) often
 * exposes only Play Now / Queue / Add Next / Start Radio - NO Shuffle. The
 * native Shuffle action lives one level deeper: either inside a navigable "Play"
 * submenu (Play Now / Shuffle / Play From Here ...), or on the item's opened
 * content page reached by browsing the matched item's own node. This only runs
 * when shuffle is requested AND wasn't found at level one, so it never adds a
 * round-trip to the default play/queue path.
 *
 * Returns the Shuffle BrowseItem to execute (already resolved to its own
 * item_key), or undefined if Shuffle is genuinely absent even one level in.
 */
async function findShuffleDeeper(
  browse: RoonApiBrowse,
  level1Items: BrowseItem[],
  matchedKey: string,
  zoneId: string | undefined,
  sessionKey: string,
  log: (step: string, data: unknown) => void,
): Promise<BrowseItem | undefined> {
  const hierarchy = "search";

  // Candidate sub-lists to open: every navigable submenu row at level one
  // (e.g. a "Play" submenu that nests Shuffle), plus the matched item's own
  // node again (its opened content page, where some sources put the Shuffle
  // header action). De-duped by item_key; the matched key goes last so a real
  // "Play" submenu is preferred over re-opening the content page.
  //
  // A leaf "action" row (Play Now / Queue / Start Radio) is NOT a navigable
  // container - Roon's browse API executes an action node when you open it,
  // it doesn't peek inside it. Opening one here would fire that action as a
  // side effect of hunting for Shuffle, so only action_list/list rows qualify.
  const candidates: BrowseItem[] = [];
  const seen = new Set<string>();
  for (const it of level1Items) {
    if (!it.item_key || it.hint === "header") continue;
    if (it.hint !== "action_list" && it.hint !== "list") continue;
    if (seen.has(it.item_key)) continue;
    seen.add(it.item_key);
    candidates.push(it);
  }
  if (matchedKey && !seen.has(matchedKey)) {
    candidates.push({ title: "(opened item page)", item_key: matchedKey, hint: "list" });
  }

  for (const child of candidates) {
    const opened = await browseAndLoad(browse, {
      hierarchy,
      item_key: child.item_key!,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    if (opened.error || opened.message || !opened.items?.length) continue;

    const direct = resolveActionItem(opened.items, "shuffle");
    if (direct?.item) {
      log("shuffle-found-deeper", { via: child.title, depth: 2, title: direct.item.title });
      return direct.item;
    }

    // One more hop: a single nested action sub-list (Roon occasionally double-
    // nests Play -> Shuffle). Bounded to a single navigable child so we never
    // walk a content (track) list.
    const navigable = opened.items.filter(
      (i) => i.item_key && (i.hint === "action_list" || i.hint === "list"),
    );
    if (navigable.length === 1) {
      const deeper = await browseAndLoad(browse, {
        hierarchy,
        item_key: navigable[0].item_key!,
        zone_or_output_id: zoneId,
        multi_session_key: sessionKey,
      });
      if (!deeper.error && !deeper.message && deeper.items?.length) {
        const pick = resolveActionItem(deeper.items, "shuffle");
        if (pick?.item) {
          log("shuffle-found-deeper", { via: `${child.title} > ${navigable[0].title}`, depth: 3, title: pick.item.title });
          return pick.item;
        }
      }
    }
  }

  return undefined;
}

interface ResolvedActions {
  error?: string;
  message?: string;
  matched?: BrowseItem;
  actionItems?: BrowseItem[];
}

/** A Roon track row like "1. Walk On" - never carries the album-level library
 * toggle, and descending into one explodes the search space. */
function isTrackRow(item: BrowseItem): boolean {
  return /^\s*\d+\.\s/.test(item.title);
}

/**
 * Depth-first search of an item's reachable action menus for the Add/Remove
 * -from-Library toggle.
 *
 * "Add to Library" is NOT on the album quick popup (Play Now / Add Next / Queue
 * / Start Radio). Depending on the source it sits on the album detail page or
 * behind a different nested action_list, so we explore every action_list/list
 * child (skipping track rows) up to `depth` extra levels, bounded by a shared
 * browse `budget`.
 *
 * Roon item_keys are scoped to their browse session AND stack position, so this
 * navigates a single session: descending pushes a level, and a branch that does
 * not contain the toggle is popped (pop_levels:1) before the next sibling is
 * tried. On success the stack is LEFT positioned at the menu that carries the
 * toggle, so the caller can execute it in the same session without re-navigating.
 */
async function dfsFindLibraryNode(
  browse: RoonApiBrowse,
  zoneId: string | undefined,
  sessionKey: string,
  items: BrowseItem[],
  depth: number,
  budget: { calls: number },
): Promise<{ found: boolean; items: BrowseItem[] }> {
  const hierarchy = "search";
  if (findLibraryAction(items, "add") || findLibraryAction(items, "remove")) {
    return { found: true, items };
  }
  if (depth <= 0) return { found: false, items };

  let lastItems = items;
  const children = items.filter(
    (i) => i.item_key && (i.hint === "action_list" || i.hint === "list") && !isTrackRow(i),
  );
  for (const child of children) {
    if (budget.calls <= 0) break;
    budget.calls -= 1;
    const deeper = await browseAndLoad(browse, {
      hierarchy,
      item_key: child.item_key!,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    if (deeper.error || deeper.message || !deeper.items?.length) {
      // Dead end (error, terminal message, or empty). Pop back, try next sibling.
      await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
      continue;
    }
    const sub = await dfsFindLibraryNode(browse, zoneId, sessionKey, deeper.items, depth - 1, budget);
    if (sub.found) return { found: true, items: sub.items };
    lastItems = sub.items.length ? sub.items : deeper.items;
    await promisifyBrowse(browse, { hierarchy, pop_levels: 1, multi_session_key: sessionKey });
  }
  return { found: false, items: lastItems };
}

/**
 * Ordered search-root section titles to try when hunting the library toggle:
 * the requested category first, then a primary-match card titled like the query
 * (Roon surfaces the focused album as its own top section, distinct from the
 * "Albums" category, and that card is where the library action often lives),
 * then anything else playable. Titles, not item_keys, because keys go stale
 * across the fresh searches resolveLibraryActions runs per entry.
 */
function libraryEntryTitles(rootItems: BrowseItem[], query: string, category: string | undefined): string[] {
  const playable = rootItems.filter((i) => i.item_key && i.hint !== "header");
  const titles: string[] = [];
  const push = (t?: string) => { if (t && !titles.includes(t)) titles.push(t); };

  if (category) {
    const cl = category.toLowerCase();
    const cat =
      playable.find((i) => i.title.toLowerCase() === cl + "s" || i.title.toLowerCase() === cl) ||
      playable.find((i) => i.title.toLowerCase().includes(cl));
    push(cat?.title);
  }

  const categoryWords = new Set([
    "albums", "album", "artists", "artist", "tracks", "track", "songs",
    "composers", "composer", "genres", "genre", "playlists", "playlist",
  ]);
  const qWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  for (const it of playable) {
    if (categoryWords.has(it.title.toLowerCase())) continue;
    if (qWords.some((w) => it.title.toLowerCase().includes(w))) push(it.title);
  }
  for (const it of playable) push(it.title);
  return titles;
}

/**
 * Search for an item, pick the best match, and navigate to its action list -
 * the same steps 1-5b that searchAndPlay performs, factored so the artist-queue
 * path can reach an item's action menu without executing a playback action.
 *
 * This is the general play/queue resolver. The library path uses the deeper
 * resolveLibraryActions below, because the Add/Remove-from-Library toggle does
 * not live on the quick action popup this returns.
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

  // Deterministic selection (the poka-yoke, Roon substrate): the ONE exact
  // match on the normalized key, or an honest error - never a fuzzy best-match
  // guess. This is the artist-resolution path; artist has no stable provider id
  // to funnel through the *_by_id gateway.
  const resolveCat: ResolveCategory =
    category === "artist" ? "artist" : category === "playlist" ? "playlist" : category === "album" ? "album" : "track";
  const playable = categoryData.items.filter((i) => i.item_key && i.hint !== "header");
  const cands: UniqueCandidate[] = playable.map((i) => ({
    id: i.item_key!,
    title: i.title,
    artist: stripRoonLinks(i.subtitle || "").split(/[,/]/)[0].trim() || undefined,
  }));
  const selection = selectUnique(cands, query, resolveCat);
  if (selection.kind === "not_found") return { error: `No exact ${resolveCat} match for "${query}".` };
  if (selection.kind === "ambiguous") {
    const names = selection.candidates.map((c) => `"${c.title}"${c.artist ? ` - ${c.artist}` : ""}`).join(", ");
    return { error: `"${query}" matches ${selection.candidates.length} ${resolveCat}s exactly (${names}) - refusing to guess; name one exactly.` };
  }
  const matched = playable.find((i) => i.item_key === selection.candidate.id);
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

/**
 * Resolve the action menu that carries the Add/Remove-from-Library toggle for an
 * album or artist match, leaving the browse session positioned at that menu so
 * the caller can execute the toggle in the SAME session.
 *
 * Unlike the play/queue resolve (satisfied by the album quick popup), this tries
 * each search-root entry that could be the album - the requested category AND
 * the primary-match card - and depth-first searches each one's reachable action
 * menus for the library toggle. The quick popup carries Play Now / Add Next /
 * Queue / Start Radio but not the library action; the toggle lives on the album
 * detail page (reached via the primary-match card, or by drilling the detail
 * page's full menu), so a single linear drill down the category path misses it.
 * If no entry exposes a library action we return the last menu seen, so the
 * caller can report unsupported_operation with the actions that WERE available.
 */
async function resolveLibraryActions(
  browse: RoonApiBrowse,
  query: string,
  zoneId: string | undefined,
  category: string | undefined,
  sessionKey: string,
): Promise<ResolvedActions> {
  const hierarchy = "search";
  const budget = { calls: 18 };

  const searchRoot = () =>
    browseAndLoad(browse, {
      hierarchy,
      input: query,
      pop_all: true,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });

  const first = await searchRoot();
  if (first.error) return { error: `Search error: ${first.error}` };
  if (!first.items?.length) return { error: `No results found for "${query}".` };

  const titles = libraryEntryTitles(first.items, query, category);
  if (!titles.length) return { error: `No "${category ?? "playable"}" results for "${query}".` };

  let lastMatched: BrowseItem | undefined;
  let lastItems: BrowseItem[] = [];

  for (let t = 0; t < titles.length; t++) {
    if (budget.calls <= 0) break;
    // Fresh search per entry so we navigate from a clean root with valid keys.
    const root = t === 0 ? first : await searchRoot();
    const section = root.items?.find((i) => i.item_key && i.title === titles[t]);
    if (!section?.item_key) continue;

    budget.calls -= 1;
    const secData = await browseAndLoad(browse, {
      hierarchy,
      item_key: section.item_key,
      zone_or_output_id: zoneId,
      multi_session_key: sessionKey,
    });
    if (secData.error || !secData.items?.length) continue;

    // The section is either the album's own page/menu (a primary-match card -
    // it carries action items and/or track rows) or a LIST of albums (the
    // category). Only the latter needs one more descent to reach the album.
    const isAlbumPage = secData.items.some((i) => i.hint === "action" || isTrackRow(i));
    let matched = section;
    let albumItems = secData.items;
    if (!isAlbumPage) {
      const best = bestMatch(secData.items, query);
      if (!best?.item_key) continue;
      matched = best;
      budget.calls -= 1;
      const albumData = await browseAndLoad(browse, {
        hierarchy,
        item_key: best.item_key,
        zone_or_output_id: zoneId,
        multi_session_key: sessionKey,
      });
      if (albumData.message) { lastMatched ??= best; continue; }
      if (albumData.error || !albumData.items?.length) continue;
      albumItems = albumData.items;
    }

    lastMatched = matched;
    const dfs = await dfsFindLibraryNode(browse, zoneId, sessionKey, albumItems, 3, budget);
    lastItems = dfs.items.length ? dfs.items : albumItems;
    if (dfs.found) return { matched, actionItems: dfs.items };
  }

  return { matched: lastMatched, actionItems: lastItems };
}

/**
 * Drill an item's browse node to its action list and execute the "add to end
 * of queue" action - the same steps 5b/6/7/7b that searchAndPlay runs, factored
 * so the artist-queue path can enqueue each of an artist's albums through the
 * exact mechanism that already works for a direct album add. Returns true only
 * when a queue action was found and executed without error.
 */
async function executeQueueAction(
  browse: RoonApiBrowse,
  itemKey: string,
  zoneId: string | undefined,
  sessionKey: string,
  log: (step: string, data: unknown) => void,
): Promise<boolean> {
  const hierarchy = "search";

  const actionData = await browseAndLoad(browse, {
    hierarchy,
    item_key: itemKey,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (actionData.error || actionData.message || !actionData.items?.length) {
    log("queueAction-no-actions", { error: actionData.error, message: actionData.message });
    return false;
  }

  // Navigate deeper if Roon nests the action list one level (step 5b parity).
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
    if (deeper.error || deeper.message || !deeper.items?.length) break;
    actionItems = deeper.items;
    currentListHint = deeper.list?.hint;
  }

  const target = findAction(actionItems, "queue");
  if (!target?.item_key) {
    log("queueAction-no-queue-action", { available: actionItems.map((i) => i.title) });
    return false;
  }

  let exec = await promisifyBrowse(browse, {
    hierarchy,
    item_key: target.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (exec.error) {
    log("queueAction-exec-error", { error: exec.error });
    return false;
  }

  // Handle a sub-menu (step 7b parity).
  if (exec.body.action === "list" && exec.body.list) {
    const sub = await promisifyLoad(browse, { hierarchy, multi_session_key: sessionKey, count: 20 });
    if (!sub.error && sub.body.items?.length) {
      const subAction = findAction(sub.body.items, "queue");
      if (subAction?.item_key) {
        exec = await promisifyBrowse(browse, {
          hierarchy,
          item_key: subAction.item_key,
          zone_or_output_id: zoneId,
          multi_session_key: sessionKey,
        });
        if (exec.error) {
          log("queueAction-submenu-exec-error", { error: exec.error });
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * How many of an artist's albums to enqueue for a "more of this artist" add.
 * Enough for a varied, cross-album stretch; capped so one add does not flood
 * the queue (the music-monitor daemon extends repeatedly). Tunable.
 */
const ARTIST_QUEUE_ALBUM_CAP = 2;

/** Play-all control rows Roon prepends to an artist page; skipped when harvesting albums. */
const ARTIST_PAGE_ACTION_TITLE =
  /^(play|play now|play artist|play album|shuffle|add next|queue|add to queue|start radio|start artist radio)$/i;

/** Artist-page section headers that hold the artist's own releases. */
const ALBUM_SECTION = /\b(album|albums|single|singles|ep|eps|release|releases|discography|compilation|compilations)\b/i;
/** Sections that are NOT the artist's own work (other artists' material). */
const EXCLUDE_SECTION = /\b(similar|related|associated|appears on|influenced|inspired)\b/i;

/**
 * Harvest the artist's own albums from their browse detail page. The page is a
 * flat item list with `header` rows delimiting sections (Top Tracks, Main
 * Albums, Appears On, Similar Artists, ...). We prefer rows under an album-ish
 * section, excluding cross-artist sections. If no album section is present
 * (flat discography or unlabeled page), fall back to navigable rows that look
 * like the artist's own content (subtitle credits the artist or is empty),
 * skipping rows that are just the artist's own name.
 */
function pickArtistAlbums(pageItems: BrowseItem[], artistTitle: string): BrowseItem[] {
  const artistLc = artistTitle.trim().toLowerCase();
  let section = "";
  const rows: Array<{ item: BrowseItem; section: string }> = [];
  for (const it of pageItems) {
    if (it.hint === "header") {
      section = it.title.trim().toLowerCase();
      continue;
    }
    if (!it.item_key) continue;
    if (ARTIST_PAGE_ACTION_TITLE.test(it.title.trim())) continue;
    rows.push({ item: it, section });
  }

  const albumRows = rows.filter(
    (r) => ALBUM_SECTION.test(r.section) && !EXCLUDE_SECTION.test(r.section),
  );
  if (albumRows.length) return albumRows.map((r) => r.item);

  const own = rows
    .filter((r) => !EXCLUDE_SECTION.test(r.section))
    .filter((r) => {
      if (r.item.title.trim().toLowerCase() === artistLc) return false;
      const sub = stripRoonLinks(r.item.subtitle || "").toLowerCase();
      return sub === "" || sub.includes(artistLc);
    });
  return own.map((r) => r.item);
}

/** Does a queued item credit the given artist in either of its label lines? */
function queueItemMatchesArtist(item: { two_line?: { line2?: string }; three_line?: { line2?: string; line3?: string } }, artistLc: string): boolean {
  const lines = [item.two_line?.line2, item.three_line?.line2, item.three_line?.line3];
  return lines.some((l) => !!l && l.toLowerCase().includes(artistLc));
}

/**
 * Queue "more of this artist": resolve the artist, then enqueue up to
 * ARTIST_QUEUE_ALBUM_CAP of their albums through the proven album action-list
 * path. A direct artist-node "Queue" action is unreliable (it reports success
 * but enqueues nothing - the defect this fixes), so we queue real albums and
 * verify by queue growth plus an artist-field match, never by the query string
 * appearing in track titles (which it never can for an artist add).
 */
async function queueArtist(query: string, zoneName: string): Promise<ToolResult> {
  try {
    const browse = roonConnection.getBrowse();
    const zone = roonConnection.findZoneOrThrow(zoneName);
    const sessionKey = newSessionKey();
    const log = (step: string, data: unknown) =>
      console.error(`[roon-bridge] queueArtist[${sessionKey}] ${step}:`, JSON.stringify(data, null, 2));

    log("start", { query, zone: zone.display_name });

    const resolved = await resolveActionItems(browse, query, zone.zone_id, "artist", sessionKey);
    if (resolved.error) {
      return { content: [{ type: "text", text: resolved.error }], isError: true };
    }
    if (resolved.message) {
      return {
        content: [{ type: "text", text: `${resolved.message} (for "${resolved.matched?.title ?? query}")` }],
        isError: true,
      };
    }

    const artist = resolved.matched!;
    const albums = pickArtistAlbums(resolved.actionItems ?? [], artist.title);
    log("albums", { artist: artist.title, found: albums.length, titles: albums.slice(0, 6).map((a) => a.title) });

    if (!albums.length) {
      return {
        content: [{
          type: "text",
          text: `Matched artist "${artist.title}" but found none of their albums to queue in '${zone.display_name}'.`,
        }],
        isError: true,
      };
    }

    // Snapshot the queue so we can verify real growth, not a reported success.
    let preCount = 0;
    let preIds = new Set<number>();
    try {
      const pre = await roonConnection.getQueueSnapshot(zone);
      preCount = pre.length;
      preIds = new Set(pre.map((i) => i.queue_item_id));
    } catch {
      // Can't snapshot - proceed, but we'll only be able to soft-verify.
    }

    const queuedTitles: string[] = [];
    for (const album of albums.slice(0, ARTIST_QUEUE_ALBUM_CAP)) {
      const ok = await executeQueueAction(browse, album.item_key!, zone.zone_id, sessionKey, log);
      if (ok) queuedTitles.push(album.title);
    }

    if (!queuedTitles.length) {
      return {
        content: [{
          type: "text",
          text: `Could not queue any albums for artist "${artist.title}" in '${zone.display_name}'.`,
        }],
        isError: true,
      };
    }

    // Verify the add actually landed: re-read the queue and confirm growth.
    const artistLc = artist.title.trim().toLowerCase();
    let added = 0;
    let byArtist = 0;
    try {
      let after = await roonConnection.getQueueSnapshot(zone);
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const newItems = after.filter((i) => !preIds.has(i.queue_item_id));
        if (after.length > preCount || newItems.length > 0) break;
        await new Promise((r) => setTimeout(r, 150));
        after = await roonConnection.getQueueSnapshot(zone);
      }
      const newItems = after.filter((i) => !preIds.has(i.queue_item_id));
      added = Math.max(newItems.length, after.length - preCount);
      byArtist = newItems.filter((i) => queueItemMatchesArtist(i, artistLc)).length;

      if (added <= 0 && newItems.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Add NOT verified: queued ${queuedTitles.length} album(s) for "${artist.title}" but the queue in '${zone.display_name}' did not grow.`,
          }],
          isError: true,
        };
      }
    } catch (verifyErr) {
      log("verify-error", String(verifyErr));
      // Could not re-read; don't falsely claim failure, but say so.
      return {
        content: [{
          type: "text",
          text: `Queued ${queuedTitles.length} album(s) for artist "${artist.title}" in '${zone.display_name}' (queue growth unverified: ${String(verifyErr)}).`,
        }],
      };
    }

    // Best-effort auto_radio off, matching the play/queue paths.
    try {
      const transport = roonConnection.getTransport();
      await new Promise<void>((resolve) => {
        transport.change_settings(zone, { auto_radio: false }, () => resolve());
      });
    } catch {
      // Non-critical
    }

    const albumList = queuedTitles.map((t) => `"${t}"`).join(", ");
    const artistNote = byArtist > 0 ? ` (${byArtist} confirmed by ${artist.title})` : "";
    return {
      content: [{
        type: "text",
        text: `Queued more of "${artist.title}" in '${zone.display_name}': added ${added} track(s) from ${queuedTitles.length} album(s) ${albumList}${artistNote}.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
      isError: true,
    };
  }
}

async function searchAndPlay(
  query: string,
  zoneName: string,
  category?: string,
  actionType: ActionType = "play",
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

    // Step 4: Deterministic selection over the Roon substrate. Keep only rows
    // that are EXACTLY the named thing on the normalized key, then resolve to
    // the one survivor - or error with candidates. No fuzzy "best match"
    // auto-select and no confidence threshold: a name play acts on exactly the
    // named thing or refuses (the "Gas instead of Spoon" poka-yoke). This path
    // serves the categories that have no stable provider id to pin (artist), a
    // shuffle request (needs Roon's native Shuffle action), and the generic
    // auto-detect add; album/track/playlist plays funnel through the provider
    // *_by_id gateway instead (see playWithWhen / addByNameToQueue).
    const playable = categoryData.items.filter((i) => i.item_key && i.hint !== "header");
    const resolveCat: ResolveCategory =
      category === "artist" ? "artist" : category === "playlist" ? "playlist" : category === "album" ? "album" : "track";
    const uniqueCands: UniqueCandidate[] = playable.map((i) => ({
      id: i.item_key!,
      title: i.title,
      artist: stripRoonLinks(i.subtitle || "").split(/[,/]/)[0].trim() || undefined,
    }));
    const selection = selectUnique(uniqueCands, query, resolveCat);
    if (selection.kind !== "unique") {
      log("step4-not-unique", { query, kind: selection.kind, candidates: selection.candidates.length });
      return renderUniqueError(query, resolveCat, zone.display_name, selection.kind, selection.candidates);
    }
    const matchedResult = playable.find((i) => i.item_key === selection.candidate.id)!;

    log("step4-unique", { selected: matchedResult.title, subtitle: matchedResult.subtitle, item_key: matchedResult.item_key });

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

    // Step 6: Find and execute action. For a shuffle request, prefer the native
    // Shuffle action; if this item exposes none, fall back to Play Now and
    // record that so the result text reports honestly which path executed.
    let effectiveActionType = actionType;
    let shuffleUnavailable = false;
    let targetAction = findAction(actionItems, actionType);

    // A play/shuffle action must change what is playing; capture the current
    // now-playing so Step 8b can prove the flip (and not assert "Now playing"
    // off a browse-action success that never touched the audio - the false
    // "Now playing: The National" while Gidge kept playing).
    //
    // Capture from a FRESH zone read (not the `zone` snapshot taken at search
    // start, which a natural track advance during the long browse walk could
    // have staled), but do it HERE - after the search walk and BEFORE the
    // shuffle-deeper probe below. findShuffleDeeper opens candidate action nodes,
    // and browsing an action node executes it in Roon; capturing beforeNP after
    // that would read the already-started track and mislabel a real play as
    // unverified. This point is post-walk (fresh) yet pre-any-action-fire (true).
    const isPlayAction = actionType !== "queue";
    const beforeNP = isPlayAction
      ? (roonConnection.findZone(zone.zone_id)?.now_playing?.three_line?.line1 ?? zone.now_playing?.three_line?.line1 ?? null)
      : null;

    // Shuffle requested but not at level one (the search-result popup commonly
    // exposes only Play Now / Queue / Add Next). The native Shuffle action lives
    // on the item's OPENED page - inside a "Play" submenu or the item's content
    // page. Navigate INTO the matched item to find it before giving up. Only
    // runs in this not-found-at-level-one branch, so the default play/queue path
    // never pays for the extra round-trips.
    if (actionType === "shuffle" && !targetAction?.item_key) {
      const deepShuffle = await findShuffleDeeper(
        browse,
        actionItems,
        matchedResult.item_key,
        zone.zone_id,
        sessionKey,
        log,
      );
      if (deepShuffle?.item_key) {
        targetAction = deepShuffle;
      }
    }

    if (actionType === "shuffle" && !targetAction?.item_key) {
      shuffleUnavailable = true;
      effectiveActionType = "play";
      targetAction = findAction(actionItems, "play");
      log("step6-shuffle-fallback", {
        reason: "no native Shuffle action on this item (level one or opened page); falling back to Play Now",
        available: actionItems.filter((i) => i.hint !== "header").map((i) => i.title),
      });
    }

    log("step6-action", { actionType, effectiveActionType, selected: targetAction?.title, hint: targetAction?.hint, item_key: targetAction?.item_key });

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

        const subAction = findAction(subItems.body.items, effectiveActionType);
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
    const shuffleNote = shuffleUnavailable
      ? ` [shuffle unavailable for this item - no native Shuffle action; played in playlist order instead]`
      : "";
    // The match is now exact by construction (step 4 uniqueness gate), so there
    // is no confidence figure to report.
    const confNote = "";

    // Step 8b: verify a PLAY/SHUFFLE actually changed what is playing. The
    // browse action can return success while the zone never moves (the false-
    // success class: "Now playing: The National" while Gidge kept playing).
    // Poll the fresh zone until now-playing flips off the track that was playing
    // before, then report from the STATE READ, not the match.
    if (isPlayAction) {
      let landedNP: string | null = null;
      let sawNowPlaying = false;
      let verified = false;
      let playing = false;
      const deadline = Date.now() + 2500;
      for (;;) {
        const z = roonConnection.findZone(zone.zone_id);
        const np = z?.now_playing?.three_line?.line1 ?? null;
        playing = z?.state === "playing" || z?.state === "loading" || z?.state == null;
        if (np != null) {
          sawNowPlaying = true;
          landedNP = np;
        }
        // Flipped to a different track (or started from silence) while playing.
        if (np != null && np !== beforeNP && playing) {
          verified = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      const resulting_state = await resultingState(zone);

      // False success: now-playing WAS readable and it never left the track that
      // was playing before. The action was acked but nothing changed - the exact
      // failure this guard exists to catch. Refuse to claim success.
      if (!verified && sawNowPlaying && beforeNP != null && landedNP === beforeNP) {
        return {
          content: [{
            type: "text",
            text:
              `WARNING - not verified: the browse action for "${matchedResult.title}"${subtitle} in zone '${zone.display_name}' was accepted, but playback did NOT change (still "${beforeNP}"). The play did not land; confirm with now_playing.${confNote}\n` +
              JSON.stringify({ ok: false, error: "play_not_verified", resulting_state }, null, 2),
          }],
          isError: true,
        };
      }

      // From-silence no-start: nothing was playing before and the zone is still
      // not in a playing state after the action - an affirmative "did not start"
      // (a zone that IS playing but whose now-playing is momentarily unreadable
      // stays on the soft/unobservable path below). So this is an isError, not a
      // soft ok:true, verified:false.
      if (!verified && beforeNP == null && !playing) {
        return {
          content: [{
            type: "text",
            text:
              `WARNING - not verified: the browse action for "${matchedResult.title}"${subtitle} in zone '${zone.display_name}' was accepted, but nothing started playing (the zone was silent and stayed silent). The play did not land; confirm with now_playing.${confNote}\n` +
              JSON.stringify({ ok: false, error: "play_not_verified", resulting_state }, null, 2),
          }],
          isError: true,
        };
      }

      // Verified, or unverifiable because now-playing was not observable. Report
      // the play from the state read; mark verified:false when unconfirmed rather
      // than falsely claiming failure (mirrors the queue path's honesty).
      const fresh = roonConnection.findZone(zone.zone_id);
      const npTrack = fresh?.now_playing?.three_line?.line1 ?? landedNP ?? matchedResult.title;
      const npArtist = fresh?.now_playing?.three_line?.line2 ? ` by ${stripRoonLinks(fresh.now_playing.three_line.line2)}` : subtitle;
      const verb = effectiveActionType === "shuffle" ? "Shuffling" : "Now playing";
      const unconfirmed = verified ? "" : " [playback state not observable; not verified]";
      return {
        content: [{
          type: "text",
          text:
            `${verb}: "${npTrack}"${npArtist} in zone '${zone.display_name}'.${shuffleNote}${confNote}${unconfirmed}\n` +
            JSON.stringify({ ok: true, verified, resulting_state }, null, 2),
        }],
      };
    }

    // Queue add: report the match; the queue growth was already verified above.
    const resulting_state = await resultingState(zone);
    return {
      content: [{
        type: "text",
        text:
          `Queued: "${matchedResult.title}"${subtitle} in zone '${zone.display_name}'.${confNote}\n` +
          JSON.stringify({ ok: true, resulting_state }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
      isError: true,
    };
  }
}

/**
 * Render the poka-yoke error return shared by every name-based play/queue tool:
 * the resolution was NOT a single exact match, so the tool mutates nothing and
 * hands back the candidates (each with an exact provider/Roon id) on the ERROR
 * path. `ambiguous` = 2+ rows that are exactly the named thing; `not_found` = a
 * ranked fuzzy list of near-misses. Candidates ride the error path ONLY - there
 * is no success return that carries a candidate list, and a candidate is never
 * itself directly playable (the caller must re-issue a by-id call).
 */
function renderUniqueError(
  query: string,
  category: ResolveCategory,
  zoneName: string,
  error: "not_found" | "ambiguous",
  candidates: RankedCandidate[],
): ToolResult {
  const escape =
    "Act on an exact id instead: search_albums + play_album_by_id / queue_album_by_id, or search_tracks + play_tracks / queue_by_id.";
  const detail =
    error === "ambiguous"
      ? `"${query}" matches ${candidates.length} ${category}s exactly - refusing to guess. Pick one by id below. ${escape}`
      : `No exact ${category} match for "${query}". Closest near-misses below (not played). ${escape}`;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error,
            query,
            category,
            zone: zoneName,
            detail,
            candidates: candidates.map((c) => ({
              id: c.id,
              title: c.title,
              artist: c.artist ?? null,
              year: c.year ?? null,
              in_library: c.in_library ?? null,
              is_live: c.is_live ?? null,
              is_compilation: c.is_compilation ?? null,
              instrumental: c.instrumental ?? null,
              confidence: c.confidence,
            })),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/** A name resolved to a single exact, pinnable provider target. */
type ProviderTarget =
  | { kind: "album"; id: string; label: string }
  | { kind: "tracks"; ids: string[]; label: string };

type ProviderResolve =
  | { ok: true; target: ProviderTarget }
  | { ok: false; error: "not_found" | "ambiguous"; candidates: RankedCandidate[] };

/**
 * Resolve (query, category) to ONE exact provider target, or an error with
 * candidates. Uses the music provider's search (stable ids) - the same
 * substrate the `search_albums` / `search_tracks` tools expose - then applies
 * the deterministic uniqueness gate (selectUnique). No thresholds: exactly one
 * exact match acts, anything else refuses. This is the front end for the
 * `*_by_id` mutation gateway that album/track/playlist plays funnel through,
 * for BOTH the immediate and the after-current (pinned) paths. May throw if the
 * provider is unreachable/unconfigured; callers wrap it.
 */
async function resolveProviderTarget(
  query: string,
  category: "album" | "track" | "playlist",
): Promise<ProviderResolve> {
  const provider = initProviders().get(undefined);

  if (category === "album") {
    const albums = await provider.searchAlbums(query, 10);
    const cands: UniqueCandidate[] = albums.map((a) => ({
      id: a.id,
      title: a.title,
      artist: a.artist,
      year: a.year,
      in_library: undefined,
    }));
    const sel = selectUnique(cands, query, "album");
    if (sel.kind === "unique") {
      const a = albums.find((x) => x.id === sel.candidate.id)!;
      return { ok: true, target: { kind: "album", id: a.id, label: `${a.title}${a.artist ? ` - ${a.artist}` : ""}` } };
    }
    return { ok: false, error: sel.kind, candidates: sel.candidates };
  }

  if (category === "track") {
    const tracks = await provider.searchTracks(query, 10);
    const cands: UniqueCandidate[] = tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      year: t.year,
      instrumental: t.instrumental,
      in_library: t.inLibrary,
    }));
    const sel = selectUnique(cands, query, "track");
    if (sel.kind === "unique") {
      const t = tracks.find((x) => x.id === sel.candidate.id)!;
      return { ok: true, target: { kind: "tracks", ids: [t.id], label: `${t.title}${t.artist ? ` - ${t.artist}` : ""}` } };
    }
    return { ok: false, error: sel.kind, candidates: sel.candidates };
  }

  // playlist
  const playlists = await provider.listPlaylists(50);
  const cands: UniqueCandidate[] = playlists.map((p) => ({ id: p.id, title: p.name }));
  const sel = selectUnique(cands, query, "playlist");
  if (sel.kind !== "unique") return { ok: false, error: sel.kind, candidates: sel.candidates };
  const pl = playlists.find((p) => p.id === sel.candidate.id)!;
  const { tracks } = await provider.getPlaylist(pl.id, 500);
  const ids = tracks.map((t) => t.id).filter((id): id is string => !!id);
  if (!ids.length) return { ok: false, error: "not_found", candidates: [] };
  return { ok: true, target: { kind: "tracks", ids, label: `playlist "${pl.name}" (${ids.length} tracks)` } };
}

/**
 * Read-only exact-match probe against Roon's own library/search substrate -
 * the same "search" hierarchy searchAndPlay drills through - used ONLY to
 * decide whether a local-library item satisfies the name exactly, never to
 * act. Mirrors searchAndPlay's steps 1-4 (search -> category -> items ->
 * exact filter on the normalized key via selectUnique) without touching the
 * action list. This is the fallback substrate for an album/track/playlist
 * that lives only in Monty's local library (not on the provider/Qobuz),
 * which the provider-only `resolveProviderTarget` alone would report as
 * `not_found`. Never returns a fuzzy "best guess" - same ambiguity-or-error
 * contract as selectUnique.
 */
async function libraryExactSearch(
  query: string,
  category: "album" | "track" | "playlist",
  zoneId: string,
): Promise<
  | { kind: "unique"; item_key: string; title: string; artist?: string }
  | { kind: "not_found" | "ambiguous"; candidates: RankedCandidate[] }
> {
  const browse = roonConnection.getBrowse();
  const sessionKey = newSessionKey();
  const hierarchy = "search";

  const searchData = await browseAndLoad(browse, {
    hierarchy,
    input: query,
    pop_all: true,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (searchData.error || !searchData.items?.length) return { kind: "not_found", candidates: [] };

  const catLower = category.toLowerCase();
  const categories = searchData.items;
  let targetCategory = categories.find(
    (item) => item.item_key && (item.title.toLowerCase() === catLower + "s" || item.title.toLowerCase() === catLower),
  );
  if (!targetCategory) {
    targetCategory = categories.find(
      (item) => item.item_key && item.title.toLowerCase().includes(catLower) && item.hint !== "header",
    );
  }
  if (!targetCategory?.item_key) return { kind: "not_found", candidates: [] };

  const categoryData = await browseAndLoad(browse, {
    hierarchy,
    item_key: targetCategory.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (categoryData.error || !categoryData.items?.length) return { kind: "not_found", candidates: [] };

  const playable = categoryData.items.filter((i) => i.item_key && i.hint !== "header");
  const uniqueCands: UniqueCandidate[] = playable.map((i) => ({
    id: i.item_key!,
    title: i.title,
    artist: stripRoonLinks(i.subtitle || "").split(/[,/]/)[0].trim() || undefined,
  }));
  const selection = selectUnique(uniqueCands, query, category);
  if (selection.kind !== "unique") return { kind: selection.kind, candidates: selection.candidates };
  return {
    kind: "unique",
    item_key: selection.candidate.id,
    title: selection.candidate.title,
    artist: selection.candidate.artist,
  };
}

/** resolveProviderTarget, but swallows a provider outage/misconfiguration into
 *  a clean "found nothing on the provider" instead of throwing - so a
 *  provider hiccup doesn't take the local-library fallback down with it. The
 *  swallowed error is logged, never silently dropped. */
async function safeResolveProviderTarget(query: string, category: "album" | "track" | "playlist"): Promise<ProviderResolve> {
  try {
    return await resolveProviderTarget(query, category);
  } catch (e) {
    console.error(
      `[roon-bridge] resolveTargetWithLibraryFallback: provider resolve failed for "${query}" (${category}), falling back to library-only:`,
      e instanceof Error ? e.message : e,
    );
    return { ok: false, error: "not_found", candidates: [] };
  }
}

/** A target resolved by the combined provider+library search. */
type CombinedResolve =
  | { ok: true; source: "provider"; target: ProviderTarget }
  | { ok: true; source: "library" }
  | { ok: false; error: "not_found" | "ambiguous"; candidates: RankedCandidate[] };

/**
 * Resolve (query, category) against the provider catalog first, falling back
 * to Monty's local Roon library ONLY when the provider itself found ZERO
 * exact matches:
 *
 *   - provider has the one exact match -> provider target (funnels through
 *     the `*_by_id` gateway, as before). The library is never even queried -
 *     Roon's own "search" hierarchy re-surfaces anything reachable through a
 *     linked streaming service too, so probing it unconditionally would flag
 *     an ordinary provider hit as a false cross-source "collision" (verified
 *     against the existing fixture suite, which legitimately returns the
 *     same album from both the provider mock and the Roon-browse mock).
 *   - provider is itself ambiguous (2+ exact provider matches) -> ambiguous,
 *     provider candidates only. Refuses before ever touching the library.
 *   - provider has zero exact matches -> fall back to an exact-match filter
 *     over Roon's own local browse/search results (the substrate
 *     searchAndPlay already uses for artist/shuffle). Unique there -> library
 *     target (execution delegates to the Roon-browse execute path via
 *     searchAndPlay, since a local item has no provider id for `*_by_id`).
 *     Ambiguous there -> ambiguous, library candidates. Zero there too ->
 *     not_found, candidates merged from both sides' near-miss rankings.
 *
 * Read-only: neither probe mutates anything.
 */
async function resolveTargetWithLibraryFallback(
  query: string,
  zoneId: string,
  category: "album" | "track" | "playlist",
): Promise<CombinedResolve> {
  const providerRes = await safeResolveProviderTarget(query, category);
  if (providerRes.ok) return { ok: true, source: "provider", target: providerRes.target };
  if (providerRes.error === "ambiguous") return { ok: false, error: "ambiguous", candidates: providerRes.candidates };

  // Provider found ZERO exact matches - try Monty's local library before
  // declaring not_found (an album that exists only on disk, not on Qobuz).
  let libraryRes: Awaited<ReturnType<typeof libraryExactSearch>>;
  try {
    libraryRes = await libraryExactSearch(query, category, zoneId);
  } catch (e) {
    console.error(`[roon-bridge] resolveTargetWithLibraryFallback: library probe failed for "${query}" (${category}):`, e instanceof Error ? e.message : e);
    libraryRes = { kind: "not_found", candidates: [] };
  }

  if (libraryRes.kind === "unique") return { ok: true, source: "library" };
  if (libraryRes.kind === "ambiguous") return { ok: false, error: "ambiguous", candidates: libraryRes.candidates };

  const merged = [...providerRes.candidates, ...libraryRes.candidates].slice(0, 5);
  return { ok: false, error: "not_found", candidates: merged };
}

/** Whether a category funnels through the provider `*_by_id` gateway. Artist has
 *  no stable provider id (no provider artist search), and a shuffle needs Roon's
 *  native Shuffle action, so both stay on the deterministic Roon-browse path. */
function providerPinnable(category: string, shuffle: boolean): category is "album" | "track" | "playlist" {
  return !shuffle && (category === "album" || category === "track" || category === "playlist");
}

/** Dispatch a resolved provider target to the deterministic by-id gateway. */
function actOnTarget(target: ProviderTarget, zoneName: string, when: "now" | "next" | "queue"): Promise<ToolResult> {
  return target.kind === "album"
    ? playOrQueueAlbumById(target.id, undefined, zoneName, when)
    : queueOrPlayTracks(target.ids, undefined, zoneName, when);
}

/**
 * Play a name match, honoring `when`. `now` replaces immediately; `after_current`
 * arms an event-driven deferral so the queue-replace fires at the end of the
 * current track (clean queue, no mid-track stomp).
 *
 * album/track/playlist funnel through the provider `*_by_id` gateway: the name
 * is resolved to ONE exact provider id (or an error with candidates), and that
 * id is what acts - immediately, or pinned into the seam action (stable across
 * the wait). artist and shuffle stay on the deterministic Roon-browse path
 * (no provider id to pin), which likewise resolves to the one exact match or
 * errors. A deferred artist/shuffle can't be pinned, so it is refused at arm
 * time when a seam exists (play it now instead).
 */
async function playWithWhen(
  query: string,
  zoneName: string,
  category: string,
  when: "now" | "after_current",
  shuffle = false,
): Promise<ToolResult> {
  const playActionType: ActionType = shuffle ? "shuffle" : "play";

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
      // A real seam to wait for.
      if (!providerPinnable(category, shuffle)) {
        return {
          content: [{
            type: "text",
            text: `Can't defer this: a ${shuffle ? "shuffled" : category} play can't be pinned to an exact id, so it can't be guaranteed for later. Play it now (immediate), or name a specific album or track to defer.`,
          }],
          isError: true,
        };
      }
      // Pin the target to an exact provider id NOW (resolved when the future
      // queue is created, never re-resolved at play time).
      let resolved: ProviderResolve;
      try {
        resolved = await resolveProviderTarget(query, category);
      } catch (e) {
        return { content: [{ type: "text", text: `Couldn't resolve "${query}" (${category}) to a pinnable id: ${e instanceof Error ? e.message : String(e)}. Play it now instead.` }], isError: true };
      }
      if (!resolved.ok) return renderUniqueError(query, category, zone.display_name, resolved.error, resolved.candidates);
      const target = resolved.target;

      // The seam action fires the PINNED exact id(s) as a replace at the track
      // boundary. Provider ids are stable, so the same recording plays no matter
      // how long the wait or how the library shifts.
      const seamAction: SeamAction =
        target.kind === "album"
          ? async () => seamOutcomeFrom(await playOrQueueAlbumById(target.id, undefined, zoneName, "now"))
          : async () => seamOutcomeFrom(await queueOrPlayTracks(target.ids, undefined, zoneName, "now"));

      const { deferral_id } = await deferredPlayer.scheduleAfterCurrent(zone, seamAction, {
        zoneId: zone.zone_id,
        zoneName: zone.display_name,
        trigger: `end of "${np.three_line.line1}"`,
        description: `play ${target.label} - pinned at arm time`,
      });
      return {
        content: [{
          type: "text",
          text:
            `Scheduled: ${target.label} will replace the queue in '${zone.display_name}' when "${np.three_line.line1}" ends - pinned now to exact id(s), not re-resolved at play time. Track with deferred_status; cancel with cancel_deferred("${deferral_id}").`,
        }],
      };
    }
    // Nothing playing - no seam to wait for. Fall through to the immediate play.
  }

  // An immediate play supersedes any armed deferral.
  deferredPlayer.cancel();

  if (providerPinnable(category, shuffle)) {
    let zone;
    try {
      zone = roonConnection.findZoneOrThrow(zoneName);
    } catch (error) {
      return { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], isError: true };
    }
    let resolved: CombinedResolve;
    try {
      resolved = await resolveTargetWithLibraryFallback(query, zone.zone_id, category);
    } catch (e) {
      return { content: [{ type: "text", text: `Couldn't resolve "${query}" (${category}): ${e instanceof Error ? e.message : String(e)}.` }], isError: true };
    }
    if (!resolved.ok) return renderUniqueError(query, category, zone.display_name, resolved.error, resolved.candidates);
    if (resolved.source === "library") return searchAndPlay(query, zoneName, category, playActionType);
    return actOnTarget(resolved.target, zoneName, "now");
  }

  // artist, or a shuffle request: deterministic Roon-browse play (unique-or-error).
  return searchAndPlay(query, zoneName, category, playActionType);
}

/**
 * Add a name match to the queue through the provider `*_by_id` gateway: resolve
 * to ONE exact provider target (or error with candidates), then append. The
 * queue counterpart of playWithWhen's immediate path.
 */
async function addByNameToQueue(
  query: string,
  zoneName: string,
  category: "album" | "track" | "playlist",
): Promise<ToolResult> {
  let zone;
  try {
    zone = roonConnection.findZoneOrThrow(zoneName);
  } catch (error) {
    return { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], isError: true };
  }
  let resolved: CombinedResolve;
  try {
    resolved = await resolveTargetWithLibraryFallback(query, zone.zone_id, category);
  } catch (e) {
    return { content: [{ type: "text", text: `Couldn't resolve "${query}" (${category}): ${e instanceof Error ? e.message : String(e)}.` }], isError: true };
  }
  if (!resolved.ok) return renderUniqueError(query, category, zone.display_name, resolved.error, resolved.candidates);
  if (resolved.source === "library") return searchAndPlay(query, zoneName, category, "queue");
  return actOnTarget(resolved.target, zoneName, "queue");
}

/**
 * The single, uniform interrupt gate shared by every playback tool. `immediate`
 * is the ONLY switch that authorizes stopping/replacing the currently-playing
 * track. Default false = never cut the current track: play after it ends (for
 * replace-style tools) or append (for queue-style tools). This is the poka-yoke:
 * the safe behavior is the default and interrupting is an explicit opt-in.
 */
const immediateArg = immediateBool
  .optional()
  .default(false)
  .describe(
    "Interrupt/replace the currently-playing track RIGHT NOW. Default false = never cut the current track (plays after it ends / appends to the queue). Either way the name must resolve to a SINGLE exact match; an ambiguous or unmatched name returns candidates and plays nothing (the 'Gas instead of Spoon' poka-yoke). Prefer when:\"replace\" where available.",
  );

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
        .describe("Pagination offset - only meaningful with `category`."),
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
              `  [${total - end} more - call search with category="${catName}", offset=${catData.nextOffset}]`,
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
    "Search for an artist and start playing their music in a Roon zone. SAFE DEFAULT: does NOT cut the current track - it plays the artist after the current track ends (server-side, event-driven, no mid-track cut). Pass immediate:true to start the artist RIGHT NOW, replacing the current track. shuffle=true executes Roon's native Shuffle action; if the matched artist exposes no Shuffle action, it falls back to Play Now and the result text says so.",
    {
      artist: z.string().describe("Artist name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      immediate: immediateArg,
      shuffle: boolish()
        .optional()
        .default(false)
        .describe("Play in shuffled order via Roon's native Shuffle action (default false)"),
    },
    async ({ artist, zone, immediate, shuffle }) =>
      playWithWhen(artist, zone, "artist", immediate ? "now" : "after_current", shuffle ?? false),
  );

  server.tool(
    "play_album",
    "Search for an album by name and play the SINGLE EXACT match in a Roon zone, or return candidates if the name is ambiguous or unmatched - it never guesses among several and never auto-selects a fuzzy 'best' (resolves a provider album id, then funnels through play_album_by_id). SAFE DEFAULT: does NOT cut the current track - the album replaces the queue only after the current track ends (server-side, event-driven, so the queue stays clean and the playing track is never cut mid-way). when='replace' replaces the queue and plays the album RIGHT NOW (the harness-safe one-call stomp; immediate:true is the legacy equivalent).",
    {
      album: z.string().describe("Album name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      immediate: immediateArg,
      when: z
        .enum(["after_current", "replace"])
        .default("after_current")
        .describe("Placement: 'after_current' (default) replaces the queue when the current track ends (no mid-track cut); 'replace' does it RIGHT NOW. immediate:true forces replace."),
      shuffle: boolish()
        .optional()
        .default(false)
        .describe("Play in shuffled order via Roon's native Shuffle action (default false = album order)"),
    },
    async ({ album, zone, immediate, when, shuffle }) => {
      const interrupt = immediate || when === "replace";
      return playWithWhen(album, zone, "album", interrupt ? "now" : "after_current", shuffle ?? false);
    },
  );

  server.tool(
    "play_playlist",
    "Search for a playlist by name and start the SINGLE EXACT match in a Roon zone, or return candidates if the name is ambiguous or unmatched - it never guesses among several. SAFE DEFAULT: does NOT cut the current track - the playlist starts after the current track ends (server-side, event-driven, no mid-track cut). when='replace' replaces the queue and starts the playlist RIGHT NOW (the harness-safe one-call stomp; immediate:true is the legacy equivalent). shuffle=true plays the exact playlist in Roon's native shuffled order.",
    {
      playlist: z.string().describe("Playlist name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      immediate: immediateArg,
      when: z
        .enum(["after_current", "replace"])
        .default("after_current")
        .describe("Placement: 'after_current' (default) starts the playlist when the current track ends (no mid-track cut); 'replace' does it RIGHT NOW. immediate:true forces replace."),
      shuffle: boolish()
        .optional()
        .default(false)
        .describe("Play in shuffled order via Roon's native Shuffle action (default false = playlist order)"),
    },
    async ({ playlist, zone, immediate, when, shuffle }) => {
      const interrupt = immediate || when === "replace";
      return playWithWhen(playlist, zone, "playlist", interrupt ? "now" : "after_current", shuffle ?? false);
    },
  );

  server.tool(
    "play_track",
    "Search for a track/song by name and play the SINGLE EXACT match in a Roon zone, or return candidates if the name is ambiguous or unmatched - it never guesses among several and never auto-selects a fuzzy 'best' (resolves a provider track id, then funnels through play_tracks). SAFE DEFAULT: does NOT cut the current track - it plays after the current track ends (server-side, event-driven, so the queue stays clean and the playing track is never cut mid-way). Pass immediate:true to replace the queue and play the track RIGHT NOW.",
    {
      track: z.string().describe("Track/song name to search for"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      immediate: immediateArg,
    },
    async ({ track, zone, immediate }) =>
      playWithWhen(track, zone, "track", immediate ? "now" : "after_current", false),
  );

  server.tool(
    "add_to_queue",
    "Search by name and add the SINGLE EXACT match to the queue in a Roon zone, or return candidates if the name is ambiguous or unmatched (never a fuzzy guess). category='album'/'track'/'playlist' resolve a provider id and funnel through the deterministic *_by_id gateway (an album adds album-order; a playlist adds its tracks in order). category='artist' enqueues a varied stretch of that exact artist (their albums), not a single track. With no category, a deterministic Roon-browse add is used (unique-or-error).",
    {
      query: z.string().describe("Search query (track name, album title, artist name, etc.)"),
      zone: z.string().optional().default("").describe("Zone name or ID (uses default zone if omitted)"),
      category: z
        .enum(["track", "album", "artist", "playlist"])
        .optional()
        .describe("Category to search in (optional, auto-detects if not specified)"),
    },
    async ({ query, zone, category }) =>
      // artist has no stable provider id (no provider artist search) and "more of
      // this artist" means enqueue their albums, not a single row - so it keeps
      // its dedicated, verified Roon path (deterministic artist selection). The
      // provider-pinnable categories funnel through the *_by_id gateway; a bare
      // (auto-detect) add falls back to the deterministic Roon-browse path.
      category === "artist"
        ? queueArtist(query, zone)
        : category === "album" || category === "track" || category === "playlist"
          ? addByNameToQueue(query, zone, category)
          : searchAndPlay(query, zone, category, "queue"),
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

        // One session for resolve + execute: resolveLibraryActions leaves the
        // browse stack positioned at the menu carrying the toggle, and Roon
        // item_keys are only valid in the session/stack where they were loaded.
        const sessionKey = newSessionKey();
        const resolved = await resolveLibraryActions(browse, query, zoneId, cat, sessionKey);
        if (resolved.error) {
          return { content: [{ type: "text", text: resolved.error }], isError: true };
        }
        if (!resolved.matched) {
          return { content: [{ type: "text", text: `No match for "${query}".` }], isError: true };
        }

        const matched = resolved.matched;
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

        // Execute the add in the SAME session resolveLibraryActions positioned.
        const exec = await promisifyBrowse(browse, {
          hierarchy: "search",
          item_key: addAction.item_key!,
          zone_or_output_id: zoneId,
          multi_session_key: sessionKey,
        });
        if (exec.error) {
          return {
            content: [{ type: "text", text: `Error adding "${matched.title}" to library: ${exec.error}` }],
            isError: true,
          };
        }

        // Verify with a fresh navigation: the menu should now offer Remove, not Add.
        const reResolved = await resolveLibraryActions(browse, query, zoneId, cat, newSessionKey());
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
