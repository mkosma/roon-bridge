#!/usr/bin/env node
/**
 * Post-deploy smoke check for roon-bridge. Run after every
 * `launchctl kickstart`, BEFORE declaring a deploy done - see scripts/smoke.sh
 * and the "Deploy" section of README.md.
 *
 * Read-only by default (subscription health, zone freshness, tool-surface
 * hash vs the local build, version/commit vs repo HEAD). The mutation smoke
 * (one queue_by_id + edit_queue delete of the same track at the queue tail,
 * net-zero) only runs with --live-mutation, for an explicit Monty-approved
 * window - never invoke that flag as part of an unattended deploy.
 *
 * Usage: scripts/smoke.sh [--zone "Name"] [--live-mutation]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIVE_MUTATION = process.argv.includes("--live-mutation");
const zoneFlagIndex = process.argv.indexOf("--zone");
const ZONE_ARG = zoneFlagIndex !== -1 ? process.argv[zoneFlagIndex + 1] : undefined;

const HOST = process.env.SMOKE_BRIDGE_HOST || "localhost";
const PORT = process.env.BRIDGE_PORT || "3100";
const STALE_EVENT_MS = Number(process.env.SMOKE_STALE_EVENT_MS || 120_000);
const BASE_URL = `http://${HOST}:${PORT}`;

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[smoke] ${mark} - ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}
function info(label, detail) {
  console.log(`[smoke] INFO - ${label}${detail ? `: ${detail}` : ""}`);
}

function resolveAuthToken() {
  if (process.env.BRIDGE_AUTH_TOKEN) return process.env.BRIDGE_AUTH_TOKEN;
  try {
    const plist = join(process.env.HOME ?? "", "Library/LaunchAgents/com.roon-bridge.plist");
    const token = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :EnvironmentVariables:BRIDGE_AUTH_TOKEN", plist],
      { encoding: "utf8" },
    ).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

const AUTH_TOKEN = resolveAuthToken();
const authHeaders = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response - leave body null, caller checks res.status
  }
  return { status: res.status, body };
}

/** sha256 of a stable (sorted) summary of every tool's name + wire schema. */
function schemaHash(tools) {
  const summary = tools
    .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16);
}

/** Tool list from the LOCAL build (build/mcp-server-factory.js), in-process - no network. */
async function localTools() {
  const factoryPath = join(REPO_ROOT, "build", "mcp-server-factory.js");
  const { createMcpServer } = await import(pathToFileURL(factoryPath).href);
  const server = createMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-local", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

async function main() {
  console.log(`[smoke] Checking ${BASE_URL} (auth: ${AUTH_TOKEN ? "bearer token" : "none"})`);

  // 1. /health: reachable, Roon connected, version/commit vs repo HEAD.
  const health = await getJson("/health");
  check("bridge reachable", health.status === 200, `GET /health -> ${health.status}`);
  if (health.body) {
    check("roon connected", health.body.roon_connected === true);

    let localCommit = null;
    try {
      localCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    } catch {
      // not a git checkout - skip the commit comparison below
    }
    if (localCommit) {
      check(
        "running commit matches repo HEAD",
        health.body.commit === localCommit,
        `running=${health.body.commit ?? "(none reported - stale build predates the /health commit field)"} HEAD=${localCommit}`,
      );
    } else {
      info("running commit vs HEAD", "skipped - not a git checkout");
    }
    info("version", health.body.version ?? "(unknown)");
  }

  // 2. /monitor/state: subscription alive, a recent zone event.
  const zoneQuery = ZONE_ARG ? `?zone=${encodeURIComponent(ZONE_ARG)}` : "";
  const monitor = await getJson(`/monitor/state${zoneQuery}`);
  if (check("monitor/state reachable", monitor.status === 200, `GET /monitor/state -> ${monitor.status}`)) {
    check("subscription_alive", monitor.body?.subscription_alive === true);
    const ts = monitor.body?.last_zone_event_ts;
    const ageMs = typeof ts === "number" ? Date.now() - ts : null;
    check(
      "recent zone event",
      typeof ageMs === "number" && ageMs >= 0 && ageMs <= STALE_EVENT_MS,
      ageMs === null ? "no last_zone_event_ts reported" : `${Math.round(ageMs / 1000)}s old (threshold ${STALE_EVENT_MS / 1000}s)`,
    );
  }

  // 3. MCP initialize + tools/list succeeds; tool count/schema hash vs the local build.
  //    Mismatch here is the stale-bridge class: the daemon is serving an
  //    older build than what is checked out (a kickstart that silently
  //    failed to pick up a rebuild, or a deploy that forgot `npm run build`).
  let liveTools = null;
  try {
    const client = new Client({ name: "smoke-live", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: authHeaders },
    });
    await client.connect(transport);
    liveTools = (await client.listTools()).tools;
    await client.close();
  } catch (e) {
    check("MCP initialize + tools/list", false, e instanceof Error ? e.message : String(e));
  }

  if (liveTools) {
    check("MCP initialize + tools/list", true, `${liveTools.length} tools`);
    try {
      const local = await localTools();
      check("tool count matches local build", liveTools.length === local.length, `live=${liveTools.length} local=${local.length}`);
      check("tool schema hash matches local build", schemaHash(liveTools) === schemaHash(local), `live=${schemaHash(liveTools)} local=${schemaHash(local)}`);
    } catch (e) {
      check("tool schema hash matches local build", false, `could not load local build: ${e instanceof Error ? e.message : String(e)}. Run \`npm run build\` first.`);
    }
  }

  // 4. list_zones: read-only, confirms the expected zones are visible.
  if (liveTools) {
    try {
      const client = new Client({ name: "smoke-zones", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
        requestInit: { headers: authHeaders },
      });
      await client.connect(transport);
      const result = await client.callTool({ name: "list_zones", arguments: {} });
      await client.close();
      const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
      check("list_zones", result.isError !== true && text.length > 0, text.split("\n")[0]);
    } catch (e) {
      check("list_zones", false, e instanceof Error ? e.message : String(e));
    }
  }

  if (LIVE_MUTATION) {
    console.log("[smoke] --live-mutation set - running the mutation smoke. Only run this in a Monty-approved window.");
    await mutationSmoke();
  } else {
    info("mutation smoke", "skipped (pass --live-mutation in an approved window to run it)");
  }

  console.log(failures === 0 ? "[smoke] All checks passed." : `[smoke] ${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * One queue_by_id + edit_queue delete of the SAME track at the queue tail,
 * net-zero. Only reached behind --live-mutation.
 */
async function mutationSmoke() {
  const client = new Client({ name: "smoke-mutation", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: authHeaders },
  });
  await client.connect(transport);
  try {
    const queueBefore = await client.callTool({ name: "get_queue", arguments: ZONE_ARG ? { zone: ZONE_ARG } : {} });
    if (queueBefore.isError) {
      check("mutation smoke: get_queue", false, queueBefore.content?.[0]?.text);
      return;
    }
    // A net-zero probe needs a real track ID and zone context this script
    // does not have without a full browse round trip. Ship the gate and the
    // read-side setup; a follow-up can wire the exact queue_by_id/edit_queue
    // pair against a known-good test track once one is designated for this
    // purpose (see the PR description's noted spec gap).
    info("mutation smoke", "queue read ok; queue_by_id/edit_queue round trip not yet wired - see PR notes");
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("[smoke] Fatal error:", e);
  process.exit(1);
});
