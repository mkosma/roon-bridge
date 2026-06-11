/**
 * Unit tests for the search scoring + action resolution (Maya spec P0-B).
 * Pure functions, no Roon connection required.
 */

import { describe, it, expect } from "vitest";
import { scoreCandidates, resolveActionItem, stripRoonLinks, classifyVariant } from "../src/tools/search-core.js";
import type { BrowseItem } from "../src/tools/search-core.js";

function item(title: string, subtitle?: string, key = title): BrowseItem {
  return { title, subtitle, item_key: `key:${key}`, hint: "list" };
}

describe("scoreCandidates", () => {
  it("ranks the exact 'Comfort' album above the DJ-Kicks mix (tonight defect #3)", () => {
    const items: BrowseItem[] = [
      item("DJ-Kicks (Maya Jane Coles)", "Maya Jane Coles", "djk"),
      item("Comfort", "Maya Jane Coles", "comfort"),
    ];
    const ranked = scoreCandidates(items, "Comfort", true);
    expect(ranked[0].title).toBe("Comfort");
    expect(ranked[0].confidence).toBeGreaterThan(0.9);
  });

  it("penalizes DJ-Kicks / mix variants when not asked for", () => {
    const items: BrowseItem[] = [
      item("Some Track (DJ-Kicks)", "Maya Jane Coles", "a"),
      item("Some Track", "Maya Jane Coles", "b"),
    ];
    const ranked = scoreCandidates(items, "Some Track", true);
    expect(ranked[0].title).toBe("Some Track");
  });

  it("does NOT penalize a mix when the query asks for it", () => {
    const items: BrowseItem[] = [
      item("DJ-Kicks", "Maya Jane Coles", "a"),
      item("Comfort", "Maya Jane Coles", "b"),
    ];
    const ranked = scoreCandidates(items, "DJ-Kicks Maya Jane Coles", true);
    expect(ranked[0].title).toBe("DJ-Kicks");
  });

  it("exposes a confidence signal that drops for a loose match", () => {
    const items: BrowseItem[] = [item("Totally Different Song", "Other Artist", "a")];
    const ranked = scoreCandidates(items, "Comfort", true);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].confidence).toBeLessThan(0.5);
  });

  it("does not under-report confidence on a multi-artist album (FIX-4: Promises)", () => {
    // The album's four credited artists live in the subtitle; a title-only
    // confidence scored this correct, unambiguous hit at ~20%.
    const items: BrowseItem[] = [
      item("Promises", "Floating Points / Pharoah Sanders / London Symphony Orchestra", "p"),
      item("Something Else", "Nobody In Particular", "x"),
    ];
    const ranked = scoreCandidates(items, "Promises Floating Points Pharoah Sanders", true);
    expect(ranked[0].title).toBe("Promises");
    expect(ranked[0].confidence).toBeGreaterThan(0.9);
  });

  it("resolves an artist alias via subtitle match (Nocturnal Sunshine / Maya Jane Coles)", () => {
    const items: BrowseItem[] = [
      item("Meant To Be", "Nocturnal Sunshine / Maya Jane Coles", "a"),
      item("Random", "Someone Else", "b"),
    ];
    const ranked = scoreCandidates(items, "Maya Jane Coles Meant To Be", true);
    expect(ranked[0].title).toBe("Meant To Be");
  });

  it("handles unicode titles (RÜFÜS DU SOL, Öngyilkos Vasárnap)", () => {
    const items: BrowseItem[] = [
      item("Tonight", "RÜFÜS DU SOL", "a"),
      item("Other", "Nobody", "b"),
    ];
    const ranked = scoreCandidates(items, "Tonight RÜFÜS DU SOL", true);
    expect(ranked[0].title).toBe("Tonight");
    const uni = scoreCandidates([item("Öngyilkos Vasárnap", "Some Artist", "z")], "Öngyilkos Vasárnap", true);
    expect(uni[0].title).toBe("Öngyilkos Vasárnap");
    expect(uni[0].confidence).toBeGreaterThan(0.9);
  });

  it("returns empty for no playable items (loud no-match, not a silent pick)", () => {
    const items: BrowseItem[] = [{ title: "Header", hint: "header" }];
    expect(scoreCandidates(items, "anything", true)).toHaveLength(0);
  });

  // --- Studio-over-live (the P0 defect that wrecked sets, 2026-06-10) ---------

  it("ranks the studio 'Twist & Crawl' above the live take (acceptance case)", () => {
    const items: BrowseItem[] = [
      item("Twist & Crawl (Live 1982)", "The Beat", "live"),
      item("Twist & Crawl", "The Beat / I Just Can't Stop It", "studio"),
    ];
    const ranked = scoreCandidates(items, "Twist & Crawl", true);
    expect(ranked[0].title).toBe("Twist & Crawl");
    expect(ranked[0].is_live).toBe(false);
  });

  it("demotes the other live cuts that ruined sets (Save It For Later / Start Me Up / Our House)", () => {
    const cases: Array<[string, string, string]> = [
      ["Save It For Later", "Save It For Later (Live)", "The Beat"],
      ["Start Me Up", "Start Me Up - Live", "The Rolling Stones"],
      ["Our House", "Our House (Live At Madstock)", "Madness"],
    ];
    for (const [query, liveTitle, artist] of cases) {
      const ranked = scoreCandidates(
        [item(liveTitle, artist, "live"), item(query, artist, "studio")],
        query,
        true,
      );
      expect(ranked[0].title, `studio should win for "${query}"`).toBe(query);
    }
  });

  it("does NOT demote a live take when the query explicitly asks for live", () => {
    const ranked = scoreCandidates(
      [item("Twist & Crawl", "The Beat", "studio"), item("Twist & Crawl (Live 1982)", "The Beat", "live")],
      "Twist & Crawl Live",
      true,
    );
    expect(ranked[0].title).toBe("Twist & Crawl (Live 1982)");
  });

  it("does NOT misfire on studio titles that merely contain the letters 'live'", () => {
    // "Live Forever" is a studio Oasis song; must not be flagged or demoted.
    expect(classifyVariant("Live Forever", "Oasis").is_live).toBe(false);
    expect(classifyVariant("Live And Let Die", "Wings").is_live).toBe(false);
    expect(classifyVariant("Livin' On A Prayer", "Bon Jovi").is_live).toBe(false);
    const ranked = scoreCandidates(
      [item("Live Forever", "Oasis / Definitely Maybe", "studio")],
      "Live Forever Oasis",
      true,
    );
    expect(ranked[0].is_live).toBe(false);
    expect(ranked[0].confidence).toBeGreaterThan(0.9);
  });

  it("lightly demotes a greatest-hits compilation below the original album", () => {
    const ranked = scoreCandidates(
      [
        item("Wonderwall", "Oasis / The Best Of Oasis", "comp"),
        item("Wonderwall", "Oasis / (What's the Story) Morning Glory?", "studio"),
      ],
      "Wonderwall Oasis",
      true,
    );
    expect(ranked[0].is_compilation).toBe(false);
    expect(ranked[0].subtitle).toContain("Morning Glory");
    expect(ranked.find((c) => c.subtitle.includes("Best Of"))?.is_compilation).toBe(true);
  });
});

