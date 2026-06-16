/**
 * search-core: shared Roon browse + search primitives.
 *
 * Houses the low-level browse/load promisified helpers, the scoring matcher,
 * and the navigation-to-action-list logic that both the play tools
 * (browse.ts) and the queue tools (queue.ts) depend on.
 *
 * Design goals (per Maya's spec, P0-B "trustworthy search + addressing"):
 *  - Every find-and-act surface can report WHAT it matched and HOW closely
 *    (title, artist, album, item_key, confidence), so a loose match is
 *    visible, never silent.
 *  - The action vocabulary is data-driven and order-independent, so we never
 *    grab "Start Radio" when we meant "Play Now", or a DJ-mix when we meant
 *    the album.
 */

import type RoonApiBrowse from "node-roon-api-browse";
import type {
  BrowseOptions,
  BrowseResult,
  LoadOptions,
  LoadResult,
  BrowseItem,
} from "node-roon-api-browse";

let sessionCounter = 0;

export function newSessionKey(): string {
  return `mcp-${++sessionCounter}`;
}

export function promisifyBrowse(
  browse: RoonApiBrowse,
  opts: BrowseOptions,
): Promise<{ error: false | string; body: BrowseResult }> {
  return new Promise((resolve) =>
    browse.browse(opts, (error, body) => resolve({ error, body })),
  );
}

export function promisifyLoad(
  browse: RoonApiBrowse,
  opts: LoadOptions,
): Promise<{ error: false | string; body: LoadResult }> {
  return new Promise((resolve) =>
    browse.load(opts, (error, body) => resolve({ error, body })),
  );
}

/**
 * Strip Roon's internal link format from text.
 * Roon subtitles may contain `[[12345|Artist Name]]` - extract just the name.
 */
export function stripRoonLinks(text: string): string {
  return text.replace(/\[\[\d+\|([^\]]+)\]\]/g, "$1");
}

export function formatItems(items: BrowseItem[]): string {
  return items
    .filter((item) => item.hint !== "header")
    .map((item, i) => {
      const sub = item.subtitle ? ` - ${stripRoonLinks(item.subtitle)}` : "";
      return `${i + 1}. ${item.title}${sub}`;
    })
    .join("\n");
}

export interface BrowseAndLoadResult {
  error: string | null;
  navigated: boolean;
  list?: BrowseResult["list"];
  items?: BrowseItem[];
  message?: string;
  total?: number;
  nextOffset?: number | null;
}

const PAGE_SIZE = 100;

export async function loadPaginated(
  browse: RoonApiBrowse,
  hierarchy: string,
  sessionKey: string | undefined,
  limit: number,
  offset: number,
): Promise<{ error: string | null; items: BrowseItem[]; total: number; nextOffset: number | null }> {
  const collected: BrowseItem[] = [];
  let cursor = offset;
  let total = 0;

  while (collected.length < limit) {
    const remaining = limit - collected.length;
    const pageCount = Math.min(PAGE_SIZE, remaining);
    const loaded = await promisifyLoad(browse, {
      hierarchy,
      multi_session_key: sessionKey,
      offset: cursor,
      count: pageCount,
    });
    if (loaded.error) {
      return { error: String(loaded.error), items: collected, total, nextOffset: null };
    }
    const items = loaded.body.items || [];
    total = loaded.body.list?.count ?? collected.length + items.length;
    collected.push(...items);
    cursor += items.length;
    if (items.length < pageCount) break;
    if (cursor >= total) break;
  }

  const nextOffset = cursor < total ? cursor : null;
  return { error: null, items: collected, total, nextOffset };
}

export async function browseAndLoad(
  browse: RoonApiBrowse,
  browseOpts: BrowseOptions,
  loadCount = 100,
  loadOffset = 0,
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

  const paged = await loadPaginated(
    browse,
    browseOpts.hierarchy,
    browseOpts.multi_session_key,
    loadCount,
    loadOffset,
  );

  if (paged.error) {
    return { error: paged.error, navigated: true };
  }

  return {
    error: null,
    navigated: true,
    list: result.body.list,
    items: paged.items,
    total: paged.total,
    nextOffset: paged.nextOffset,
  };
}

/** A scored search candidate, carrying everything needed to act and to report. */
export interface ScoredCandidate {
  item: BrowseItem;
  title: string;
  /** First artist from the subtitle, links stripped, or "" if none. */
  artist: string;
  /** Full subtitle, links stripped. Often "Artist" or "Artist / Album". */
  subtitle: string;
  item_key: string;
  /** Raw score from the matcher. Higher is better. */
  score: number;
  /**
   * Normalized 0..1 closeness signal vs the best possible score for the query.
   * 1.0 = every query word matched in the title. Surfaced to the caller so a
   * loose match is visible.
   */
  confidence: number;
}

/**
 * Penalty regex for unwanted variants. DJ mixes, tributes, karaoke etc. are
 * pushed down so a bare album/track query does not silently resolve to them.
 * "DJ-Kicks" / "DJ Kicks" specifically caused the Comfort-vs-DJ-Kicks defect.
 */
const VARIANT_PENALTY = /\b(tribute|cover[s]?|karaoke|medley|in the style of|dj[-\s]?kicks|dj[-\s]?mix|mixed by|continuous mix|fabriclive|essential mix)\b/i;

/**
 * Score and rank playable items against a query. Returns candidates sorted
 * best-first, each with a confidence signal. Does NOT silently collapse to a
 * single result - the caller decides whether the top match is good enough or
 * whether to disambiguate.
 *
 * @param penalizeVariants when true (default for album/track queries), DJ
 *   mixes/compilations are pushed down. Set false when the query itself looks
 *   like it wants a mix.
 */
