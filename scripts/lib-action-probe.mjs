#!/usr/bin/env node
/**
 * Diagnostic: where does "Add to Library" / "Favorite" live in the Roon browse
 * tree for a given album query? Written for the 2026-06-08 add_to_library
 * navigation defect, where the resolved action menu was the play-action popup
 * (Play Now / Add Next / Queue / Start Radio) with no library toggle.
 *
 * Pairs as its OWN extension ("com.roon-bridge.probe") so it can run ALONGSIDE
 * the live bridge without stealing its pairing. First run requires a one-time
 * approval in Roon Settings > Extensions (it prints a clear "waiting" line).
 *
 * Usage (on the Roon Core host, with the bridge left running):
 *   node scripts/lib-action-probe.mjs "Eileen Ivers Beyond the Bog Road"
 *
 * It searches, then for EACH album-bearing section at the search root (the
 * "primary match" card AND the "Albums" category) it drills to the album and
 * recursively dumps every nested action_list/list one extra level, flagging any
 * item whose title looks like a library/favorite toggle.
 */
import RoonApi from "node-roon-api";
import RoonApiBrowse from "node-roon-api-browse";
import RoonApiTransport from "node-roon-api-transport";
import RoonApiStatus from "node-roon-api-status";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(REPO_ROOT, "probe-config.json");
const QUERY = process.argv[2] || "Eileen Ivers Beyond the Bog Road";
const HOST = process.env.ROON_CORE_HOST || "127.0.0.1";
const PORT = Number(process.env.ROON_CORE_PORT || 9330);

const LIB_RE = /library|favorite|favourite|heart/i;

function loadConfig() { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) || {}; } catch { return {}; } }
function saveConfig(patch) { const c = loadConfig(); Object.assign(c, patch); mkdirSync(dirname(CONFIG_PATH), { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 4)); }

let core = null, coreResolve;
const corePaired = new Promise((res) => { coreResolve = res; });

const roon = new RoonApi({
  extension_id: "com.roon-bridge.probe", display_name: "Roon Bridge Library Probe",
  display_version: "1.0.0", publisher: "roon-bridge", email: "noreply@roon-bridge.local",
  log_level: "none",
  get_persisted_state: () => loadConfig().roonstate || {},
  set_persisted_state: (s) => saveConfig({ roonstate: s }),
  core_paired: (c) => { core = c; coreResolve(); },
  core_unpaired: () => { core = null; },
});
const status = new RoonApiStatus(roon);
roon.init_services({ required_services: [RoonApiTransport, RoonApiBrowse], provided_services: [status] });
status.set_status("Library action probe", false);
roon.ws_connect({ host: HOST, port: PORT, onclose: () => {}, onerror: () => {} });

const pBrowse = (opts) => new Promise((r) => core.services.RoonApiBrowse.browse(opts, (_e, b) => r(b || {})));
const pLoad = (opts) => new Promise((r) => core.services.RoonApiBrowse.load(opts, (_e, b) => r(b || {})));

function fmt(item) {
  const lib = LIB_RE.test(item.title || "") ? "  <<< LIBRARY/FAVORITE" : "";
  return `- "${item.title}" (hint=${item.hint} key=${(item.item_key || "").slice(0, 10)})${lib}`;
}

async function browseLoad(hierarchy, sk, item_key) {
  const opts = { hierarchy, multi_session_key: sk };
  if (item_key) opts.item_key = item_key; else { opts.pop_all = true; opts.input = QUERY; }
  const b = await pBrowse(opts);
  if (b.action === "message") return { message: b.message, list: b.list, items: [] };
  const r = await pLoad({ hierarchy, multi_session_key: sk, offset: 0, count: 50 });
  return { list: b.list, items: r.items || [] };
}

// Recursively dump the action tree under an item, drilling action_list/list
// children up to `maxDepth` extra levels. Each drill uses a fresh session key
// so sibling drills don't pop each other's navigation stack.
async function dumpActionTree(item_key, label, depth, maxDepth) {
  const pad = "  ".repeat(depth);
  const sk = "probe-" + label.replace(/\W+/g, "") + "-" + depth + "-" + (item_key || "").slice(0, 6);
  const { list, items, message } = await browseLoad("search", sk, item_key);
  console.log(`${pad}[${label}] list.hint=${list?.hint ?? "-"} title=${JSON.stringify(list?.title)}${message ? " MESSAGE=" + message : ""}`);
  for (const it of items) console.log(`${pad}  ${fmt(it)}`);
  if (depth >= maxDepth) return;
  const children = items.filter((i) => i.item_key && (i.hint === "action_list" || i.hint === "list"));
  for (const child of children) {
    // Skip obvious track rows ("1. ...", "2. ...") to keep the dump focused.
    if (/^\d+\.\s/.test(child.title || "")) continue;
    await dumpActionTree(child.item_key, `${label} > ${child.title}`, depth + 1, maxDepth);
  }
}

(async () => {
  console.log(`Probe connecting to ${HOST}:${PORT}, query=${JSON.stringify(QUERY)} ...`);
  console.log("If this hangs, approve 'Roon Bridge Library Probe' in Roon Settings > Extensions.");
  await Promise.race([corePaired, new Promise((_, j) => setTimeout(() => j(new Error("pairing timeout (approve the extension in Roon)")), 240000))]);
  console.log(`Paired with core: ${core.display_name}\n`);

  const sk = "probe-root-" + Date.now();
  const { items: rootItems } = await browseLoad("search", sk, null);
  console.log("=== SEARCH ROOT sections ===");
  for (const it of rootItems) console.log("  " + fmt(it));

  // Every section that could carry an album: the primary-match card (title
  // contains the query words) and the "Albums" category.
  const sections = rootItems.filter(
    (i) => i.item_key && i.hint !== "header" &&
      (/album/i.test(i.title) || QUERY.toLowerCase().split(/\s+/).some((w) => w.length > 2 && i.title.toLowerCase().includes(w))),
  );
  console.log(`\n=== Drilling ${sections.length} candidate section(s) ===`);
  for (const section of sections) {
    console.log(`\n##### SECTION: "${section.title}" #####`);
    const secSk = "probe-sec-" + section.title.replace(/\W+/g, "");
    const { items: secItems } = await browseLoad("search", secSk, section.item_key);
    for (const it of secItems) console.log("  " + fmt(it));
    // Drill the first album-looking row in this section, dumping its action tree.
    const album = secItems.find((i) => i.item_key && i.hint !== "header");
    if (album) {
      console.log(`\n  --- action tree under "${album.title}" ---`);
      await dumpActionTree(album.item_key, album.title, 0, 3);
    }
  }

  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
