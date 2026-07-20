/**
 * resolve-unique: the deterministic playback poka-yoke (Grady's design,
 * 2026-07-19; closes Monty's 2026-06-24 determinism directive).
 *
 * Separates NAME resolution from mutation. A name-based play/queue resolves to
 * exactly ONE exact match, or an error - it never guesses among several and
 * never auto-selects a fuzzy "best". This is the countermeasure for the "Gas
 * instead of Spoon" class and the direct answer to Monty's governing test: a
 * deterministic operation must not exist in a form where an unexpected result is
 * possible.
 *
 * The pure SELECTION core (isExactMatch / selectUnique) lives here so the
 * guarantee is unit-tested in isolation, before any provider search runs and
 * before any zone is ever touched. The async orchestration that fetches the
 * candidate substrate and hands a unique match to the deterministic `*_by_id`
 * gateway lives in browse.ts.
 *
 * KEY PROPERTY: near-misses do NOT create ambiguity. One exact match among ten
 * fuzzy neighbors still resolves and acts (case D). Ambiguity means 2+ rows that
 * are EXACTLY the named thing on the normalized key (case A/B) - the only case
 * the bridge would otherwise have to guess between. There is NO threshold
 * anywhere: exactness is a set-membership test, not a score.
 */

import { normalizeTitle, scoreCandidates, type BrowseItem } from "./search-core.js";

export type ResolveCategory = "album" | "track" | "artist" | "playlist";

/**
 * A search-substrate candidate normalized to a common shape. For the `artist`
 * category, `title` carries the artist name (and `artist` is unused).
 */
export interface UniqueCandidate {
  id: string;
  title: string;
  artist?: string;
  year?: number;
  in_library?: boolean;
  is_live?: boolean;
  is_compilation?: boolean;
  instrumental?: boolean;
}

export interface RankedCandidate extends UniqueCandidate {
  /** 0..1 fuzzy closeness, for the error payload only. 1.0 for a tied exact. */
  confidence: number;
}

export type SelectResult =
  | { kind: "unique"; candidate: UniqueCandidate }
  | { kind: "not_found"; candidates: RankedCandidate[] }
  | { kind: "ambiguous"; candidates: RankedCandidate[] };

/** How many ranked near-misses to surface on a not_found. */
const NOT_FOUND_LIMIT = 5;

/**
 * Whether a candidate is EXACTLY the named thing on the normalized key
 * (search-core's `normalizeTitle`: lowercased, track-number prefix stripped,
 * bracketed qualifiers dropped, punctuation collapsed).
 *
 *  - artist:              normalized artist-name equals the normalized query.
 *  - album/track/playlist: normalized TITLE equals the normalized query. When
 *    the free-text query ALSO named the artist, an exact match additionally
 *    requires the artist - and the only signal that the artist WAS named, given
 *    a single query string, is that an artist-qualified form of THIS candidate
 *    ("artist title" / "title artist") reproduces the whole query. That form
 *    can only equal the query when both the title AND the artist matched, which
 *    is precisely "additionally require exact artist match".
 */
export function isExactMatch(c: UniqueCandidate, query: string, category: ResolveCategory): boolean {
  const nq = normalizeTitle(query);
  if (!nq) return false;
  const nt = normalizeTitle(c.title);
  if (!nt) return false;

  if (category === "artist") return nt === nq;

  // Title-only query.
  if (nt === nq) return true;

  // Artist-qualified query.
  const artist = (c.artist ?? "").trim();
  if (!artist) return false;
  return normalizeTitle(`${artist} ${c.title}`) === nq || normalizeTitle(`${c.title} ${artist}`) === nq;
}

/** Rank the whole candidate set fuzzily for a not_found payload (never to act). */
function rankForNotFound(
  candidates: UniqueCandidate[],
  query: string,
  category: ResolveCategory,
): RankedCandidate[] {
  const penalize = category !== "playlist";
  const items: BrowseItem[] = candidates.map(
    (c) => ({ item_key: c.id, title: c.title, subtitle: c.artist ?? "", hint: "action_list" }) as BrowseItem,
  );
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return scoreCandidates(items, query, penalize)
    .slice(0, NOT_FOUND_LIMIT)
    .map((s) => {
      const c = byId.get(s.item.item_key!)!;
      return { ...c, confidence: Number(s.confidence.toFixed(2)) };
    });
}

/**
 * The whole guarantee. Filter the candidate substrate to EXACT matches on the
 * normalized key, then:
 *   - exactly one  -> unique (act).
 *   - zero         -> not_found + a fuzzy ranking so the caller can pick.
 *   - two or more  -> ambiguous + the tied survivors (confidence 1.0 each).
 * Never mutates anything; the caller decides what to do with each outcome.
 */
export function selectUnique(
  candidates: UniqueCandidate[],
  query: string,
  category: ResolveCategory,
): SelectResult {
  const exact = candidates.filter((c) => isExactMatch(c, query, category));
  if (exact.length === 1) return { kind: "unique", candidate: exact[0] };
  if (exact.length === 0) return { kind: "not_found", candidates: rankForNotFound(candidates, query, category) };
  return { kind: "ambiguous", candidates: exact.map((c) => ({ ...c, confidence: 1 })) };
}
