#!/usr/bin/env node

/**
 * roon-bridge — Persistent HTTP-based MCP server for Roon.
 *
 * Maintains a single WebSocket connection to Roon Core and exposes
 * MCP tools over Streamable HTTP transport. Multiple Claude sessions
 * (Dispatch, Cowork, Claude Code, etc.) can connect simultaneously
 * without causing duplicate Roon extension registrations.
 *
 * Also supports legacy stdio transport via --stdio flag for direct
 * Claude Desktop / Claude Code integration when running locally.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { roonConnection } from "./roon-connection.js";
import { registerZoneTools } from "./tools/zone.js";
import { registerPlaybackTools } from "./tools/playback.js";
import { registerVolumeTools } from "./tools/volume.js";
import { registerBrowseTools } from "./tools/browse.js";
import { createControlRouter, createConfigRouter } from "./control/control-router.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { Bonjour } from "bonjour-service";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const _pkgPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json");
let _pkgVersion = "1.0.0";
try {
  const pkg = JSON.parse(readFileSync(_pkgPath, { encoding: "utf8" })) as { version?: string };
  _pkgVersion = pkg.version ?? "1.0.0";
} catch {
  // ignore
}

// Prevent process crashes from unhandled errors in node-roon-api's WebSocket
process.on("uncaughtException", (error) => {
  console.error("[roon-bridge] Uncaught exception (kept alive):", error.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[roon-bridge] Unhandled rejection (kept alive):", reason);
});

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "3100", 10);
const BRIDGE_HOST = process.env.BRIDGE_HOST || "0.0.0.0";
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;
const USE_STDIO = process.argv.includes("--stdio");

/**
 * Create and configure a fresh MCP server instance.
 * Each HTTP session gets its own McpServer so that browse state,
 * session counters, etc. are isolated between clients.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "roon-bridge",
    version: "1.0.0",
  });

  registerZoneTools(server);
  registerPlaybackTools(server);
  registerVolumeTools(server);
  registerBrowseTools(server);

  return server;
}

/** Bearer token auth middleware */
function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!AUTH_TOKEN) {
    // No token configured — allow all (local-only use)
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

type Control = "play" | "pause" | "playpause" | "stop" | "next" | "previous";
const CONTROL_ALIASES: Record<string, Control> = {
  play: "play",
  pause: "pause",
  play_pause: "playpause",
  playpause: "playpause",
  toggle: "playpause",
  stop: "stop",
  next: "next",
  next_track: "next",
  previous: "previous",
  prev: "previous",
  previous_track: "previous",
};

function runControl(action: Control, zoneName: string): Promise<{ ok: true; zone: string; state: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      const transport = roonConnection.getTransport();
      const zone = roonConnection.findZoneOrThrow(zoneName);
      transport.control(zone, action, (error) => {
        if (error) {
          resolve({ ok: false, error: String(error) });
        } else {
          resolve({ ok: true, zone: zone.display_name, state: action });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

async function startHttpServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Short-lived authorization codes: code → { codeChallenge, codeChallengeMethod }
  const pendingCodes = new Map<string, { codeChallenge?: string; codeChallengeMethod?: string }>();

  // OAuth 2.1 / MCP auth endpoints — minimal implementation for a single-user local server.
  // Claude Code (and other MCP clients) attempt OAuth when they see a 401. Since this is a
  // trusted LAN-only service we auto-approve and hand back the static bearer token.

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const base = `${req.protocol}://${req.headers.host}`;
    res.json({ resource: base, authorization_servers: [base] });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = `${req.protocol}://${req.headers.host}`;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  // Dynamic client registration — accept any client, no secrets required
  app.post("/register", (req, res) => {
    res.status(201).json({
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: (req.body as { redirect_uris?: string[] })?.redirect_uris ?? [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // Authorization — auto-approve and redirect immediately with a one-time code
  app.get("/authorize", (req, res) => {
    const { redirect_uri, state, code_challenge, code_challenge_method } = req.query as Record<string, string>;
    if (!redirect_uri) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing redirect_uri" });
      return;
    }
    const code = randomUUID();
    pendingCodes.set(code, { codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method });
    // Expire codes after 5 minutes
    setTimeout(() => pendingCodes.delete(code), 5 * 60 * 1000);
    const dest = new URL(redirect_uri);
    dest.searchParams.set("code", code);
    if (state) dest.searchParams.set("state", state);
    res.redirect(dest.toString());
  });

  // Token exchange — return the static bearer token (or generate one if unconfigured)
  app.post("/token", (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    if (!body.code || !pendingCodes.has(body.code)) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    pendingCodes.delete(body.code);
    res.json({
      access_token: AUTH_TOKEN ?? randomUUID(),
      token_type: "bearer",
      expires_in: 365 * 24 * 3600,
    });
  });

  // Auth on protected endpoints
  app.use("/mcp", authMiddleware);
  app.use("/control", authMiddleware);
  app.use("/config", authMiddleware);

  // Health check (no auth required)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      roon_connected: roonConnection.isConnected(),
      zones: roonConnection.getZones().map((z) => ({
        name: z.display_name,
        state: z.state,
      })),
    });
  });

  // roon-key control endpoints (POST /control/volume_ramp, etc.)
  app.use("/control", createControlRouter());

  // roon-key config endpoints (GET/POST /config/roon-key)
  app.use("/config", createConfigRouter());

  // Legacy REST control endpoints for iOS Shortcuts and similar clients.
  // GET or POST both work so the iOS "Get Contents of URL" action can call
  // them without configuring a body. The default zone is used unless
  // ?zone=Name is supplied.
  // Note: this catch-all is registered AFTER the specific roon-key routes
  // so /control/volume_ramp etc. are handled first.
  app.all("/control/:action", async (req, res) => {
    const raw = String(req.params.action || "").toLowerCase();
    const action = CONTROL_ALIASES[raw];
    if (!action) {
      res.status(404).json({
        ok: false,
        error: `Unknown action '${raw}'. Valid: ${Object.keys(CONTROL_ALIASES).join(", ")}`,
      });
      return;
    }
    const zoneParam = (req.query.zone as string | undefined) ?? "";
    const result = await runControl(action, zoneParam);
    res.status(result.ok ? 200 : 500).json(result);
  });

  // Map of session ID → { transport, server } for session resumption
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  // Handle MCP requests (POST for tool calls, GET for SSE stream, DELETE for session end)
  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // If we have an existing session, route to it
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      return;
    }

    // For GET/DELETE without a valid session, reject
    if (req.method === "GET" || req.method === "DELETE") {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    // New session — create transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        console.error(`[roon-bridge] New MCP session: ${id}`);
      },
    });

    // Clean up on close
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        console.error(`[roon-bridge] Session closed: ${sid}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  const httpServer = app.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.error(`[roon-bridge] HTTP MCP server listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}/mcp`);
    if (AUTH_TOKEN) {
      console.error(`[roon-bridge] Auth: Bearer token required`);
    } else {
      console.error(`[roon-bridge] Auth: NONE (set BRIDGE_AUTH_TOKEN for production)`);
    }

    // Advertise _roon-bridge._tcp.local for roon-key discovery
    try {
      const bonjour = new Bonjour();
      // publish() starts advertisement immediately
      bonjour.publish({
        name: "roon-bridge",
        type: "roon-bridge",
        port: BRIDGE_PORT,
        txt: { version: _pkgVersion },
      });
      console.error(`[roon-bridge] mDNS: advertising _roon-bridge._tcp.local on port ${BRIDGE_PORT}`);

      // Deregister on process exit
      const shutdown = () => {
        bonjour.unpublishAll(() => {
          bonjour.destroy();
          httpServer.close();
          process.exit(0);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (e) {
      console.error(`[roon-bridge] mDNS advertisement failed (non-fatal):`, e);
    }
  });
}

async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[roon-bridge] MCP server running on stdio");
}

async function main(): Promise<void> {
  // Start Roon connection (runs in background with auto-reconnect)
  roonConnection.connect();

  if (USE_STDIO) {
    await startStdioServer();
  } else {
    await startHttpServer();
  }
}

main().catch((error) => {
  console.error("[roon-bridge] Fatal error:", error);
  process.exit(1);
});
