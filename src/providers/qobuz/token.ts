/**
 * Qobuz user-token sourcing — quarantined.
 *
 * roon-bridge only *reads* ~/.qobuz-mcp/token.json (written by the standalone
 * Python+Playwright refresh_token.py, which is NOT a dependency of this
 * project). It never imports or bundles Playwright.
 *
 * On a missing/expired token the default is an actionable error (decision:
 * actionable error, not silent auto-refresh). Setting QOBUZ_AUTO_REFRESH=1
 * opts into a config-gated subprocess call of the external refresher.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProviderError } from "../types.js";
import { getAppCredentials } from "./credentials.js";
import type { QobuzCredentials } from "./client.js";

const TOKEN_PATH = join(homedir(), ".qobuz-mcp", "token.json");
const REFRESH_SCRIPT = join(homedir(), "dev", "qobuz-mcp", "refresh_token.py");

interface TokenFile {
  user_auth_token?: string;
  user_id?: string;
}

export interface UserToken {
  userAuthToken: string;
  userId: string;
}

/** Pure parse of token.json contents. Returns null if unusable. */
export function parseTokenFile(raw: string): UserToken | null {
  try {
    const d = JSON.parse(raw) as TokenFile;
    if (d.user_auth_token && d.user_id) {
      return { userAuthToken: d.user_auth_token, userId: d.user_id };
    }
    return null;
  } catch {
    return null;
  }
}

function readTokenFile(): UserToken | null {
  try {
    return parseTokenFile(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

const REFRESH_HINT =
  `Qobuz user token unavailable (${TOKEN_PATH}). Run the standalone ` +
  `refresher:\n  uv run ${REFRESH_SCRIPT}\n(first-time setup needs ` +
  `\`--login\` for the one-time browser/reCAPTCHA sign-in).`;

/** Optional, config-gated subprocess refresh. Returns true if a token appeared. */
function tryExternalRefresh(): boolean {
  if (process.env.QOBUZ_AUTO_REFRESH !== "1") return false;
  const r = spawnSync("uv", ["run", REFRESH_SCRIPT], {
    timeout: 90_000,
    stdio: "ignore",
  });
  if (r.status !== 0) return false;
  return readTokenFile() !== null;
}

/**
 * Assemble full Qobuz credentials: browser-free app_id/app_secret +
 * user token/id from token.json. Throws ProviderError("auth") with the
 * run-the-refresher hint if no usable token exists.
 */
export async function getQobuzCredentials(): Promise<QobuzCredentials> {
  let tok = readTokenFile();
  if (!tok && tryExternalRefresh()) tok = readTokenFile();
  if (!tok) throw new ProviderError("auth", REFRESH_HINT, "qobuz");

  const app = await getAppCredentials();
  return {
    appId: app.appId,
    appSecret: app.appSecret,
    userAuthToken: tok.userAuthToken,
    userId: tok.userId,
  };
}
