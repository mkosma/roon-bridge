/**
 * Tests for the newly-surfaced transport commands: transfer_zone, group_zones,
 * ungroup_zone. The mock models the zone map and applies the native effect so
 * the verify-by-reread path is exercised. (Live audio-topology verification is
 * Maya's; these prove the command + verify logic.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Zone, Output } from "node-roon-api-transport";

function output(id: string): Output {
  return { output_id: id, zone_id: "", display_name: id, state: "stopped" };
}

const world: { zones: Zone[] } = { zones: [] };

function zone(id: string, name: string, outIds: string[], nowPlaying?: string): Zone {
  return {
    zone_id: id,
    display_name: name,
    outputs: outIds.map(output),
    state: nowPlaying ? "playing" : "stopped",
    is_previous_allowed: true,
    is_next_allowed: true,
    is_pause_allowed: true,
    is_play_allowed: true,
    is_seek_allowed: true,
    now_playing: nowPlaying
      ? { one_line: { line1: nowPlaying }, two_line: { line1: nowPlaying }, three_line: { line1: nowPlaying } }
      : undefined,
  };
}

function reset() {
  world.zones = [
    zone("z-wiim", "WiiM", ["o-wiim"], "Puppets"),
    zone("z-muse", "Muse", ["o-muse"]),
  ];
}

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getTransport: vi.fn(() => ({})),
    getZones: vi.fn(() => world.zones),
    findZone: vi.fn((id: string) => world.zones.find((z) => z.zone_id === id) ?? null),
    findZoneOrThrow: vi.fn((nameOrId: string) => {
      const z = world.zones.find((x) => x.zone_id === nameOrId || x.display_name.toLowerCase() === nameOrId.toLowerCase());
      if (!z) throw new Error(`Zone '${nameOrId}' not found`);
      return z;
    }),
    transferZone: vi.fn(async (from: Zone, to: Zone) => {
      // Move now_playing to destination.
      to.now_playing = from.now_playing;
      to.state = "playing";
      from.now_playing = undefined;
      from.state = "stopped";
    }),
    groupOutputs: vi.fn(async (outputs: Output[]) => {
      // Collapse all given outputs into the first output's zone.
      const ids = new Set(outputs.map((o) => o.output_id));
      const host = world.zones.find((z) => z.outputs.some((o) => ids.has(o.output_id)))!;
      host.outputs = outputs.map((o) => ({ ...o }));
      world.zones = world.zones.filter((z) => z === host || !z.outputs.some((o) => ids.has(o.output_id)));
    }),
    ungroupOutputs: vi.fn(async (outputs: Output[]) => {
      // Split: each output becomes its own zone again.
      const ids = new Set(outputs.map((o) => o.output_id));
      world.zones = world.zones.filter((z) => !z.outputs.every((o) => ids.has(o.output_id)) || z.outputs.length < 2);
      for (const o of outputs) {
        if (!world.zones.some((z) => z.outputs.some((x) => x.output_id === o.output_id))) {
          world.zones.push(zone(`z-${o.output_id}`, o.output_id, [o.output_id]));
        }
      }
    }),
  },
}));

const { registerTopologyTools } = await import("../src/tools/topology.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerTopologyTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const res = await tool.handler(args, {});
  const text = res.content.map((c: { text: string }) => c.text).join("\n");
  return { isError: res.isError === true, json: JSON.parse(text) };
}

describe("transfer_zone", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("moves now-playing to the destination and verifies it", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "transfer_zone", { from_zone: "WiiM", to_zone: "Muse" });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.moved).toBe("Puppets");
    expect(json.verified).toBe(true);
  });

  it("refuses transferring a zone to itself", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "transfer_zone", { from_zone: "WiiM", to_zone: "WiiM" });
    expect(isError).toBe(true);
    expect(json.error).toBe("same_zone");
  });
});

describe("group_zones / ungroup_zone", () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it("groups two zones into one combined zone and verifies", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "group_zones", { zones: ["WiiM", "Muse"] });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    // The combined zone holds both outputs.
    const combined = world.zones.find((z) => z.outputs.length === 2);
    expect(combined).toBeTruthy();
  });

  it("ungroups a combined zone back to independent outputs", async () => {
    const server = buildServer();
    await call(server, "group_zones", { zones: ["WiiM", "Muse"] });
    const combined = world.zones.find((z) => z.outputs.length === 2)!;
    const { json } = await call(server, "ungroup_zone", { zone: combined.zone_id });
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
  });

  it("refuses to ungroup a single-output zone", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "ungroup_zone", { zone: "Muse" });
    expect(isError).toBe(true);
    expect(json.error).toBe("not_grouped");
  });
});
