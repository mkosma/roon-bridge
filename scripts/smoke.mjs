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

/** All text content items of a tool result, joined. */
function resultText(result) {
  return result.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

/** The structured queue rows from a get_queue result ([] if the queue is empty). */
function queueItems(result) {
  for (const c of result.content ?? []) {
    if (typeof c.text !== "string") continue;
    try {
      const parsed = JSON.parse(c.text);
      if (Array.isArray(parsed?.items)) return parsed.items;
    } catch {
      // human-readable line, not the JSON payload - keep looking
    }
  }
  return [];
}

/**
 * Net-zero write probe: append the designated test track at the queue tail
 * with queue_by_id, confirm exactly one new item landed, delete it with
 * edit_queue, and confirm the queue is byte-for-byte back to its prior item
 * set. This exercises the exact write path the incident lived in, end to end.
 *
 * Three hard preconditions, all enforced here:
 *   - SMOKE_TEST_TRACK_ID must name a stable provider track (default provider
 *     qobuz). There is no safe implicit default - get_queue does not expose
 *     provider ids and provenance only covers self-queued items, so the track
 *     must be designated. See README "Deploy > mutation smoke".
 *   - The zone must be IDLE. edit_queue's immediate rebuild would cut a playing
 *     track; on an idle zone the append+delete never reaches an output. If the
 *     zone is playing, this SKIPS rather than risk a cut - run it in a paused
 *     or stopped window.
 *   - There must be >=1 pre-existing UPCOMING track. edit_queue cannot leave the
 *     upcoming queue empty (it rebuilds by playing a first track then appending,
 *     so an empty result is unreachable - it returns cannot_empty_queue). With
 *     no upcoming track, our appended item is the ONLY upcoming item, so the
 *     net-zero delete is impossible and would strand the test track. If there is
 *     no upcoming track, this SKIPS before appending anything.
 *
 * Whatever happens after the append, the appended test track is removed before
 * this returns - a finally-block safety net re-reads the queue and force-deletes
 * it, raising a loud FAIL (remove-it-manually) if it cannot. This is the fix for
 * the 2026-07-12 incident where a refused delete stranded the test track live.
 *
 * Only reached behind --live-mutation.
 */
async function mutationSmoke() {
  const TEST_TRACK_ID = process.env.SMOKE_TEST_TRACK_ID;
  const PROVIDER = process.env.SMOKE_TEST_TRACK_PROVIDER || "qobuz";
  if (!TEST_TRACK_ID) {
    check("mutation smoke: designated test track", false,
      "set SMOKE_TEST_TRACK_ID to a stable provider track id (see README Deploy > mutation smoke)");
    return;
  }
  const zoneArgs = ZONE_ARG ? { zone: ZONE_ARG } : {};

  const client = new Client({ name: "smoke-mutation", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: authHeaders },
  });
  await client.connect(transport);
  // Set only once the append lands; the finally block guarantees its removal.
  let appendedId = null;
  try {
    // Precondition: idle zone. Parse now_playing's "State:" line.
    const np = await client.callTool({ name: "now_playing", arguments: zoneArgs });
    const stateLine = resultText(np).split("\n").find((l) => /^\s*State:/i.test(l)) ?? "";
    if (/playing/i.test(stateLine)) {
      info("mutation smoke", `zone is playing (${stateLine.trim()}) - skipped; run in a paused/stopped window`);
      return;
    }

    const before = queueItems(await client.callTool({ name: "get_queue", arguments: zoneArgs }));
    const beforeIds = new Set(before.map((r) => r.queue_item_id));

    // Precondition: >=1 pre-existing upcoming track (rows after the now-playing
    // head; if nothing is now-playing, every row is upcoming). Without one, the
    // net-zero delete would empty the upcoming queue (cannot_empty_queue) and
    // strand the test track - so skip before appending anything.
    const nowIdx = before.findIndex((r) => r.is_now_playing);
    const upcomingBefore = nowIdx >= 0 ? before.length - nowIdx - 1 : before.length;
    if (upcomingBefore < 1) {
      info("mutation smoke",
        `no pre-existing upcoming track (queue has ${before.length} item(s), ${upcomingBefore} upcoming) - skipped; ` +
        `the net-zero delete would empty the upcoming queue (cannot_empty_queue). Queue a track ahead, then rerun.`);
      return;
    }

    // 1. Append at the tail (when:"queue" = append, never cuts the head).
    const appended = await client.callTool({
      name: "queue_by_id",
      arguments: { track_id: TEST_TRACK_ID, provider: PROVIDER, when: "queue", ...zoneArgs },
    });
    if (appended.isError) {
      check("mutation smoke: queue_by_id append", false, resultText(appended).split("\n")[0]);
      return;
    }

    // 2. Exactly one new item at the tail.
    const after = queueItems(await client.callTool({ name: "get_queue", arguments: zoneArgs }));
    const added = after.filter((r) => !beforeIds.has(r.queue_item_id));
    if (added.length === 1) appendedId = added[0].queue_item_id;
    if (!check("mutation smoke: append landed (+1 item)", added.length === 1, `got +${added.length}`)) {
      // Abnormal count - delete every added id here; the finally net covers
      // appendedId (unset in this branch), these cover the rest.
      for (const r of added) {
        await client.callTool({ name: "edit_queue", arguments: { delete: [r.queue_item_id], immediate: true, ...zoneArgs } });
      }
      return;
    }

    // 3. Delete it (immediate rebuild is safe on an idle zone).
    const del = await client.callTool({
      name: "edit_queue",
      arguments: { delete: [appendedId], immediate: true, ...zoneArgs },
    });
    check("mutation smoke: edit_queue delete", del.isError !== true, resultText(del).split("\n")[0]);

    // 4. Net-zero: no item we did not start with remains.
    const restored = queueItems(await client.callTool({ name: "get_queue", arguments: zoneArgs }));
    const leftover = restored.map((r) => r.queue_item_id).filter((id) => !beforeIds.has(id));
    check("mutation smoke: net-zero (queue restored)", leftover.length === 0,
      leftover.length ? `test item(s) still queued: ${leftover.join(",")}` : "queue matches pre-probe state");
  } finally {
    // Safety net: the appended test track must never survive the probe. If a
    // delete above refused or failed, it is still queued - force-remove it and
    // raise a loud FAIL (with the id) if it cannot be removed.
    if (appendedId != null) {
      try {
        const stillQueued = async () =>
          queueItems(await client.callTool({ name: "get_queue", arguments: zoneArgs }))
            .some((r) => r.queue_item_id === appendedId);
        if (await stillQueued()) {
          await client.callTool({ name: "edit_queue", arguments: { delete: [appendedId], immediate: true, ...zoneArgs } });
          const survived = await stillQueued();
          check("mutation smoke: cleanup (test track removed)", !survived,
            survived
              ? `FAILED to remove test track (queue_item_id ${appendedId}) - REMOVE IT MANUALLY from the live queue`
              : `removed stranded test track (queue_item_id ${appendedId})`);
        }
      } catch (e) {
        check("mutation smoke: cleanup (test track removed)", false,
          `cleanup threw (${e instanceof Error ? e.message : String(e)}) - REMOVE test track (queue_item_id ${appendedId}) MANUALLY`);
      }
    }
    await client.close();
  }
}

main().catch((e) => {
  console.error("[smoke] Fatal error:", e);
  process.exit(1);
});
