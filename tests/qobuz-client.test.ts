import { describe, it, expect } from "vitest";
import { requestSig } from "../src/providers/qobuz/client.js";

// Vectors generated from the exact Python algorithm in qobuz-mcp/server.py
// (_request_sig): sort by key, keep truthy values, concat values, append
// ts + app_secret, md5-hex. Any drift here is a port regression.
describe("requestSig (port of _request_sig)", () => {
  it("vector 1: mixed params with empty value dropped", () => {
    expect(
      requestSig(
        "playlist/get",
        { playlist_id: "123", limit: 50, b: "", a: "z" },
        1_700_000_000,
        "SECRET",
      ),
    ).toBe("b73933d6edabee7b6f0aecdccbf552ae");
  });

  it("vector 2: search params", () => {
    expect(
      requestSig("catalog/search", { query: "spoon", type: "tracks" }, 1, "abc"),
    ).toBe("fa0a68ec0a518c2bebb126e22a4fb00d");
  });

  it("strips leading slashes and all internal slashes from the path", () => {
    // path normalization must match: "/playlist/get" -> "playlistget"
    const a = requestSig("/playlist/get", { x: "1" }, 5, "s");
    const b = requestSig("playlist/get", { x: "1" }, 5, "s");
    expect(a).toBe(b);
  });
});
