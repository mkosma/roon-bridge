/**
 * Unit tests for the Qobuz track-metadata derivation helpers (queue-by-id
 * enrichment). Pure functions; the field shapes mirror live track/get and
 * catalog/search responses captured during the build investigation.
 */

import { describe, it, expect } from "vitest";
import { inferInstrumental, yearFromReleaseDate } from "../src/providers/qobuz/index.js";

describe("inferInstrumental", () => {
  it("fires on explicit instrumental markers", () => {
    expect(inferInstrumental("Song (Instrumental)")).toBe(true);
    expect(inferInstrumental("Song [Instrumental Version]")).toBe(true);
    expect(inferInstrumental("Song - Instrumental")).toBe(true);
    expect(inferInstrumental("Song", "Instrumental")).toBe(true);
  });
  it("does NOT fire on a bare word inside a title", () => {
    expect(inferInstrumental("Instrumental Madness")).toBe(false);
    expect(inferInstrumental("Puppets")).toBe(false);
  });
});

describe("yearFromReleaseDate", () => {
  it("extracts the 4-digit year", () => {
    expect(yearFromReleaseDate("2008-04-22")).toBe(2008);
    expect(yearFromReleaseDate("1986-03-01")).toBe(1986);
  });
  it("returns undefined for missing/garbage", () => {
    expect(yearFromReleaseDate(undefined)).toBeUndefined();
    expect(yearFromReleaseDate("")).toBeUndefined();
    expect(yearFromReleaseDate("n/a")).toBeUndefined();
  });
});
