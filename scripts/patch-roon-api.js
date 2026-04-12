/**
 * Postinstall patch for node-roon-api.
 *
 * The ws library is an EventEmitter that emits 'error' events, but
 * node-roon-api only sets DOM-style .onerror handlers on the WebSocket.
 * This leaves EventEmitter 'error' events unhandled, which crashes Node.js.
 *
 * This script adds a proper .on('error', ...) listener to transport-websocket.js.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = join(__dirname, "..", "node_modules", "node-roon-api", "transport-websocket.js");

const PATCH_MARKER = "// [roon-mcp-patch] EventEmitter error handler";

try {
  let content = readFileSync(filePath, "utf8");

  if (content.includes(PATCH_MARKER)) {
    console.error("[patch] node-roon-api already patched, skipping.");
    process.exit(0);
  }

  // Add .on('error', ...) right after the existing .on('pong', ...) line
  const target = "this.ws.on('pong', () => this.is_alive = true);";
  const replacement = `this.ws.on('pong', () => this.is_alive = true);
    ${PATCH_MARKER}
    this.ws.on('error', (err) => { if (this.onerror) this.onerror(err); });`;

  if (!content.includes(target)) {
    console.error("[patch] Could not find target line in transport-websocket.js. Skipping patch.");
    process.exit(0);
  }

  content = content.replace(target, replacement);
  writeFileSync(filePath, content, "utf8");
  console.error("[patch] Patched node-roon-api transport-websocket.js: added EventEmitter error handler.");
} catch (e) {
  console.error("[patch] Failed to patch node-roon-api:", e.message);
  // Non-fatal: the process.on('uncaughtException') handler in index.ts is a fallback
}
