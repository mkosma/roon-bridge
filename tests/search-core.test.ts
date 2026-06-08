/**
 * Unit tests for the search scoring + action resolution (Maya spec P0-B).
 * Pure functions, no Roon connection required.
 */

import { describe, it, expect } from "vitest";
import { scoreCandidates, resolveActionItem, stripRoonLinks } from "../src/tools/search-core.js";
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
});

describe("stripRoonLinks", () => {
  it("extracts the name from Roon link markup", () => {
    expect(stripRoonLinks("[[123|Maya Jane Coles]]")).toBe("Maya Jane Coles");
    expect(stripRoonLinks("plain")).toBe("plain");
  });
});
