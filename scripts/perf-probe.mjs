#!/usr/bin/env node
/**
 * Quick exploratory probe of the Roon browse tree. Pairs as the same
 * extension as roon-bridge (com.roon-bridge.claude) and reuses
 * config.json, so the bridge MUST NOT be running concurrently.
 *
 * Dumps:
 *   - root of the "browse" hierarchy
 *   - the "Library" section (if present)
 *   - direct "albums" hierarchy root
 *   - direct "artists" hierarchy root
 *
 * Usage (run on the Roon Core host):
 *
 *   launchctl bootout gui/$(id -u)/com.roon-bridge
 *   npm run perf:probe
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roon-bridge.plist
 */
import RoonApi from "node-roon-api";
import RoonApiBrowse from "node-roon-api-browse";
import RoonApiTransport from "node-roon-api-transport";
import RoonApiStatus from "node-roon-api-status";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(REPO_ROOT, "config.json");

function loadConfig() { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) || {}; } catch { return {}; } }
function saveConfig(patch) { const c = loadConfig(); Object.assign(c, patch); mkdirSync(dirname(CONFIG_PATH), { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 4)); }

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
roon.ws_connect({ host: "127.0.0.1", port: 9330, onclose: () => {}, onerror: () => {} });

const pBrowse = (opts) => new Promise((r) => core.services.RoonApiBrowse.browse(opts, (_e, b) => r(b)));
const pLoad = (opts) => new Promise((r) => core.services.RoonApiBrowse.load(opts, (_e, b) => r(b)));

async function dump(hierarchy, sk, item_key, label, depth = 0) {
  const opts = { hierarchy, multi_session_key: sk };
  if (item_key) opts.item_key = item_key; else opts.pop_all = true;
  const b = await pBrowse(opts);
  console.log(`${"  ".repeat(depth)}[BROWSE ${label}] list=${JSON.stringify(b.list)}`);
  const r = await pLoad({ hierarchy, multi_session_key: sk, offset: 0, count: 30 });
  for (const item of (r.items || [])) {
    console.log(`${"  ".repeat(depth + 1)}- ${item.title} (key=${item.item_key?.slice(0, 12)} hint=${item.hint})`);
  }
  return r.items || [];
}

(async () => {
  await Promise.race([corePaired, new Promise((_, j) => setTimeout(() => j(new Error("timeout")), 15000))]);

  console.log("\n=== ROOT of 'browse' hierarchy ===");
  const sk = "probe-" + Date.now();
  const rootItems = await dump("browse", sk, null, "root");

  // Try descending into "Library" if it exists
  const lib = rootItems.find((i) => i.title === "Library");
  if (lib) {
    console.log("\n=== Inside Library ===");
    await dump("browse", sk, lib.item_key, "Library", 1);
  }

  // Try "albums" hierarchy direct
  console.log("\n=== Direct hierarchy='albums' ===");
  try {
    await dump("albums", "probe-alb-" + Date.now(), null, "albums root");
  } catch (e) { console.log("  ERR:", e.message); }

  // Try "artists" hierarchy direct
  console.log("\n=== Direct hierarchy='artists' ===");
  try {
    await dump("artists", "probe-art-" + Date.now(), null, "artists root");
  } catch (e) { console.log("  ERR:", e.message); }

  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
