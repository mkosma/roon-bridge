/**
 * Unit tests for pickAlbumRow, the deterministic album-row selection backing
 * play_album_by_id / queue_album_by_id (prompts/03, item 2). No bestMatch
 * fuzzy top-1 fallback: an exact title miss or an unresolved tie fails
 * honestly rather than guessing a wrong release.
 */

import { describe, it, expect } from "vitest";
import { pickAlbumRow, type BrowseItem, type AlbumIdentity } from "../src/tools/search-core.js";

function row(title: string, subtitle?: string, key = title): BrowseItem {
  return { title, subtitle, item_key: `key:${key}`, hint: "list" };
}

describe("pickAlbumRow", () => {
  const trouble: AlbumIdentity = { title: "Trouble Will Find Me", artist: "The National", year: 2013 };

  it("picks the single exact title+artist match", () => {
    const rows = [
      row("High Violet", "The National"),
      row("Trouble Will Find Me", "The National"),
    ];
    const pick = pickAlbumRow(rows, trouble);
    expect(pick?.item.item_key).toBe("key:Trouble Will Find Me");
    expect(pick?.unambiguous).toBe(true);
  });

  it("rejects a wrong-artist same-titled album (no fuzzy top-1 substitution)", () => {
    const rows = [
      row("Trouble Will Find Me", "Some Cover Band", "cover"),
      row("Trouble Will Find Me", "The National", "real"),
    ];
    const pick = pickAlbumRow(rows, trouble);
    expect(pick?.item.item_key).toBe("key:real");
    expect(pick?.unambiguous).toBe(true);
  });

  it("returns undefined when no row has the exact title (never falls back to a close-but-wrong title)", () => {
    const rows = [row("High Violet", "The National"), row("Boxer", "The National")];
    expect(pickAlbumRow(rows, trouble)).toBeUndefined();
  });

  it("disambiguates same-titled reissues by year when the subtitle carries it", () => {
    const rows = [
      row("Trouble Will Find Me", "The National · 2013", "orig"),
      row("Trouble Will Find Me", "The National · 2023 Deluxe", "deluxe"),
    ];
    const pick = pickAlbumRow(rows, trouble);
    expect(pick?.item.item_key).toBe("key:orig");
    expect(pick?.unambiguous).toBe(true);
  });

  it("reports an honest tie when artist/year cannot disambiguate", () => {
    const rows = [
      row("Trouble Will Find Me", "The National", "a"),
      row("Trouble Will Find Me", "The National", "b"),
    ];
    const pick = pickAlbumRow(rows, trouble);
    expect(pick?.unambiguous).toBe(false);
    expect(pick?.tiedCount).toBe(2);
  });
});
