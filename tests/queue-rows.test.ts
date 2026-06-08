/**
 * Unit tests for queue row mapping (Maya spec P0-A: stable item ids + metadata).
 */

import { describe, it, expect } from "vitest";
import { toQueueRow } from "../src/tools/queue.js";
import type { QueueItem } from "node-roon-api-transport";

function qi(id: number, title: string, artist?: string, album?: string, length?: number): QueueItem {
  return {
    queue_item_id: id,
    length,
    one_line: { line1: title },
    two_line: { line1: title, line2: artist },
    three_line: { line1: title, line2: artist, line3: album },
  };
}

describe("toQueueRow", () => {
  it("carries the stable queue_item_id and structured metadata", () => {
    const row = toQueueRow(qi(42, "Karoo", "Larse", "DJ-Kicks", 251), 0, null);
    expect(row.queue_item_id).toBe(42);
    expect(row.position).toBe(1);
    expect(row.title).toBe("Karoo");
    expect(row.artist).toBe("Larse");
    expect(row.album).toBe("DJ-Kicks");
    expect(row.length_seconds).toBe(251);
    expect(row.length).toBe("4:11");
    expect(row.is_now_playing).toBe(false);
  });

  it("flags the now-playing item by id", () => {
    const row = toQueueRow(qi(7, "Track", "Artist"), 0, 7);
    expect(row.is_now_playing).toBe(true);
  });

  it("strips Roon link markup from artist", () => {
    const row = toQueueRow(qi(1, "T", "[[99|Maya Jane Coles]]", "[[8|Comfort]]"), 0, null);
    expect(row.artist).toBe("Maya Jane Coles");
    expect(row.album).toBe("Comfort");
  });

  it("handles missing length and missing metadata gracefully", () => {
    const row = toQueueRow(qi(3, "Solo"), 2, null);
    expect(row.position).toBe(3);
    expect(row.length).toBeNull();
    expect(row.length_seconds).toBeNull();
    expect(row.artist).toBeNull();
    expect(row.album).toBeNull();
  });
});
