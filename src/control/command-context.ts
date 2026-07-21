/**
 * command-context: propagates the caller-declared command source (Maya's
 * MCP session, the Telegram bot, a future skill, etc.) from the incoming HTTP
 * request down into whichever tool handler ends up mutating a zone, without
 * threading an extra parameter through every function in the call graph.
 *
 * Why AsyncLocalStorage: MCP tool handlers do not receive the raw
 * express.Request - the SDK's StreamableHTTPServerTransport owns dispatch
 * once server.connect(transport) is wired up (see server.ts). The one place
 * that DOES see the request is the /mcp route handler, which awaits
 * `transport.handleRequest(req, res, req.body)`. Node's AsyncLocalStorage
 * context survives across that whole await chain (it is not lost across
 * Promise continuations the way a plain module-level variable would be
 * clobbered by a concurrent request), so wrapping that one call in
 * `runWithCommandSource` is enough to make `currentCommandSource()` return
 * the right value anywhere further down the stack, including inside
 * concurrently in-flight requests on other sessions.
 *
 * Source is provenance only, never authorization - see last-command.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CommandContext {
  source: string;
}

/** This bridge's only MCP client today is Maya's session - the safe default
 * when no X-Command-Source header is present. */
export const DEFAULT_COMMAND_SOURCE = "maya";

/** [a-z0-9_-]{1,32} per spec - short, filesystem/log-safe, no injection surface. */
const SOURCE_PATTERN = /^[a-z0-9_-]{1,32}$/;

const storage = new AsyncLocalStorage<CommandContext>();

/**
 * Validate and normalize a raw X-Command-Source header value. Anything
 * missing, non-string, or not matching the allowed charset/length falls back
 * to the default rather than being rejected - this is provenance metadata,
 * not a value the request can be blocked on.
 */
export function sanitizeSource(raw: string | string[] | undefined): string {
  if (typeof raw !== "string") return DEFAULT_COMMAND_SOURCE;
  const trimmed = raw.trim().toLowerCase();
  return SOURCE_PATTERN.test(trimmed) ? trimmed : DEFAULT_COMMAND_SOURCE;
}

/** Run `fn` (sync or async) with `source` bound as the ambient command source. */
export function runWithCommandSource<T>(source: string, fn: () => T): T {
  return storage.run({ source }, fn);
}

/** The command source for whatever request is currently being handled, or
 * the default if called outside any request (e.g. a test, a background
 * task with no HTTP origin). */
export function currentCommandSource(): string {
  return storage.getStore()?.source ?? DEFAULT_COMMAND_SOURCE;
}
