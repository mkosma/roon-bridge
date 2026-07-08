/**
 * Unit tests for RoonConnection's zone resolution (prompts/03, item 1): exact
 * match, else a unique substring match; more than one candidate at either
 * stage is reported as ambiguous rather than picked by map-iteration order.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RoonConnection } from "../src/roon-connection.js";
import type { Zone } from "node-roon-api-transport";

function fakeZone(id: string, name: string): Zone {
  return {
    zone_id: id,
    display_name: name,
    outputs: [],
    state: "stopped",
    is_previous_allowed: true,
    is_next_allowed: true,
    is_pause_allowed: true,
    is_play_allowed: true,
    is_seek_allowed: true,
  };
}

let conn: RoonConnection;

beforeEach(() => {
  conn = new RoonConnection();
  const zones = new Map<string, Zone>();
  zones.set("z-1", fakeZone("z-1", "WiiM + 1"));
  zones.set("z-2", fakeZone("z-2", "WiiM Ultra"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (conn as any).zones = zones;
});

describe("resolveZone / findZone", () => {
  it("resolves an exact display-name match", () => {
    expect(conn.findZone("WiiM + 1")?.zone_id).toBe("z-1");
    expect(conn.findZone("wiim ultra")?.zone_id).toBe("z-2");
  });

  it("resolves a unique substring/prefix match", () => {
    expect(conn.findZone("wiim u")?.zone_id).toBe("z-2");
  });

  it("resolves by exact zone_id", () => {
    expect(conn.findZone("z-1")?.zone_id).toBe("z-1");
  });

  it("returns null (ambiguous or not found) rather than iteration-order-picking a multi-match substring", () => {
    // "WiiM" is a substring of both zones and an exact match of neither.
    expect(conn.findZone("WiiM")).toBeNull();
    const resolution = conn.resolveZone("WiiM");
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates.map((z) => z.display_name).sort()).toEqual(["WiiM + 1", "WiiM Ultra"]);
    }
  });

  it("returns not_found for no match", () => {
    expect(conn.findZone("Sonos")).toBeNull();
    expect(conn.resolveZone("Sonos").kind).toBe("not_found");
  });
});

describe("findZoneOrThrow", () => {
  it("throws listing candidates when ambiguous", () => {
    expect(() => conn.findZoneOrThrow("WiiM")).toThrow(/ambiguous.*WiiM \+ 1.*WiiM Ultra|ambiguous.*WiiM Ultra.*WiiM \+ 1/s);
  });

  it("resolves an exact zone", () => {
    expect(conn.findZoneOrThrow("WiiM + 1").zone_id).toBe("z-1");
  });

  it("resolves a unique prefix", () => {
    expect(conn.findZoneOrThrow("wiim u").zone_id).toBe("z-2");
  });

  it("throws not-found for no match", () => {
    expect(() => conn.findZoneOrThrow("Sonos")).toThrow(/not found/);
  });
});
