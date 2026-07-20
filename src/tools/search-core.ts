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
import type { QueueItem } from "node-roon-api-transport";

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
  /** True when the title/subtitle marks a live performance (see LIVE_MARKER). */
  is_live: boolean;
  /** True when the subtitle marks a compilation / greatest-hits album. */
  is_compilation: boolean;
}

/**
 * Penalty regex for unwanted variants. DJ mixes, tributes, karaoke etc. are
 * pushed down so a bare album/track query does not silently resolve to them.
 * "DJ-Kicks" / "DJ Kicks" specifically caused the Comfort-vs-DJ-Kicks defect.
 */
const VARIANT_PENALTY = /\b(tribute|cover[s]?|karaoke|medley|in the style of|dj[-\s]?kicks|dj[-\s]?mix|mixed by|continuous mix|fabriclive|essential mix)\b/i;

/**
 * Detect a LIVE recording from a title (or album subtitle). This is the P0
 * defect: Roon's universal search ranks "Twist & Crawl (Live 1982)" and
 * "Save It For Later (Live)" above the studio cut, which wrecked sets.
 *
 * Crucially this must NOT fire on studio titles that merely contain the letters
 * "live": "Live Forever" (Oasis), "Live And Let Die", "Livin' On A Prayer",
 * "Alive". So we never match a bare word "live" - only the markers that
 * actually denote a live performance:
 *   - parenthetical/bracketed:  (Live), [Live 1982], (Live at Wembley)
 *   - trailing dash/comma:       Song - Live, Song, Live 1982
 *   - "Live at/in/from/on ...":  Live At Madstock
 *   - "Live Version/Edit/Recording", BBC/Peel Session, Unplugged, In Concert
 */
const LIVE_MARKER =
  /[([]\s*live\b[^)\]]*[)\]]|[-–,]\s*live\b|\blive\s+(at|in|from|on|version|edit|recording|session)\b|\b(bbc|peel)\s+session(s)?\b|\bunplugged\b|\bin concert\b|\blive\s+(?:19|20)\d{2}\b/i;

/**
 * Detect a compilation / greatest-hits / anthology album from a subtitle. These
 * are lightly demoted so a bare track query resolves to the track's original
 * studio album rather than a hits package, when both exist. Light by design:
 * a comp is still a valid studio recording and may be the only source.
 */
