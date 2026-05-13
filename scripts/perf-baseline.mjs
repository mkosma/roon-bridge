#!/usr/bin/env node
/**
 * Roon API perf baseline. Reuses roon-bridge auth (extension_id +
 * config.json), so the bridge MUST NOT be running concurrently.
 *
 *   launchctl bootout gui/$(id -u)/com.roon-bridge
 *   npm run perf:baseline
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roon-bridge.plist
 *
 * Prints a markdown table of best-of-3 timings for 8 representative
 * library/search calls (Library counts, album/artist listing, paging
 * variants, artist drill-in, and two searches).
 */

import RoonApi from "node-roon-api";
import RoonApiBrowse from "node-roon-api-browse";
import RoonApiTransport from "node-roon-api-transport";
import RoonApiStatus from "node-roon-api-status";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROON_HOST = process.env.ROON_HOST || "127.0.0.1";
const ROON_PORT = parseInt(process.env.ROON_PORT || "9330", 10);

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(REPO_ROOT, "config.json");

function loadConfig() { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) || {}; } catch { return {}; } }
function saveConfig(p) { const c = loadConfig(); Object.assign(c, p); mkdirSync(dirname(CONFIG_PATH), { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 4)); }

let core = null, coreResolve;
const corePaired = new Promise((res) => { coreResolve = res; });

const roon = new RoonApi({
  extension_id: "com.roon-bridge.claude", display_name: "Roon Bridge for Claude",
  display_version: "1.0.0", publisher: "roon-bridge", email: "noreply@roon-bridge.local",
  log_level: "none",
  get_persisted_state: () => loadConfig().roonstate || {},
  set_persisted_state: (s) => saveConfig({ roonstate: s }),
  core_paired: (c) => { core = c; coreResolve(); },
  core_unpaired: () => { core = null; },
});
const status = new RoonApiStatus(roon);
roon.init_services({ required_services: [RoonApiTransport, RoonApiBrowse], provided_services: [status] });
roon.ws_connect({ host: ROON_HOST, port: ROON_PORT, onclose: () => {}, onerror: () => {} });

const pBrowse = (opts) => new Promise((r) => core.services.RoonApiBrowse.browse(opts, (_e, b) => r(b)));
const pLoad = (opts) => new Promise((r) => core.services.RoonApiBrowse.load(opts, (_e, b) => r(b)));

async function loadAllPages(hierarchy, sk, pageSize = 100) {
  let offset = 0, total = 0, pages = 0;
  while (true) {
    const r = await pLoad({ hierarchy, multi_session_key: sk, offset, count: pageSize });
    pages++;
    const got = r.items?.length || 0;
    total += got;
    if (got < pageSize) break;
    offset += pageSize;
  }
  return { count: total, pages };
}

async function timed(fn) {
  const t0 = Date.now();
  let count = 0, notes;
  try { const r = await fn(); count = r.count; notes = r.notes; }
  catch (e) { notes = `ERROR: ${e?.message || e}`; }
  return { ms: Date.now() - t0, count, notes };
}

async function bestOf3(id, desc, fn) {
  try { await fn(); } catch {}  // prime
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await timed(fn));
  runs.sort((a, b) => a.ms - b.ms);
  return { id, desc, ...runs[0] };
}