export function scoreCandidates(
  items: BrowseItem[],
  query: string,
  penalizeVariants = true,
): ScoredCandidate[] {
  const playable = items.filter((item) => item.item_key && item.hint !== "header");
  if (!playable.length) return [];

  const lower = query.toLowerCase().trim();
  const queryWords = lower.split(/\s+/).filter((w) => w.length > 1);

  const wantsMix = /\b(dj[-\s]?kicks|dj[-\s]?mix|mixed|fabriclive|essential mix|continuous)\b/i.test(lower);

  const scored: ScoredCandidate[] = playable.map((item, i) => {
    const titleLower = item.title.toLowerCase().trim();
    const subtitleClean = stripRoonLinks(item.subtitle || "");
    const subtitleLower = subtitleClean.toLowerCase();
    let score = 0;
    // Words accounted for by EITHER the title or the credited artist(s)/album in
    // the subtitle. Multi-artist albums (e.g. "Promises" by Floating Points /
    // Pharoah Sanders / LSO) put most query words in the subtitle, so a
    // title-only confidence wrongly scored a correct, unambiguous hit at ~20%.
    let matchedWords = 0;

    for (const word of queryWords) {
      const inTitle = titleLower.includes(word);
      if (inTitle) score += 10;
      if (inTitle || subtitleLower.includes(word)) matchedWords += 1;
    }
    for (const word of queryWords) {
      if (subtitleLower.includes(word)) score += 5;
    }

    const firstArtist = subtitleLower.split(/[,/]/)[0].trim();
    for (const word of queryWords) {
      if (word.length > 2 && firstArtist.includes(word)) score += 8;
    }

    // Exact title equality is a strong signal (e.g. "Comfort" album).
    if (titleLower === lower) score += 25;

    if (penalizeVariants && !wantsMix && VARIANT_PENALTY.test(titleLower)) {
      score -= 50;
    }
    if (penalizeVariants && !wantsMix && VARIANT_PENALTY.test(subtitleLower)) {
      score -= 20;
    }

    // Small positional tiebreak favoring Roon's own ranking.
    score += Math.max(0, 5 - i);

    const confidence = Math.max(0, Math.min(1, matchedWords / Math.max(1, queryWords.length)));

    return {
      item,
      title: item.title,
      artist: subtitleClean.split(/[,/]/)[0].trim(),
      subtitle: subtitleClean,
      item_key: item.item_key!,
      score,
      confidence,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Back-compat single best match (used by the legacy play path). */
export function bestMatch(items: BrowseItem[], query: string): BrowseItem | undefined {
  const ranked = scoreCandidates(items, query);
  return ranked[0]?.item;
}

/** The action vocabulary Roon exposes on a track/album/artist action list. */
export type QueueAction = "play_now" | "add_next" | "queue" | "shuffle";

/**
 * Titles Roon uses for the native "Shuffle" action across sources/locales.
 * Roon's local library and most streaming sources label it plainly "Shuffle";
 * some surfaces use "Shuffle Play" / "Play Shuffled" / "Shuffle All".
 */
const SHUFFLE_ACTION_TITLE = /^(shuffle|shuffle play|play shuffled|shuffle all)$/i;

/**
 * Resolve the right action item for the requested intent from an action list.
 * Matches by exact, well-known Roon titles first, then falls back. Returns the
 * BrowseItem to invoke, plus the canonical action name actually chosen so the
 * caller can report honestly (e.g. fell back to "Play Album").
 */
export function resolveActionItem(
  items: BrowseItem[],
  intent: QueueAction,
): { item: BrowseItem; matched: string } | undefined {
  const actionable = items.filter((item) => item.item_key && item.hint !== "header");
  const byTitle = (t: string) =>
    actionable.find((item) => item.title.trim().toLowerCase() === t);

  if (intent === "shuffle") {
    // Only ever the genuine native Shuffle action; never fall back to Play Now
    // here. The caller decides the fallback so it can report honestly which
    // path executed.
    const pick = actionable.find((item) => SHUFFLE_ACTION_TITLE.test(item.title.trim()));
    return pick ? { item: pick, matched: pick.title } : undefined;
  }

  if (intent === "play_now") {
    const pick =
      byTitle("play now") ||
      byTitle("play album") ||
      byTitle("play artist") ||
      actionable.find(
        (item) =>
          item.title.toLowerCase().startsWith("play") &&
          !item.title.toLowerCase().includes("radio"),
      ) ||
      actionable[0];
    return pick ? { item: pick, matched: pick.title } : undefined;
  }

  if (intent === "add_next") {
    const pick =
      byTitle("add next") ||
      byTitle("play next") ||
      // Fall back to end-of-queue only if there is genuinely no "next" action.
      byTitle("queue") ||
      byTitle("add to queue");
    return pick ? { item: pick, matched: pick.title } : undefined;
  }

  // intent === "queue" (add to end)
  const pick =
    byTitle("queue") ||
    byTitle("add to queue") ||
    actionable.find((item) => item.title.toLowerCase().includes("queue")) ||
    byTitle("play album") ||
    actionable.find(
      (item) =>
        item.title.toLowerCase().startsWith("play") &&
        !item.title.toLowerCase().includes("radio"),
    ) ||
    byTitle("play now");
  return pick ? { item: pick, matched: pick.title } : undefined;
}

export type { BrowseItem };
