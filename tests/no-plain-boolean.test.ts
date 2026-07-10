/**
 * Lint-style guard for the post-prompts/01 policy: no public tool schema may
 * use a plain z.boolean(). Every boolean param must use boolish() from
 * src/tools/resulting-state.ts, which also accepts the stringified
 * "true"/"false" a scalar-stringifying MCP client sends (the 2026-07-05
 * incident class). This is a static source-text check, independent of the
 * live-transport fuzz test in transport-realism.test.ts, so a boolean
 * violation is caught even if a future refactor changes how tools are
 * registered or served.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dirname, "..", "src", "tools");

// resulting-state.ts defines the sanctioned boolish() primitive itself, so
// it is the one file allowed to reference z.boolean() directly.
const ALLOWED_FILE = "resulting-state.ts";

function listToolFiles(): string[] {
  return globSync("*.ts", { cwd: TOOLS_DIR }).filter((f) => f !== ALLOWED_FILE);
}

describe("no plain z.boolean() in public tool schemas", () => {
  const files = listToolFiles();

  it("found tool files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s has no plain .boolean() calls", (file) => {
    const source = readFileSync(join(TOOLS_DIR, file), "utf8");
    const matches = source.match(/\.boolean\(\)/g) ?? [];
    expect(matches).toEqual([]);
  });
});
