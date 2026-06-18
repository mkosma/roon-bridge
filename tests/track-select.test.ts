/**
 * Unit tests for the deterministic track-row selection that backs queue_by_id /
 * play_by_id. Pure functions, no Roon connection required. The headline case is
 * "Puppets" by Atmosphere - two same-titled studio recordings on different
 * albums, which fuzzy name search and queue_version cannot pin.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeTitle,
  artistMatches,
  pickTrackRow,
  type BrowseItem,
  type TrackIdentity,
} from "../src/tools/search-core.js";

function row(title: string, subtitle?: string, key = title): BrowseItem {
  return { title, subtitle, item_key: `key:${key}`, hint: "list" };
}

describe("normalizeTitle", () => {
  it("strips a leading track-number prefix", () => {
    expect(normalizeTitle("2. Puppets")).toBe("puppets");
    expect(normalizeTitle("10 - Puppets")).toBe("puppets");
  });
  it("drops bracketed qualifiers and punctuation", () => {
    expect(normalizeTitle("Puppets (Remastered 2008)")).toBe("puppets");
    expect(normalizeTitle("Don't Stop — Believin'")).toBe("don t stop believin");
  });
  it("is stable across case and spacing", () => {
    expect(normalizeTitle("  THE   Puppets ")).toBe("the puppets");
  });
});

describe("artistMatches", () => {
  it("matches exact and substring artist names", () => {
    expect(artistMatches("Atmosphere", "Atmosphere")).toBe(true);
    expect(artistMatches("Atmosphere, Ant", "Atmosphere")).toBe(true);
    expect(artistMatches("Sophie Am", "Atmosphere")).toBe(false);
  });
  it("rejects empty inputs", () => {
    expect(artistMatches("", "Atmosphere")).toBe(false);
  });
});

describe("pickTrackRow", () => {
  const puppets: TrackIdentity = {
    title: "Puppets",
    artist: "Atmosphere",
    album: "When Life Gives You Lemons, You Paint That Shit Gold",
    trackNumber: 2,
  };

  it("picks the single exact title+artist match (common case)", () => {
    const rows = [
      row("Sunshine", "Atmosphere"),
      row("Puppets", "Atmosphere"),
      row("Yesterday", "Atmosphere"),
    ];
    const pick = pickTrackRow(rows, puppets, { rowsCarryArtist: true });
    expect(pick?.item.item_key).toBe("key:Puppets");
    expect(pick?.unambiguous).toBe(true);
  });

  it("rejects a wrong-artist cover even when the title matches (type-beat defect)", () => {
    const rows = [
      row("Puppets", "Sophie Am"), // type beat - wrong artist
      row("Puppets", "Atmosphere"), // the real one
    ];
    const pick = pickTrackRow(rows, puppets, { rowsCarryArtist: true });
    expect(pick?.item.subtitle).toBe("Atmosphere");
  });

  it("disambiguates two same-artist albums by album text when rows carry it", () => {
    const rows = [
      row("Puppets", "When Life Gives You Lemons, You Paint That Shit Gold", "a"),
      row("Puppets", "Triple X Years In The Game", "b"),
    ];
    const pick = pickTrackRow(rows, puppets, { rowsCarryArtist: false });
    expect(pick?.item.item_key).toBe("key:a");
    expect(pick?.unambiguous).toBe(true);
  });

  it("disambiguates an album track listing by track number when rows lack album text", () => {
    // Album page: rows are "N. Title", no album subtitle. Two same-titled rows
    // (e.g. a reprise) disambiguated by the provider's track number.
    const rows = [row("2. Puppets", undefined, "two"), row("9. Puppets", undefined, "nine")];
    const pick = pickTrackRow(rows, puppets, { rowsCarryArtist: false });
    expect(pick?.item.item_key).toBe("key:two");
    expect(pick?.unambiguous).toBe(true);
  });

  it("reports a tie honestly when nothing disambiguates", () => {
    const rows = [row("Puppets", "Atmosphere", "a"), row("Puppets", "Atmosphere", "b")];
    const noNumber: TrackIdentity = { title: "Puppets", artist: "Atmosphere" };
    const pick = pickTrackRow(rows, noNumber, { rowsCarryArtist: true });
    expect(pick?.tiedCount).toBe(2);
    expect(pick?.unambiguous).toBe(false);
  });

  it("returns undefined when the title is absent", () => {
    const rows = [row("Sunshine", "Atmosphere")];
    expect(pickTrackRow(rows, puppets, { rowsCarryArtist: true })).toBeUndefined();
  });

  it("skips header rows", () => {
    const rows: BrowseItem[] = [
      { title: "Tracks", hint: "header" },
      row("Puppets", "Atmosphere"),
    ];
    const pick = pickTrackRow(rows, puppets, { rowsCarryArtist: true });
    expect(pick?.item.item_key).toBe("key:Puppets");
  });
});