describe("classifyVariant", () => {
  it("flags bracketed/dashed/at-phrase live markers", () => {
    expect(classifyVariant("Song (Live)").is_live).toBe(true);
    expect(classifyVariant("Song [Live 1982]").is_live).toBe(true);
    expect(classifyVariant("Song - Live").is_live).toBe(true);
    expect(classifyVariant("Song", "Album (Live at Wembley)").is_live).toBe(true);
    expect(classifyVariant("Hey Jude", "MTV Unplugged").is_live).toBe(true);
  });

  it("flags compilation albums via subtitle", () => {
    expect(classifyVariant("Track", "Artist / Greatest Hits").is_compilation).toBe(true);
    expect(classifyVariant("Track", "Artist / The Essential Artist").is_compilation).toBe(true);
    expect(classifyVariant("Track", "Artist / Definitely Maybe").is_compilation).toBe(false);
  });
});

describe("resolveActionItem", () => {
  const actionList: BrowseItem[] = [
    { title: "Play Now", item_key: "k1", hint: "action" },
    { title: "Add Next", item_key: "k2", hint: "action" },
    { title: "Queue", item_key: "k3", hint: "action" },
    { title: "Start Radio", item_key: "k4", hint: "action" },
  ];

  it("queue_next selects 'Add Next', never 'Start Radio' or 'Play Now'", () => {
    const r = resolveActionItem(actionList, "add_next");
    expect(r?.matched).toBe("Add Next");
  });

  it("play_now selects 'Play Now'", () => {
    expect(resolveActionItem(actionList, "play_now")?.matched).toBe("Play Now");
  });

  it("queue selects 'Queue'", () => {
    expect(resolveActionItem(actionList, "queue")?.matched).toBe("Queue");
  });

  it("add_next falls back to 'Queue' when no next action exists", () => {
    const noNext: BrowseItem[] = [
      { title: "Play Now", item_key: "k1", hint: "action" },
      { title: "Queue", item_key: "k3", hint: "action" },
    ];
    expect(resolveActionItem(noNext, "add_next")?.matched).toBe("Queue");
  });

  it("returns undefined when no actionable items", () => {
    expect(resolveActionItem([{ title: "h", hint: "header" }], "play_now")).toBeUndefined();
  });

  it("shuffle selects the native 'Shuffle' action when present", () => {
    const withShuffle: BrowseItem[] = [
      { title: "Play Now", item_key: "k1", hint: "action" },
      { title: "Shuffle", item_key: "k2", hint: "action" },
      { title: "Queue", item_key: "k3", hint: "action" },
    ];
    const r = resolveActionItem(withShuffle, "shuffle");
    expect(r?.matched).toBe("Shuffle");
    expect(r?.item.item_key).toBe("k2");
  });

  it("shuffle matches locale/source title variants (Shuffle Play, Play Shuffled, Shuffle All)", () => {
    for (const title of ["Shuffle Play", "Play Shuffled", "Shuffle All"]) {
      const list: BrowseItem[] = [
        { title: "Play Now", item_key: "k1", hint: "action" },
        { title, item_key: "k2", hint: "action" },
      ];
      expect(resolveActionItem(list, "shuffle")?.matched).toBe(title);
    }
  });

  it("shuffle returns undefined (no fake fallback) when no Shuffle action exists", () => {
    // The honest-fallback decision belongs to the caller, not the resolver.
    expect(resolveActionItem(actionList, "shuffle")).toBeUndefined();
  });

  it("shuffle does not grab a 'Start Radio' or 'Play Now' action", () => {
    const noShuffle: BrowseItem[] = [
      { title: "Play Now", item_key: "k1", hint: "action" },
      { title: "Start Radio", item_key: "k4", hint: "action" },
    ];
    expect(resolveActionItem(noShuffle, "shuffle")).toBeUndefined();
  });
});

describe("stripRoonLinks", () => {
  it("extracts the name from Roon link markup", () => {
    expect(stripRoonLinks("[[123|Maya Jane Coles]]")).toBe("Maya Jane Coles");
    expect(stripRoonLinks("plain")).toBe("plain");
  });
});
