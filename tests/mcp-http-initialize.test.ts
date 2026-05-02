/**
 * Regression test for the MCP /mcp body-parsing bug.
 *
 * Symptom: POST /mcp returned HTTP 400 -32700 "Parse error: Invalid JSON"
 * for every request, including a well-formed initialize.
 *
 * Cause: app.use(express.json()) consumed the request stream, then
 * transport.handleRequest(req, res) was called without the parsed body,
 * so the SDK's StreamableHTTPServerTransport tried to re-read an empty
 * stream and threw.
 *
 * Fix: pass req.body as the third argument to handleRequest().
 *
 * This test wires up the same middleware order and asserts that an
 * initialize request returns a session ID and a JSON-RPC result, not
 * the parse error.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

vi.mock("../src/roon-connection.js", () => ({
  roonConnection: {
    isConnected: () => false,
    getZones: () => [],
    getTransport: () => {
      throw new Error("not connected");
    },
    findZone: () => null,
    findZoneOrThrow: () => {
      throw new Error("not connected");
    },
  },
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

describe("POST /mcp body parsing", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = buildApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no addr");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("initialize succeeds when express.json() has already parsed the body", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "regression-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();

    const text = await response.text();
    // Response may be SSE-framed or plain JSON depending on Accept negotiation
    expect(text).not.toMatch(/Parse error/);
    expect(text).toMatch(/"result"/);
    expect(text).toMatch(/"protocolVersion"/);
  });
});
