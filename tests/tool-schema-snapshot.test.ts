/**
 * Enum-drift guard: snapshots every registered tool's name, required params,
 * param types, and enum values (no free-text descriptions, which change
 * often and aren't the drift this guards against). Changing a public enum
 * (e.g. the PR#9 removal of `when: "now"`) or renaming/retyping a param
 * fails this snapshot, forcing the change to be deliberate.
 *
 * To update after a deliberate, reviewed schema change:
 *   npx vitest run tests/tool-schema-snapshot.test.ts -u
 * and add an entry to CHANGELOG.md describing what changed and why - the
 * tool-reference generator (see agents/Maya/code/gen-tool-reference.py)
 * surfaces recent entries so Maya knows her tool surface moved.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveServer, type LiveServer } from "./helpers/live-server.js";
import { summarizeToolSchema, type JsonSchemaLike } from "./helpers/schema-fuzz.js";

let live: LiveServer;

beforeAll(async () => {
  live = await startLiveServer();
}, 20000);

afterAll(async () => {
  await live.close();
});

describe("tool schema snapshot (enum-drift guard)", () => {
  it("matches the committed schema summary for every tool", async () => {
    const { tools } = await live.client.listTools();
    const summary = tools
      .map((t) => summarizeToolSchema(t.name, t.inputSchema as JsonSchemaLike))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    await expect(JSON.stringify(summary, null, 2)).toMatchFileSnapshot("./__snapshots__/tool-schema.snapshot.json");
  });
});
