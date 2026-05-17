/**
 * Qobuz API transport — faithful TS port of qobuz-mcp/server.py's _request /
 * _request_sig. Pure transport: it injects app_id + token, optionally signs,
 * parses JSON, and classifies auth failures. Token *sourcing* and retry/refresh
 * policy live elsewhere (token.ts / the adapter); this layer never spawns a
 * browser and never refreshes.
 */

import { createHash } from "node:crypto";
import { ProviderError } from "../types.js";

const QOBUZ_BASE = "https://www.qobuz.com/api.json/0.2";

export interface QobuzCredentials {
  appId: string;
  appSecret: string;
  userAuthToken: string;
  userId: string;
}

export type QobuzParams = Record<string, string | number | undefined>;

/**
 * sig = md5(endpoint_path_no_slashes + sorted_param_values + ts + app_secret)
 * Ported verbatim from _request_sig: sort by key, keep only truthy values,
 * concatenate values with no separator.
 */
export function requestSig(
  endpoint: string,
  params: QobuzParams,
  ts: number,
  appSecret: string,
): string {
  const path = endpoint.replace(/^\/+/, "").replace(/\//g, "");
  const sortedVals = Object.keys(params)
    .sort()
    .map((k) => params[k])
    .filter((v) => v !== undefined && v !== "" && v !== 0)
    .map((v) => String(v))
    .join("");
  return createHash("md5")
    .update(`${path}${sortedVals}${ts}${appSecret}`)
    .digest("hex");
}

function isAuthError(data: Record<string, unknown>): boolean {
  if (data.code === 401) return true;
  const msg = String(data.message ?? "").toLowerCase();
  return msg.includes("authentication") || msg.includes("auth_required");
}

export class QobuzClient {
  constructor(private readonly creds: QobuzCredentials) {}

  /**
   * Perform a Qobuz API call. GET puts params in the query string; POST sends
   * them as form-urlencoded body (plus app_id), matching the Python client.
   * Throws ProviderError("auth") on a Qobuz auth rejection so the caller can
   * surface the run-the-refresher message.
   */
  async request(
    method: "GET" | "POST",
    endpoint: string,
    params: QobuzParams = {},
    opts: { signed?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const p: QobuzParams = { ...params, app_id: this.creds.appId };
    if (opts.signed) {
      const ts = Math.floor(Date.now() / 1000);
      p.request_ts = ts;
      p.request_sig = requestSig(endpoint, p, ts, this.creds.appSecret);
    }

    const headers: Record<string, string> = {
      "X-User-Auth-Token": this.creds.userAuthToken,
      "X-App-Id": this.creds.appId,
    };

    const base = `${QOBUZ_BASE}/${endpoint.replace(/^\/+/, "")}`;
    let url: string;
    let body: string | undefined;

    if (method === "GET") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      url = `${base}?${qs.toString()}`;
    } else {
      url = base;
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) {
        if (v !== undefined) form.set(k, String(v));
      }
      body = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    let result: Record<string, unknown>;
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });
      result = (await resp.json()) as Record<string, unknown>;
    } catch (e) {
      throw new ProviderError(
        "api",
        `Qobuz request failed (${endpoint}): ${e instanceof Error ? e.message : String(e)}`,
        "qobuz",
      );
    }

    if (isAuthError(result)) {
      throw new ProviderError(
        "auth",
        "Qobuz auth rejected. The user token is missing or expired — run the " +
          "refresher: `uv run ~/dev/qobuz-mcp/refresh_token.py` (or `--login` " +
          "for first-time setup).",
        "qobuz",
      );
    }

    return result;
  }
}
