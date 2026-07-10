/**
 * Spins up a real HTTP server hosting the actual MCP Streamable HTTP
 * transport (the same session-per-connection pattern server.ts uses), so
 * tests can drive tool calls through a genuine JSON-RPC-over-HTTP round trip
 * instead of calling a tool's handler function directly with already-typed
 * JS arguments. That direct-call pattern is what let stringified-boolean
 * bugs slip through the 300+ test suite before: the client SDK/zod parsing
 * step never ran.
 *
 * Stateless mode (sessionIdGenerator: undefined) only supports one request
 * per transport instance ("each request must use a fresh transport" per the
 * SDK's own doc comment), which breaks a Client that issues an initialize
 * call followed by an initialized notification and then tool calls. So this
 * mirrors server.ts's real stateful session flow instead: one session ID,
 * created on the initialize request, routed to the same transport for every
 * subsequent request on that session - exactly what a real MCP client does
 * against the live bridge.
 */

import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/mcp-server-factory.js";

export interface LiveServer {
  client: Client;
  port: number;
  close(): Promise<void>;
}

export async function startLiveServer(): Promise<LiveServer> {
  const app = express();
  app.use(express.json());

  const mcpServer = createMcpServer();
  let transport: StreamableHTTPServerTransport | undefined;

  app.all("/mcp", async (req, res) => {
    try {
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await mcpServer.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[live-server] /mcp error:", e);
      if (!res.headersSent) res.status(500).json({ error: String(e) });
    }
  });

  const httpServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an AddressInfo from an ephemeral-port listener");
  }
  const port = address.port;

  const client = new Client({ name: "transport-realism-test", version: "0.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(clientTransport);

  return {
    client,
    port,
    async close() {
      await client.close();
      await transport?.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
