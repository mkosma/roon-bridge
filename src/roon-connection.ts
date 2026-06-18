import RoonApi from "node-roon-api";
import RoonApiTransport from "node-roon-api-transport";
import RoonApiBrowse from "node-roon-api-browse";
import RoonApiStatus from "node-roon-api-status";
import type { RoonCore } from "node-roon-api";
import type { Zone, QueueItem, Output } from "node-roon-api-transport";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";

const ROON_HOST = process.env.ROON_HOST || "192.168.1.100";
const ROON_PORT = (() => {
  const port = parseInt(process.env.ROON_PORT || "9100", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`[roon-bridge] Invalid ROON_PORT: ${process.env.ROON_PORT}. Using default 9100.`);
    return 9100;
  }
  return port;
})();

// Fixed path for config.json so pairing token persists across restarts
const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function loadConfig(): Record<string, unknown> {
  try {
    const content = readFileSync(CONFIG_PATH, { encoding: "utf8" });
    return JSON.parse(content) || {};
  } catch {
    return {};
  }
}

function saveConfig(patch: Record<string, unknown>): void {
  try {
    const config = loadConfig();
    Object.assign(config, patch);
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "    "));
  } catch (e) {
    console.error("[roon-bridge] Failed to save config:", e);
  }
}

function loadPersistedState(): Record<string, unknown> {
  return loadConfig()?.roonstate as Record<string, unknown> || {};
}

function savePersistedState(state: Record<string, unknown>): void {
  saveConfig({ roonstate: state });
}

export class RoonConnection extends EventEmitter {
  private roon: RoonApi;
  private status: RoonApiStatus;
  private core: RoonCore | null = null;
  private zones: Map<string, Zone> = new Map();
  private defaultZone: string = "";

