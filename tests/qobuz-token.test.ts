import { describe, it, expect } from "vitest";
import { parseTokenFile } from "../src/providers/qobuz/token.js";

describe("parseTokenFile", () => {
  it("parses a valid token.json", () => {
    expect(
      parseTokenFile(
        JSON.stringify({ user_auth_token: "tok", user_id: "42", app_id: "9", refreshed_at: 1 }),
      ),
    ).toEqual({ userAuthToken: "tok", userId: "42" });
  });

  it("returns null when fields are missing", () => {
    expect(parseTokenFile(JSON.stringify({ user_id: "42" }))).toBeNull();
    expect(parseTokenFile(JSON.stringify({ user_auth_token: "tok" }))).toBeNull();
  });

  it("returns null on empty values", () => {
    expect(parseTokenFile(JSON.stringify({ user_auth_token: "", user_id: "42" }))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseTokenFile("{not json")).toBeNull();
  });
});
