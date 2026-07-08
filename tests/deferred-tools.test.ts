/**
 * deferred_status / cancel_deferred tool tests. These drive the real registered
 * MCP tools against the shared singleton DeferredPlayer + ledger, with a mocked
 * roon-connection (no live zone).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import type { Zone } from "node-roon-api-transport";
import type { SeamOutcome } from "../src/control/deferred-player.js";

function playingZone(): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state: "playing",
    outputs: [],
    now_playing: {
      one_line: { line1: "Current" },
      two_line: { line1: "Current", line2: "Artist" },
      three_line: { line1: "Current", line2: "Artist" },
      length: 200,
      seek_position: 5,
    },
  } as unknown as Zone;
}

class MockConnection extends EventEmitter {
  zone: Zone = playingZone();
  findZone() {
    return this.zone;
  }
  getZones() {
    return [this.zone];
  }
  getDefaultZone() {
    return "WiiM + 1";
  }
  isConnected() {
    return true;
  }
}
const mockConn = new MockConnection();
vi.mock("../src/roon-connection.js", () => ({ roonConnection: mockConn }));

const { registerDeferredTools } = await import("../src/tools/deferred.js");
const { deferredPlayer } = await import("../src/control/deferred-player-instance.js");
const { deferralLedger } = await import("../src/control/deferral-ledger.js");

function buildServer() {
  const server = new McpServer({ name: "t", version: "0" });
  registerDeferredTools(server);
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

const okAction = async (): Promise<SeamOutcome> => ({ ok: true, verified: true });

describe("deferred_status / cancel_deferred tools", () => {
  beforeEach(() => {
    deferralLedger.reset();
    deferredPlayer.cancel(); // clear any armed deferral from a prior test
    deferralLedger.reset();
  });

  it("deferred_status lists a currently-armed deferral", async () => {
    const server = buildServer();
    const { deferral_id } = await deferredPlayer.scheduleAfterCurrent(mockConn.zone, okAction, {
      zoneId: "zone-1",
      zoneName: "WiiM + 1",
      trigger: 'end of "Current"',
      description: "replace queue with 3 track(s)",
    });

    const { json } = await call(server, "deferred_status", {});
    expect(json.ok).toBe(true);
    expect(json.armed_id).toBe(deferral_id);
    expect(json.pending_count).toBe(1);
    expect(json.pending[0].deferral_id).toBe(deferral_id);
    expect(json.recent[0].description).toContain("replace queue");
  });

  it("cancel_deferred cancels the armed deferral and records aborted(canceled)", async () => {
    const server = buildServer();
    const { deferral_id } = await deferredPlayer.scheduleAfterCurrent(mockConn.zone, okAction, {
      zoneId: "zone-1",
      zoneName: "WiiM + 1",
      trigger: 'end of "Current"',
      description: "jump to Track 7",
    });
    expect(deferredPlayer.isArmed()).toBe(true);

    const { isError, json } = await call(server, "cancel_deferred", { deferral_id });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.canceled).toBe(deferral_id);
    expect(json.record.status).toBe("aborted");
    expect(json.record.reason).toBe("canceled");
    expect(deferredPlayer.isArmed()).toBe(false);
  });

  it("cancel_deferred on an unknown id returns ok:false unknown_deferral", async () => {
    const server = buildServer();
    const { isError, json } = await call(server, "cancel_deferred", { deferral_id: "d-nope-1" });
    expect(isError).toBe(true);
    expect(json.error).toBe("unknown_deferral");
  });

  it("cancel_deferred on an already-settled deferral returns ok:false not_cancelable", async () => {
    const server = buildServer();
    // Seed a settled (fired) record with no live arming.
    const id = deferralLedger.arm({ zoneId: "zone-1", zoneName: "WiiM + 1", trigger: "t", description: "d" });
    deferralLedger.settle(id, "fired_verified");

    const { isError, json } = await call(server, "cancel_deferred", { deferral_id: id });
    expect(isError).toBe(true);
    expect(json.error).toBe("not_cancelable");
    expect(json.record.status).toBe("fired_verified");
  });
});