  constructor() {
    super();
    // Listeners are added per SSE client; raise the cap a little so node's
    // default warning at 10 doesn't fire under modest fan-out.
    this.setMaxListeners(64);

    // Load persisted default zone at startup
    this.defaultZone = (loadConfig().defaultZone as string) || "";
    if (this.defaultZone) {
      console.error(`[roon-bridge] Default zone loaded: "${this.defaultZone}"`);
    }

    this.roon = new RoonApi({
      extension_id: "com.roon-bridge.claude",
      display_name: "Roon Bridge for Claude",
      display_version: "1.0.0",
      publisher: "roon-bridge",
      email: "noreply@roon-bridge.local",
      log_level: "none",

      get_persisted_state: loadPersistedState,
      set_persisted_state: savePersistedState,

      core_paired: (core) => {
        console.error(`[roon-bridge] Paired with core: ${core.display_name}`);
        this.core = core;
        this.subscribeZones();
      },

      core_unpaired: (core) => {
        console.error(`[roon-bridge] Unpaired from core: ${core.display_name}`);
        this.core = null;
        this.zones.clear();
      },
    });

    this.status = new RoonApiStatus(this.roon);

    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      provided_services: [this.status],
    });
  }

  connect(): void {
    console.error(`[roon-bridge] Connecting to Roon Core at ${ROON_HOST}:${ROON_PORT}...`);
    this.status.set_status("Connecting...", false);

    const doConnect = () => {
      this.roon.ws_connect({
        host: ROON_HOST,
        port: ROON_PORT,
        onclose: () => {
          console.error("[roon-bridge] Connection lost, reconnecting in 3s...");
          this.core = null;
          this.zones.clear();
          setTimeout(doConnect, 3000);
        },
        onerror: () => {
          console.error("[roon-bridge] WebSocket error");
        },
      });
    };

    doConnect();
  }

  private subscribeZones(): void {
    const transport = this.getTransportUnsafe();
    if (!transport) return;

    transport.subscribe_zones((response, msg) => {
      let changed = false;
      if (response === "Subscribed" && msg.zones) {
        this.zones.clear();
        for (const zone of msg.zones) {
          this.zones.set(zone.zone_id, zone);
        }
        console.error(`[roon-bridge] Subscribed to ${this.zones.size} zone(s)`);
        this.status.set_status("Connected", false);
        changed = true;
      } else if (response === "Changed") {
        if (msg.zones_removed) {
          for (const id of msg.zones_removed) {
            this.zones.delete(id);
          }
          changed = true;
        }
        if (msg.zones_added) {
          for (const zone of msg.zones_added) {
            this.zones.set(zone.zone_id, zone);
          }
          changed = true;
        }
        if (msg.zones_changed) {
          for (const zone of msg.zones_changed) {
            this.zones.set(zone.zone_id, zone);
          }
          changed = true;
        }
        if (msg.zones_seek_changed) {
          for (const update of msg.zones_seek_changed) {
            const zone = this.zones.get(update.zone_id);
            if (zone) {
              if (zone.now_playing) {
                zone.now_playing.seek_position = update.seek_position;
              }
              zone.queue_time_remaining = update.queue_time_remaining;
            }
            // Lightweight per-zone seek tick so the DeferredPlayer can track
            // track progress event-driven (to tell a natural track-end from a
            // manual skip). Deliberately NOT "zones-changed": SSE/state
            // consumers must not be spammed at ~1Hz by seek-only updates.
            this.emit("zone-seek", update.zone_id);
          }
        }
      }
      if (changed) this.emit("zones-changed");
    });
  }

  private getTransportUnsafe(): RoonApiTransport | null {
    if (!this.core) return null;
    return this.core.services.RoonApiTransport as RoonApiTransport | undefined ?? null;
  }

  getTransport(): RoonApiTransport {
    const transport = this.getTransportUnsafe();
    if (!transport) {
      throw new Error(
        "Not connected to Roon. Please approve the extension in Roon Settings > Extensions.",
      );
    }
    return transport;
  }

  private getBrowseUnsafe(): RoonApiBrowse | null {
    if (!this.core) return null;
    return this.core.services.RoonApiBrowse as RoonApiBrowse | undefined ?? null;
  }

  getBrowse(): RoonApiBrowse {
    const browse = this.getBrowseUnsafe();
    if (!browse) {
      throw new Error(
        "Not connected to Roon. Please approve the extension in Roon Settings > Extensions.",
      );
    }
    return browse;
  }

  isConnected(): boolean {
    return this.core !== null;
  }

  getZones(): Zone[] {
    return Array.from(this.zones.values());
  }

  findZone(nameOrId: string): Zone | null {
    // Try exact zone_id match first
    const byId = this.zones.get(nameOrId);
    if (byId) return byId;

    // Try case-insensitive display_name match
    const lower = nameOrId.toLowerCase();
    for (const zone of this.zones.values()) {
      if (zone.display_name.toLowerCase() === lower) return zone;
    }

    // Try partial match
    for (const zone of this.zones.values()) {
      if (zone.display_name.toLowerCase().includes(lower)) return zone;
    }

    return null;
  }

  findZoneOrThrow(nameOrId: string): Zone {
    // Fall back to default zone when nameOrId is empty/unspecified
    const target = nameOrId?.trim() || this.defaultZone;
    if (!target) {
      const available = this.getZones()
        .map((z) => z.display_name)
        .join(", ");
      throw new Error(
        `No zone specified and no default zone is set. Use set_default_zone to configure one. Available: ${available || "(none - is Roon paired?)"}`,
      );
    }
    const zone = this.findZone(target);
    if (!zone) {
      const available = this.getZones()
        .map((z) => z.display_name)
        .join(", ");
      throw new Error(
        `Zone '${target}' not found. Available zones: ${available || "(none - is Roon paired?)"}`,
      );
    }
    return zone;
  }

  getDefaultZone(): string {
    return this.defaultZone;
  }

  /**
   * Read a one-shot snapshot of a zone's queue via subscribe_queue, then
   * immediately unsubscribe. Returns the QueueItems (each carrying a stable
   * queue_item_id). Shared by get_queue, the queue-edit verification step,
   * and the monitor state read.
   */
  getQueueSnapshot(zone: Zone, maxItems = 200, timeoutMs = 5000): Promise<QueueItem[]> {
    const transport = this.getTransport();
    return new Promise<QueueItem[]>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Queue request timed out"));
      }, timeoutMs);

      const sub = transport.subscribe_queue(zone, maxItems, (response, msg) => {
        if (response === "Subscribed") {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(msg.items || []);
          try { sub.unsubscribe(); } catch { /* ignore */ }
        }
      });
    });
  }

  /**
   * Jump playback to a specific queued item by its stable queue_item_id.
   * Thin promise wrapper over the native transport play_from_here.
   */
  playFromHere(zone: Zone, queueItemId: number): Promise<void> {
    const transport = this.getTransport();
    return new Promise<void>((resolve, reject) => {
      transport.play_from_here(zone, queueItemId, (error: false | string) => {
        if (error) reject(new Error(String(error)));
        else resolve();
      });
    });
  }

  /**
   * Transfer playback (current track + queue) from one zone to another. Thin
   * promise wrapper over the native transport transfer_zone, which the bridge
   * had not previously surfaced.
   */
  transferZone(from: Zone, to: Zone): Promise<void> {
    const transport = this.getTransport();
    return new Promise<void>((resolve, reject) => {
      transport.transfer_zone(from, to, (error: false | string) => {
        if (error) reject(new Error(String(error)));
        else resolve();
      });
    });
  }

  /**
   * Group the given outputs into one synchronized zone (the first output's
   * zone's queue is preserved). Native transport group_outputs, not previously
   * surfaced by the bridge.
   */
  groupOutputs(outputs: Output[]): Promise<void> {
    const transport = this.getTransport();
    return new Promise<void>((resolve, reject) => {
      transport.group_outputs(outputs, (error: false | string) => {
        if (error) reject(new Error(String(error)));
        else resolve();
      });
    });
  }

  /** Ungroup previously-grouped outputs. Native transport ungroup_outputs. */
  ungroupOutputs(outputs: Output[]): Promise<void> {
    const transport = this.getTransport();
    return new Promise<void>((resolve, reject) => {
      transport.ungroup_outputs(outputs, (error: false | string) => {
        if (error) reject(new Error(String(error)));
        else resolve();
      });
    });
  }

  setDefaultZone(nameOrId: string): string {
    // Verify it actually exists before saving
    const zone = this.findZone(nameOrId);
    if (!zone) {
      const available = this.getZones()
        .map((z) => z.display_name)
        .join(", ");
      throw new Error(
        `Zone '${nameOrId}' not found. Available zones: ${available || "(none - is Roon paired?)"}`,
      );
    }
    this.defaultZone = zone.display_name;
    saveConfig({ defaultZone: this.defaultZone });
    console.error(`[roon-bridge] Default zone set to: "${this.defaultZone}"`);
    return zone.display_name;
  }
}

export const roonConnection = new RoonConnection();
