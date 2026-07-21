/**
 * Tests for command-context.ts: the X-Command-Source header sanitizer and the
 * AsyncLocalStorage propagation used to carry it into tool handlers.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeSource,
  runWithCommandSource,
  currentCommandSource,
  DEFAULT_COMMAND_SOURCE,
} from "../src/control/command-context.js";

describe("sanitizeSource", () => {
  it("returns the header value when it matches the allowed charset/length", () => {
    expect(sanitizeSource("telegram")).toBe("telegram");
    expect(sanitizeSource("maya-skill_1")).toBe("maya-skill_1");
  });

  it("lowercases a valid but mixed-case header", () => {
    expect(sanitizeSource("Telegram")).toBe("telegram");
  });

  it("defaults to maya when the header is absent", () => {
    expect(sanitizeSource(undefined)).toBe(DEFAULT_COMMAND_SOURCE);
    expect(DEFAULT_COMMAND_SOURCE).toBe("maya");
  });

  it("defaults to maya when the header is malformed", () => {
    expect(sanitizeSource("")).toBe(DEFAULT_COMMAND_SOURCE);
    expect(sanitizeSource("has spaces")).toBe(DEFAULT_COMMAND_SOURCE);
    expect(sanitizeSource("bad!chars")).toBe(DEFAULT_COMMAND_SOURCE);
    expect(sanitizeSource("x".repeat(33))).toBe(DEFAULT_COMMAND_SOURCE); // over 32 chars
  });

  it("defaults to maya for a non-string header (e.g. an array from a repeated header)", () => {
    expect(sanitizeSource(["a", "b"])).toBe(DEFAULT_COMMAND_SOURCE);
  });

  it("accepts the 32-char boundary and rejects one over", () => {
    expect(sanitizeSource("a".repeat(32))).toBe("a".repeat(32));
    expect(sanitizeSource("a".repeat(32) + "b")).toBe(DEFAULT_COMMAND_SOURCE);
  });
});

describe("runWithCommandSource / currentCommandSource", () => {
  it("returns the default outside any bound context", () => {
    expect(currentCommandSource()).toBe(DEFAULT_COMMAND_SOURCE);
  });

  it("returns the bound source inside runWithCommandSource", () => {
    runWithCommandSource("telegram", () => {
      expect(currentCommandSource()).toBe("telegram");
    });
  });

  it("propagates across an async/await chain", async () => {
    await runWithCommandSource("skill", async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentCommandSource()).toBe("skill");
    });
  });

  it("does not leak between concurrent contexts", async () => {
    const results: string[] = [];
    await Promise.all([
      runWithCommandSource("a", async () => {
        await new Promise((r) => setTimeout(r, 20));
        results.push(currentCommandSource());
      }),
      runWithCommandSource("b", async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(currentCommandSource());
      }),
    ]);
    expect(results.sort()).toEqual(["a", "b"]);
  });

  it("restores the outer context after the callback returns", () => {
    runWithCommandSource("inner", () => {
      expect(currentCommandSource()).toBe("inner");
    });
    expect(currentCommandSource()).toBe(DEFAULT_COMMAND_SOURCE);
  });
});
