/**
 * Drives every registered tool through a real MCP Streamable HTTP transport
 * round trip (see tests/helpers/live-server.ts), auto-generating the fuzz
 * cases from the tool registry's own wire schema (tools/list) rather than
 * hand-listing tools or params. This is the layer that would have caught the
 * 2026-07-05 class of bug: a client sending a stringified scalar ("true"
 * instead of true) that a plain z.boolean() rejects with -32602 before the
 * handler ever runs. The existing 300+ test suite calls handlers directly
 * with already-typed args and never exercises this serialization gap.
 *
 * roon-bridge's roonConnection singleton is never connected in this process
 * (createMcpServer() does not call roonConnection.connect() - only
 * server.ts's main() does), so every tool handler that touches Roon throws
 * "Not connected to Roon" synchronously. That is a normal, expected
 * business-logic failure (isError: true, no validation-error text) - safe to
 * exercise here, and distinct from the schema validation failures this file
 * actually asserts on.
 */

import { afterAll, describe, expect, it } from "vitest";
import { startLiveServer } from "./helpers/live-server.js";
import {
  isBooleanLike,
  isSchemaValidationFailure,
  sampleValue,
  stringifiedVariant,
  type JsonSchemaLike,
} from "./helpers/schema-fuzz.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Dynamic per-tool suites (describe.each) must be built at collection time,
// which runs before any beforeAll hook - so the tool list is fetched with a
// real top-level await instead.
const live = await startLiveServer();
const tools: Tool[] = (await live.client.listTools()).tools;

afterAll(async () => {
  await live.close();
});

function buildValidArgs(tool: Tool): Record<string, unknown> {
  const props = (tool.inputSchema as JsonSchemaLike).properties ?? {};
  return Object.fromEntries(Object.entries(props).map(([name, schema]) => [name, sampleValue(schema)]));
}

describe("transport-realism: every registered tool, over a real HTTP round trip", () => {
  it("registers at least the known baseline of tools", () => {
    // A floor, not a ceiling - guards against the tool list silently
    // collapsing (e.g. a registration throwing during server construction)
    // without hard-coding an exact count that would need updating per tool.
    expect(tools.length).toBeGreaterThanOrEqual(40);
  });

  describe.each(tools.map((t) => [t.name, t] as const))("%s", (_name, tool) => {
    const schema = tool.inputSchema as JsonSchemaLike;
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const paramNames = Object.keys(props);

    it("accepts a fully-populated, correctly-typed argument set", async () => {
      const args = buildValidArgs(tool);
      const result = await live.client.callTool({ name: tool.name, arguments: args });
      expect(isSchemaValidationFailure(result as never)).toBe(false);
    });

    if (paramNames.length === 0) {
      it.skip("has no params to fuzz", () => {});
    }

    for (const paramName of paramNames) {
      const paramSchema = props[paramName];
      const validArgs = buildValidArgs(tool);
      const variant = stringifiedVariant(paramSchema, validArgs[paramName]);

      if (variant !== undefined) {
        const label = isBooleanLike(paramSchema) ? "boolean" : "numeric";
        it(`${paramName}: stringified ${label} form (${JSON.stringify(variant)})`, async () => {
          const args = { ...validArgs, [paramName]: variant };
          const result = await live.client.callTool({ name: tool.name, arguments: args });
          if (isBooleanLike(paramSchema)) {
            // Post-prompts/01 policy: every boolean param must accept its
            // stringified form. A validation failure here is exactly the
            // 2026-07-05 bug class.
            expect(isSchemaValidationFailure(result as never)).toBe(false);
          } else {
            // Non-boolean scalars may legitimately reject a stringified
            // value (no z.coerce configured) - the only requirement is that
            // the transport round trip itself completes cleanly rather than
            // hanging or throwing an unhandled protocol error.
            expect(result).toHaveProperty("content");
          }
        });
      }

      it(`${paramName}: omitted`, async () => {
        const args = { ...validArgs };
        delete args[paramName];
        const result = await live.client.callTool({ name: tool.name, arguments: args });
        if (required.has(paramName)) {
          expect(isSchemaValidationFailure(result as never)).toBe(true);
        } else {
          expect(isSchemaValidationFailure(result as never)).toBe(false);
        }
      });
    }
  });
});