async function main() {
  console.error(`[perf] Connecting to Roon at ${ROON_HOST}:${ROON_PORT}...`);
  await Promise.race([
    corePaired,
    new Promise((_, j) => setTimeout(() => j(new Error("Pairing timeout (15s)")), 15000)),
  ]);
  console.error("[perf] Paired. Running tests...");

  const results = [];

  // R7: counts per Library section (cheapest summary)
  results.push(await bestOf3("R7", "Library section counts (Albums/Artists/Tracks/Composers)", async () => {
    const sk = "perf-r7-" + Date.now();
    await pBrowse({ hierarchy: "browse", multi_session_key: sk, pop_all: true });
    const root = await pLoad({ hierarchy: "browse", multi_session_key: sk, offset: 0, count: 30 });
    const lib = (root.items || []).find((i) => i.title === "Library");
    if (!lib) throw new Error("Library section not found");
    await pBrowse({ hierarchy: "browse", multi_session_key: sk, item_key: lib.item_key });
    const libList = await pLoad({ hierarchy: "browse", multi_session_key: sk, offset: 0, count: 30 });
    const wanted = ["Artists", "Albums", "Tracks", "Composers"];
    const counts = [];
    for (const item of (libList.items || [])) {
      if (!wanted.includes(item.title)) continue;
      const r = await pBrowse({ hierarchy: "browse", multi_session_key: sk, item_key: item.item_key });
      counts.push(`${item.title}=${r.list?.count ?? "?"}`);
    }
    return { count: counts.length, notes: counts.join(", ") };
  }));

  // R1: list first 100 albums (direct albums hierarchy)
  results.push(await bestOf3("R1", "hierarchy=albums, load 100", async () => {
    const sk = "perf-r1-" + Date.now();
    await pBrowse({ hierarchy: "albums", multi_session_key: sk, pop_all: true });
    const r = await pLoad({ hierarchy: "albums", multi_session_key: sk, offset: 0, count: 100 });
    return { count: r.items?.length || 0 };
  }));

  // R2: list ALL albums
  results.push(await bestOf3("R2", "hierarchy=albums, load all (paged 100)", async () => {
    const sk = "perf-r2-" + Date.now();
    await pBrowse({ hierarchy: "albums", multi_session_key: sk, pop_all: true });
    const { count, pages } = await loadAllPages("albums", sk, 100);
    return { count, notes: `${pages} pages` };
  }));

  // R2b: list ALL albums with bigger page size
  results.push(await bestOf3("R2b", "hierarchy=albums, load all (paged 500)", async () => {
    const sk = "perf-r2b-" + Date.now();
    await pBrowse({ hierarchy: "albums", multi_session_key: sk, pop_all: true });
    const { count, pages } = await loadAllPages("albums", sk, 500);
    return { count, notes: `${pages} pages` };
  }));

  // R3: list ALL artists
  results.push(await bestOf3("R3", "hierarchy=artists, load all (paged 100)", async () => {
    const sk = "perf-r3-" + Date.now();
    await pBrowse({ hierarchy: "artists", multi_session_key: sk, pop_all: true });
    const { count, pages } = await loadAllPages("artists", sk, 100);
    return { count, notes: `${pages} pages` };
  }));

  // R4: drill into one artist
  results.push(await bestOf3("R4", "hierarchy=artists -> drill into one artist", async () => {
    const sk = "perf-r4-" + Date.now();
    await pBrowse({ hierarchy: "artists", multi_session_key: sk, pop_all: true });
    const list = await pLoad({ hierarchy: "artists", multi_session_key: sk, offset: 0, count: 1 });
    const a = list.items?.[0];
    if (!a?.item_key) throw new Error("No first artist");
    await pBrowse({ hierarchy: "artists", multi_session_key: sk, item_key: a.item_key });
    const r = await pLoad({ hierarchy: "artists", multi_session_key: sk, offset: 0, count: 100 });
    return { count: r.items?.length || 0, notes: `artist=${a.title}` };
  }));

  // R5: search "Murmur"
  results.push(await bestOf3("R5", "Search 'Murmur'", async () => {
    const sk = "perf-r5-" + Date.now();
    await pBrowse({ hierarchy: "search", multi_session_key: sk, input: "Murmur", pop_all: true });
    const r = await pLoad({ hierarchy: "search", multi_session_key: sk, offset: 0, count: 100 });
    return { count: r.items?.length || 0 };
  }));

  // R6: search "Built To Spill"
  results.push(await bestOf3("R6", "Search 'Built To Spill'", async () => {
    const sk = "perf-r6-" + Date.now();
    await pBrowse({ hierarchy: "search", multi_session_key: sk, input: "Built To Spill", pop_all: true });
    const r = await pLoad({ hierarchy: "search", multi_session_key: sk, offset: 0, count: 100 });
    return { count: r.items?.length || 0 };
  }));

  console.log("\n# Roon API perf baseline\n");
  console.log("| Test | Description | Best ms | Count | Notes |");
  console.log("|---|---|---:|---:|---|");
  for (const r of results) {
    console.log(`| ${r.id} | ${r.desc} | ${r.ms} | ${r.count} | ${r.notes ?? ""} |`);
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => { console.error("[perf] FATAL", e); process.exit(1); });
