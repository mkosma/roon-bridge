/**
 * Browser-free Qobuz app credential extraction.
 *
 * Faithful TS port of loxoron218/qobuz-api src/credentials/web.rs (verified
 * working against a live account in the 2026-05-16 spike). Replaces the manual
 * env-set app_id/app_secret. No browser, no Playwright — plain HTTP + regex.
 *
 *   app_id     : regex from the production API config in bundle.js
 *   app_secret : seed+timezone from initialSeed(), locate the timezone object,
 *                concat seed+info+extras, drop the last 44 chars, base64-decode.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ProviderError } from "../types.js";

const LOGIN_URL = "https://play.qobuz.com/login";
const CACHE_PATH = join(homedir(), ".cache", "roon-bridge", "qobuz-app-creds.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

function fail(msg: string): never {
  throw new ProviderError("config", `Qobuz credential extraction: ${msg}`, "qobuz");
}

export function extractBundleUrl(loginHtml: string): string {
  const m = loginHtml.match(/src="(\/[^"]*bundle[^"]*\.js)"/);
  if (!m) fail("could not find bundle.js URL in login page");
  return `https://play.qobuz.com${m[1]}`;
}

export function extractAppId(js: string): string {
  const m = js.match(/production:\{api:\{appId:"(\d+)"/);
  if (!m) fail("could not find production appId in bundle");
  return m[1];
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

export function extractAppSecret(js: string): string {
  const st = js.match(/\):[a-z]\.initialSeed\("(.*?)",window\.utimezone\.([a-z]+)\)/);
  if (!st) fail("could not find seed/timezone in bundle");
  const seed = st[1];
  const timezone = st[2];

  const titleTz = capitalizeFirst(timezone);
  // Rust: format!(r#"name:"[^"]*/{title_case_timezone}"[^}}]*"#)
  const objRe = new RegExp(`name:"[^"]*/${titleTz}"[^}]*`);
  const objM = js.match(objRe);
  if (!objM) fail("could not find timezone object with info/extras");
  const obj = objM[0];

  const info = obj.match(/info:"([^"]*)"/)?.[1] ?? "";
  const extras = obj.match(/extras:"([^"]*)"/)?.[1] ?? "";

  const concat = `${seed}${info}${extras}`;
  if (concat.length <= 44) fail("seed+info+extras too short to decode");
  const b64 = concat.slice(0, concat.length - 44);

  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch (e) {
    fail(`base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!decoded) fail("decoded app secret is empty");
  return decoded;
}

/** Fetch login page + bundle and extract (app_id, app_secret). */
export async function extractWebPlayerCreds(): Promise<AppCredentials> {
  let loginHtml: string;
  try {
    const r = await fetch(LOGIN_URL, { signal: AbortSignal.timeout(20_000) });
    loginHtml = await r.text();
  } catch (e) {
    fail(`fetch login page: ${e instanceof Error ? e.message : String(e)}`);
  }
  const bundleUrl = extractBundleUrl(loginHtml);

  let bundleJs: string;
  try {
    const r = await fetch(bundleUrl, { signal: AbortSignal.timeout(20_000) });
    bundleJs = await r.text();
  } catch (e) {
    fail(`fetch bundle.js: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { appId: extractAppId(bundleJs), appSecret: extractAppSecret(bundleJs) };
}

function readCache(): AppCredentials | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
      appId: string;
      appSecret: string;
      fetchedAt: number;
    };
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
    if (!raw.appId || !raw.appSecret) return null;
    return { appId: raw.appId, appSecret: raw.appSecret };
  } catch {
    return null;
  }
}

function writeCache(c: AppCredentials): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ ...c, fetchedAt: Date.now() }),
      "utf8",
    );
  } catch {
    // cache is best-effort
  }
}

/** Cache-aware accessor. `forceRefresh` bypasses + repopulates the cache. */
export async function getAppCredentials(
  opts: { forceRefresh?: boolean } = {},
): Promise<AppCredentials> {
  if (!opts.forceRefresh) {
    const cached = readCache();
    if (cached) return cached;
  }
  const fresh = await extractWebPlayerCreds();
  writeCache(fresh);
  return fresh;
}
