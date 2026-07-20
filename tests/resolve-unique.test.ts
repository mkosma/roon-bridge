/**
 * The deterministic playback poka-yoke - acceptance table A-F
 * (spec-bridge-fuzzy-play-poka-yoke-2026-07-19).
 *
 * Proves the guarantee at its source: for any candidate substrate and any
 * query, selectUnique yields the ONE exact match, or an error - never a fuzzy
 * guess among several. A and D are load-bearing: A must never resolve (so the
 * caller never mutates), D must always resolve to the exact one.
 *
 * F (play_*_by_id plays exactly that id) is not exercised here because the
 * selection core is bypassed entirely on the by-id path - it is proven by the
 * existing album-by-id / play-by-id suites, which stay green.
 */

import { describe, it, expect } from "vitest";
import { isExactMatch, selectUnique, type UniqueCandidate } from "../src/tools/resolve-unique.js";

const A = (id: string, title: string, artist?: string, year?: number): UniqueCandidate => ({ id, title, artist, year });

describe("selectUnique - acceptance A-E", () => {
  it("A: two identical title+artist+year rows -> ambiguous (never resolves; caller must not mutate)", () => {
    const cands = [A("1", "Reflection", "Brian Eno", 2019), A("2", "Reflection", "Brian Eno", 2019)];
    const byTitle = selectUnique(cands, "Reflection", "album");
    expect(byTitle.kind).toBe("ambiguous");
    // Also ambiguous when the query names the (shared) artist.
    const byArtist = selectUnique(cands, "Brian Eno Reflection", "album");
    expect(byArtist.kind).toBe("ambiguous");
    if (byArtist.kind === "ambiguous") {
      expect(byArtist.candidates).toHaveLength(2);
      expect(byArtist.candidates.every((c) => c.confidence === 1)).toBe(true);
    }
  });

  it("B: two same-title, different artist, query has no artist -> ambiguous", () => {
    const cands = [A("1", "Reflection", "Brian Eno"), A("2", "Reflection", "Tool")];
    const res = selectUnique(cands, "Reflection", "album");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.candidates.map((c) => c.id).sort()).toEqual(["1", "2"]);
  });

  it("C: two same-title, query includes the distinguishing artist -> resolves the correct one", () => {
    const cands = [A("eno", "Reflection", "Brian Eno"), A("tool", "Reflection", "Tool")];
    const res = selectUnique(cands, "Tool Reflection", "album");
    expect(res.kind).toBe("unique");
    if (res.kind === "unique") expect(res.candidate.id).toBe("tool");
    // The other ordering of the same words resolves identically.
    const res2 = selectUnique(cands, "Reflection Tool", "album");
    expect(res2.kind).toBe("unique");
    if (res2.kind === "unique") expect(res2.candidate.id).toBe("tool");
  });

  it("D: one exact match among several fuzzy near-misses -> plays the exact one", () => {
    const cands = [
      A("near1", "Spoons", "Some Artist"),
      A("exact", "Spoon", "Some Artist"),
      A("near2", "The Spoon", "Some Artist"),
      A("near3", "Kill the Moonlight", "Spoon"),
    ];
    const res = selectUnique(cands, "Spoon", "album");
    expect(res.kind).toBe("unique");
    if (res.kind === "unique") expect(res.candidate.id).toBe("exact");
  });

  it("E: zero exact matches -> not_found + a ranked fuzzy list, no resolution", () => {
    const cands = [A("1", "Totally Unrelated Recording", "X"), A("2", "Another Thing", "Y")];
    const res = selectUnique(cands, "Kill The Moonlight", "album");
    expect(res.kind).toBe("not_found");
    if (res.kind === "not_found") {
      expect(res.candidates.length).toBeGreaterThan(0);
      expect(res.candidates.every((c) => typeof c.confidence === "number")).toBe(true);
    }
  });
});

describe("selectUnique - punctuation/bracket-insensitive exactness (near-misses do not collide)", () => {
  it("normalized equality ignores bracketed qualifiers and punctuation", () => {
    // Trailing punctuation and an "&" collapse to the same normalized key.
    const cands = [A("x", "Twist & Crawl!", "The Beat")];
    expect(selectUnique(cands, "Twist  Crawl", "album").kind).toBe("unique");
    const bracketed = [A("y", "Reflection (Deluxe Edition)", "Brian Eno")];
    expect(selectUnique(bracketed, "Reflection", "album").kind).toBe("unique");
  });

  it("a genuinely different deluxe title is NOT an exact match", () => {
    const cands = [A("deluxe", "OK Computer OKNOTOK 1997 2017", "Radiohead"), A("orig", "OK Computer", "Radiohead")];
    const res = selectUnique(cands, "OK Computer", "album");
    expect(res.kind).toBe("unique");
    if (res.kind === "unique") expect(res.candidate.id).toBe("orig");
  });
});

describe("selectUnique - track and playlist categories", () => {
  it("track: exact title with artist-qualified query resolves; bare shared title is ambiguous", () => {
    const cands = [A("t1", "Puppets", "Depeche Mode"), A("t2", "Puppets", "Motion City")];
    expect(selectUnique(cands, "Puppets", "track").kind).toBe("ambiguous");
    const r = selectUnique(cands, "Depeche Mode Puppets", "track");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.candidate.id).toBe("t1");
  });

  it("playlist: exact name resolves; a near name does not create a false match", () => {
    const cands = [A("p1", "Deep Focus"), A("p2", "Deep Focus Instrumentals")];
    const r = selectUnique(cands, "Deep Focus", "playlist");
    expect(r.kind).toBe("unique");
    if (r.kind === "unique") expect(r.candidate.id).toBe("p1");
  });
});

describe("isExactMatch - artist category matches on artist-name only", () => {
  it("resolves an exact artist name", () => {
    const c = A("a", "Maya Jane Coles");
    expect(isExactMatch(c, "Maya Jane Coles", "artist")).toBe(true);
    expect(isExactMatch(c, "maya  jane   coles", "artist")).toBe(true);
    expect(isExactMatch(c, "Maya Jane", "artist")).toBe(false);
  });

  it("empty query never matches", () => {
    expect(isExactMatch(A("a", "Anything"), "", "album")).toBe(false);
  });
});