const COMPILATION_MARKER =
  /\b(greatest hits|best of|the best of|anthology|collection|compilation|the essential|essentials|gold|singles collection|20th century masters|now that's what i call|b-sides|rarities|box set)\b/i;

/** Query intent that legitimately wants a live/alt recording - suppresses the live penalty. */
const WANTS_LIVE = /[([]\s*live\b|\blive\s+(at|in|from|on|version|edit|recording|session|album)\b|\b(bbc|peel)\s+session|\bunplugged\b|\bin concert\b|\blive\b\s*$|^\s*live\b/i;

/**
 * Detect an INSTRUMENTAL recording from a title/version. Fires only on explicit
 * markers (parenthetical/bracketed, trailing "- Instrumental", or a "...
 * Instrumental Version/Mix/Edit" token), never on a bare word inside a song
 * title. Generic counterpart of the provider-side inferInstrumental, usable from
 * the Roon-browse layer where only text is available.
 */
const INSTRUMENTAL_MARKER =
  /[([]\s*instrumental\b|[-–]\s*instrumental\b|\binstrumental\s+(version|mix|edit)\b/i;

export function looksInstrumental(title: string, subtitle = ""): boolean {
  return INSTRUMENTAL_MARKER.test(title) || INSTRUMENTAL_MARKER.test(stripRoonLinks(subtitle));
}

export interface VariantFlags {
  is_live: boolean;
  is_compilation: boolean;
}

/**
 * Classify a candidate's title + subtitle for live / compilation markers. Pure
 * and exported so the version-picker tool and tests can share the exact logic
 * the scorer uses.
 */
export function classifyVariant(title: string, subtitle = ""): VariantFlags {
  const t = title || "";
  const s = stripRoonLinks(subtitle || "");
  return {
    is_live: LIVE_MARKER.test(t) || LIVE_MARKER.test(s),
    is_compilation: COMPILATION_MARKER.test(s) || COMPILATION_MARKER.test(t),
  };
}

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
  // Only suppress the live penalty when the QUERY itself asks for a live take.
  const wantsLive = WANTS_LIVE.test(lower);

  const scored: ScoredCandidate[] = playable.map((item, i) => {
    const titleLower = item.title.toLowerCase().trim();
    const subtitleClean = stripRoonLinks(item.subtitle || "");
    const subtitleLower = subtitleClean.toLowerCase();
    const flags = classifyVariant(item.title, item.subtitle);
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

    // Studio-preference (the P0 fix). Demote live takes hard when the query did
    // not ask for one - a live marker in the TITLE is the headline defect
    // ("Twist & Crawl (Live 1982)" outranking the studio cut). A compilation
    // album is demoted only lightly: still a valid studio recording, just not
    // the original release when both are present.
    if (penalizeVariants && !wantsLive && flags.is_live) {
      score -= LIVE_MARKER.test(titleLower) ? 60 : 25;
    }
    if (penalizeVariants && flags.is_compilation) {
      score -= 12;
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
      is_live: flags.is_live,
      is_compilation: flags.is_compilation,
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

/**
 * Normalize a track/album title for exact, punctuation-insensitive comparison:
 * lowercase, strip a leading "N." track-number prefix, drop bracketed
 * qualifiers, collapse punctuation and whitespace. Used by the queue-by-id
 * resolver to pin an EXACT recording rather than a fuzzy top match.
 */
export function normalizeTitle(title: string): string {
  return stripRoonLinks(title)
    .toLowerCase()
    .replace(/^\s*\d+\s*[.\-]\s*/, "") // leading "2. " / "2 - " track-number prefix
    .replace(/[([{].*?[)\]}]/g, " ") // bracketed qualifiers (feat. / remaster / live)
    .replace(/[^\p{L}\p{N}]+/gu, " ") // any non-alphanumeric -> space
    .trim()
    .replace(/\s+/g, " ");
}

/** True when `a` and `b` name the same artist (normalized exact or substring). */
export function artistMatches(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** A track-identity descriptor coming from a provider (Qobuz), for matching. */
export interface TrackIdentity {
  title: string;
  artist: string;
  album?: string;
  trackNumber?: number;
  /** Provider version/edition token ("Live", "Remastered", ...), when known. */
  version?: string;
  /** Provider track length in seconds, when known (read-back / pin assist). */
  durationSec?: number;
}

/**
 * Whether the recording a provider id denotes is a LIVE take (so a live Roon row
 * is the CORRECT match, not a substitution). A studio cut answers false: a live
 * sibling must then be REJECTED, never silently queued in its place. This closes
 * the wrong-recording defect - normalizeTitle deliberately strips "(Live ...)",
 * so without this discriminator a live row collapses to the same title as the
 * studio cut and passes as an exact match.
 */
export function identityWantsLive(target: TrackIdentity): boolean {
  if (classifyVariant(target.title).is_live) return true;
  return LIVE_MARKER.test(target.version ?? "") || /\blive\b/i.test(target.version ?? "");
}

/**
 * Deterministically pick the browse row for an EXACT track from a list of
 * candidate rows (either Tracks-category search results or an album's track
 * listing), using a provider's authoritative title/artist/album/number.
 *
 * Selection is exact, never fuzzy:
 *   1. Keep rows whose normalized title equals the target title.
 *   2. If an artist is carried in the row subtitle, require it to match.
 *   3. If still tied, prefer a row whose album (subtitle, when present) matches.
 *   4. If still tied, prefer the row whose leading "N." number == trackNumber.
 *
 * Returns the chosen row plus whether the pick was unambiguous, so the caller
 * can report a tie honestly instead of guessing. `albumKnown` says whether the
 * rows even carry album text to disambiguate on (album track listings usually
 * do not - the album is the page, not the row).
 */
export function pickTrackRow(
  rows: BrowseItem[],
  target: TrackIdentity,
  opts: { rowsCarryArtist?: boolean } = {},
): { item: BrowseItem; unambiguous: boolean; tiedCount: number } | undefined {
  const wantTitle = normalizeTitle(target.title);
  const playable = rows.filter((r) => r.item_key && r.hint !== "header");

  let titleHits = playable.filter((r) => normalizeTitle(r.title) === wantTitle);
  if (!titleHits.length) {
    // Fall back to a contains match (Roon sometimes appends a qualifier).
    titleHits = playable.filter((r) => normalizeTitle(r.title).includes(wantTitle) && wantTitle.length > 0);
  }
  if (!titleHits.length) return undefined;

  // Variant pinning (the wrong-recording defect): normalizeTitle strips
  // "(Live ...)", so a live sibling collapses to the same title as the studio
  // cut - which is how queue_by_id queued a live take while reporting the studio
  // title. Keep only rows whose live/studio character matches what the provider
  // id actually denotes. If NONE match (e.g. only a live row is present but the
  // id is the studio cut), return undefined so the caller fails honestly or
  // falls back to the album anchor, instead of substituting the wrong recording.
  const wantLive = identityWantsLive(target);
  const variantHits = titleHits.filter(
    (r) => classifyVariant(r.title, stripRoonLinks(r.subtitle || "")).is_live === wantLive,
  );
  if (!variantHits.length) return undefined;
  titleHits = variantHits;

  let pool = titleHits;
  if (opts.rowsCarryArtist) {
    const artistHits = pool.filter((r) => artistMatches(stripRoonLinks(r.subtitle || ""), target.artist));
    if (artistHits.length) pool = artistHits;
  }

  if (pool.length > 1 && target.album) {
    const wantAlbum = normalizeTitle(target.album);
    const albumHits = pool.filter((r) => {
      const sub = normalizeTitle(r.subtitle || "");
      return sub.length > 0 && (sub.includes(wantAlbum) || wantAlbum.includes(sub));
    });
    if (albumHits.length) pool = albumHits;
  }

  if (pool.length > 1 && target.trackNumber != null) {
    const byNumber = pool.find((r) => {
      const m = r.title.match(/^\s*(\d+)\s*[.\-]/);
      return m && Number(m[1]) === target.trackNumber;
    });
    if (byNumber) return { item: byNumber, unambiguous: true, tiedCount: pool.length };
  }

  return { item: pool[0], unambiguous: pool.length === 1, tiedCount: pool.length };
}

/** An album-identity descriptor coming from a provider (Qobuz), for exact pinning. */
export interface AlbumIdentity {
  title: string;
  artist: string;
  year?: number;
  /** The album's real track count, when the provider reports one - used to
   *  verify a WHOLE album landed on queue/next, not just that the queue grew. */
  expectedTrackCount?: number;
}

/**
 * Deterministically pick the browse row for an EXACT album from a list of
 * candidate Albums-category rows, using a provider's authoritative
 * title/artist/year. Never falls back to a fuzzy top-1 match (bestMatch) - the
 * whole point of an ID-anchored resolve is that a loose word-score guess can
 * never substitute a different release.
 *
 *   1. Keep rows whose normalized title equals the target title.
 *   2. If the row subtitle carries an artist, require it to match.
 *   3. If still tied, prefer a row whose subtitle carries the target year
 *      (Roon album subtitles are often "Artist · Year" or similar).
 *
 * Returns the chosen row plus whether the pick was unambiguous, so the caller
 * can report a tie honestly instead of guessing.
 */
export function pickAlbumRow(
  rows: BrowseItem[],
  target: AlbumIdentity,
): { item: BrowseItem; unambiguous: boolean; tiedCount: number } | undefined {
  const wantTitle = normalizeTitle(target.title);
  const playable = rows.filter((r) => r.item_key && r.hint !== "header");

  let titleHits = playable.filter((r) => normalizeTitle(r.title) === wantTitle);
  if (!titleHits.length) return undefined;

  let pool = titleHits;
  const artistHits = pool.filter((r) => artistMatches(stripRoonLinks(r.subtitle || ""), target.artist));
  if (artistHits.length) pool = artistHits;

  if (pool.length > 1 && target.year != null) {
    const yearStr = String(target.year);
    const yearHits = pool.filter((r) => stripRoonLinks(r.subtitle || "").includes(yearStr));
    if (yearHits.length) pool = yearHits;
  }

  return { item: pool[0], unambiguous: pool.length === 1, tiedCount: pool.length };
}

/**
 * Run a search and return the scored candidate list for a single category,
 * without drilling into any action list. This is the read-only half of the
 * find-and-act flow: it powers the version picker (which needs to SHOW the
 * candidates and their is_live/is_compilation flags) and any deterministic
 * re-resolution that selects an exact recording rather than the top match.
 *
 * `hierarchy` defaults to "search" (universal: library + streaming). Pass a
 * library-only hierarchy ("albums"/"artists") to scope to Monty's library.
 */
export async function searchScoredCandidates(
  browse: RoonApiBrowse,
  query: string,
  zoneId: string | undefined,
  category: string | undefined,
  sessionKey: string,
  hierarchy = "search",
): Promise<{ error?: string; categoryTitle?: string; candidates: ScoredCandidate[] }> {
  const searchData = await browseAndLoad(browse, {
    hierarchy,
    input: query,
    pop_all: true,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (searchData.error) return { error: searchData.error, candidates: [] };
  if (!searchData.items?.length) return { candidates: [] };

  // Pick the category bucket (Tracks/Albums/...). When unspecified, take the
  // first playable category Roon offers (its own best guess).
  const cats = searchData.items;
  let targetCategory: BrowseItem | undefined;
  if (category) {
    const catLower = category.toLowerCase();
    targetCategory =
      cats.find((c) => c.item_key && (c.title.toLowerCase() === catLower + "s" || c.title.toLowerCase() === catLower)) ||
      cats.find((c) => c.item_key && c.title.toLowerCase().includes(catLower) && c.hint !== "header");
  }
  targetCategory ??= cats.find((c) => c.item_key && c.hint !== "header");
  if (!targetCategory?.item_key) return { candidates: [] };

  const categoryData = await browseAndLoad(browse, {
    hierarchy,
    item_key: targetCategory.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: sessionKey,
  });
  if (categoryData.error) return { error: categoryData.error, candidates: [] };
  if (!categoryData.items?.length) return { categoryTitle: targetCategory.title, candidates: [] };

  const penalize = category !== "playlist";
  const ranked = scoreCandidates(categoryData.items, query, penalize);
  return { categoryTitle: categoryData.list?.title || targetCategory.title, candidates: ranked };
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

/**
 * Poll a queue snapshot until it SETTLES - identical length and item ids across a
 * quiet window - or a deadline. A large-queue replace can take Roon several
 * seconds to drain and rebuild, during which a snapshot may show a transient
 * full block that then collapses; judging before settle is the dropped-tracks
 * false positive (BUG B). Returns the last snapshot seen. Drives the post-action
 * verification in both the batch enqueue and the album add.
 */
export async function waitForStableQueue(
  snapshot: () => Promise<QueueItem[]>,
  opts: { quietMs?: number; deadlineMs?: number; pollMs?: number } = {},
): Promise<QueueItem[]> {
  const quietMs = opts.quietMs ?? 300;
  const deadlineMs = opts.deadlineMs ?? 12000;
  const pollMs = opts.pollMs ?? 120;
  const sig = (q: QueueItem[]) => `${q.length}:${q.map((i) => i.queue_item_id).join(",")}`;

  const deadline = Date.now() + deadlineMs;
  let last = await snapshot();
  let lastSig = sig(last);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const cur = await snapshot();
    const curSig = sig(cur);
    if (curSig === lastSig) {
      if (Date.now() - stableSince >= quietMs) return cur;
      last = cur;
    } else {
      last = cur;
      lastSig = curSig;
      stableSince = Date.now();
    }
  }
  return last;
}

export type { BrowseItem };
