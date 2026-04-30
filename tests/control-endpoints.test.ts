/**
 * Tests for control HTTP endpoints.
 *
 * Uses vi.mock to stub roonConnection and the config module.
 * Express app is set up without starting a real HTTP server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createControlRouter, createConfigRouter } from "../src/control/control-router.js";
import type { Zone, Output } from "node-roon-api-transport";

// ---------------------------------------------------------------------------
// Mock roon-connection module
// ---------------------------------------------------------------------------

const mockTransport = {
  change_volume: vi.fn((_output: Output, _how: string, _value: number, cb?: (err: false | string) => void) => {
    cb?.(false);
  }),
  mute: vi.fn((_output: Output, _how: "mute" | "unmute", cb?: (err: false | string) => void) => {
    cb?.(false);
  }),
  control: vi.fn((_zone: Zone, _action: string, cb?: (err: false | string) => void) => {
    cb?.(false);
  }),
};

const mockOutput: Output = {
  output_id: "out-1",
  zone_id: "zone-1",
  display_name: "WiiM",
  state: "playing",
  volume: { type: "number", value: 60, min: 0, max: 100, is_muted: false },
};

const mockZone: Zone = {
  zone_id: "zone-1",
  display_name: "WiiM + 1",
  state: "playing",
  outputs: [mockOutput],
  queue_items_remaining: 0,
  queue_time_remaining: 0,
  settings: { shuffle: false, auto_radio: false, loop: "disabled" },
};

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    getTransport: vi.fn(() => mockTransport),
    findZone: vi.fn((name: string) => {
      if (!name || name.toLowerCase().includes("wiim")) return mockZone;
      return null;
    }),
    isConnected: vi.fn(() => true),
    getZones: vi.fn(() => [mockZone]),
  },
}));

// ---------------------------------------------------------------------------
// Mock roon-key-config module
// ---------------------------------------------------------------------------

vi.mock("../src/control/roon-key-config.js", () => ({
  readRoonKeyConfig: vi.fn(() => ({
    active_zone_display_name: "WiiM + 1",
    volume_step: 8,
    ramp_step_ms: 0,
    presets: [32, 40, 48, 56, 64, 72, 80],
    extras: { open_roon_app: true, muse_toggle: false, favorites: [] },
  })),
  writeRoonKeyConfig: vi.fn(),
  validateRoonKeyConfig: vi.fn(() => ({ ok: true })),
  DEFAULT_ROON_KEY_CONFIG: {
    active_zone_display_name: "WiiM + 1",
    volume_step: 8,
    ramp_step_ms: 20,
    presets: [32, 40, 48, 56, 64, 72, 80],
    extras: { open_roon_app: true, muse_toggle: false, favorites: [] },
  },
}));

// ---------------------------------------------------------------------------
// Build test app
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/control", createControlRouter());
  app.use("/config", createConfigRouter());
  return app;
}

// ---------------------------------------------------------------------------
// Helper: inline request without starting a server
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

async function withApp(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = buildApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /control/volume_ramp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport.change_volume.mockImplementation((_o, _h, _v, cb) => cb?.(false));
  });

  it("accepts valid up ramp and returns ok", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_ramp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "up", step: 4 }),
      });
      const json = await res.json() as { ok: boolean };
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
    });
  });

  it("accepts valid down ramp", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_ramp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "down" }),
      });
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    });
  });

  it("returns 400 for invalid direction", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_ramp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "sideways" }),
      });
      const json = await res.json() as { ok: boolean; error: string };
      expect(res.status).toBe(400);
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/direction/);
    });
  });

  it("uses config volume_step when step not provided", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_ramp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "up" }),
      });
      const json = await res.json() as { ok: boolean; step: number };
      expect(json.ok).toBe(true);
      expect(json.step).toBe(8); // config default
    });
  });
});

describe("POST /control/volume_instant", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok for valid up instant", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_instant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "up", step: 5 }),
      });
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    });
  });

  it("returns 400 for missing direction", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_instant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 5 }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /control/volume_preset", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts valid index 1", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_preset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: 1 }),
      });
      const json = await res.json() as { ok: boolean; target: number };
      expect(json.ok).toBe(true);
      expect(json.target).toBe(32); // presets[0]
    });
  });

  it("returns 400 for index 0", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_preset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: 0 }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("returns 400 for out-of-range index", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/volume_preset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: 99 }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /control/mute_toggle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/mute_toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    });
  });
});

describe("POST /control/transport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts playpause", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/transport`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "playpause" }),
      });
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    });
  });

  it("accepts next and prev", async () => {
    await withApp(async (base) => {
      for (const action of ["next", "prev"]) {
        const res = await fetch(`${base}/control/transport`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const json = await res.json() as { ok: boolean };
        expect(json.ok).toBe(true);
      }
    });
  });

  it("returns 400 for unknown action", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/transport`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rewind" }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("GET /control/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok with zone info and config", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/status`);
      const json = await res.json() as {
        ok: boolean;
        roon_connected: boolean;
        zone: { display_name: string } | null;
        config: object;
      };
      expect(json.ok).toBe(true);
      expect(json.roon_connected).toBe(true);
      expect(json.zone?.display_name).toBe("WiiM + 1");
      expect(json.config).toBeTruthy();
    });
  });
});

describe("GET /config/roon-key", () => {
  it("returns persisted config", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/config/roon-key`);
      const json = await res.json() as { ok: boolean; config: object };
      expect(json.ok).toBe(true);
      expect(json.config).toBeTruthy();
    });
  });
});

describe("POST /config/roon-key", () => {
  it("validates and returns ok for valid body", async () => {
    await withApp(async (base) => {
      const cfg = {
        active_zone_display_name: "WiiM + 1",
        volume_step: 10,
        ramp_step_ms: 30,
        presets: [40, 50, 60],
        extras: { open_roon_app: true, muse_toggle: false, favorites: [] },
      };
      const res = await fetch(`${base}/config/roon-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    });
  });

  it("returns 400 for invalid body", async () => {
    // Force validateRoonKeyConfig to return a failure for this test
    const { validateRoonKeyConfig } = await import("../src/control/roon-key-config.js");
    vi.mocked(validateRoonKeyConfig).mockReturnValueOnce({ ok: false, error: "test error" });

    await withApp(async (base) => {
      const res = await fetch(`${base}/config/roon-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bad: true }),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(false);
    });
  });
});

describe("Stub endpoints", () => {
  it("POST /control/muse_toggle returns not_implemented", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/muse_toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe("not_implemented");
    });
  });

  it("POST /control/play_favorite returns not_implemented", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/control/play_favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe("not_implemented");
    });
  });
});
