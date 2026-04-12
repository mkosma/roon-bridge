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
import express from "express";
import { randomUUID } from "node:crypto";

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

async function startHttpServer(): Promise<void> {
  const app = express();

  // Auth on the MCP endpoint
  app.use("/mcp", authMiddleware);

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

  app.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.error(`[roon-bridge] HTTP MCP server listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}/mcp`);
    if (AUTH_TOKEN) {
      console.error(`[roon-bridge] Auth: Bearer token required`);
    } else {
      console.error(`[roon-bridge] Auth: NONE (set BRIDGE_AUTH_TOKEN for production)`);
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
