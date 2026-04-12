declare module "node-roon-api-transport" {
  import type { RoonCore } from "node-roon-api";

  export interface NowPlaying {
    seek_position?: number;
    length?: number;
    image_key?: string;
    one_line: { line1: string };
    two_line: { line1: string; line2?: string };
    three_line: { line1: string; line2?: string; line3?: string };
  }

  export interface ZoneSettings {
    loop: "loop" | "loop_one" | "disabled";
    shuffle: boolean;
    auto_radio: boolean;
  }

  export interface Volume {
    type: "number" | "db" | "incremental";
    min?: number;
    max?: number;
    value?: number;
    step?: number;
    is_muted?: boolean;
  }

  export interface Output {
    output_id: string;
    zone_id: string;
    display_name: string;
    state: "playing" | "paused" | "loading" | "stopped";
    volume?: Volume;
    source_controls?: Array<{
      display_name: string;
      status: "selected" | "deselected" | "standby" | "indeterminate";
      supports_standby: boolean;
    }>;
  }

  export interface Zone {
    zone_id: string;
    display_name: string;
    outputs: Output[];
    state: "playing" | "paused" | "loading" | "stopped";
    seek_position?: number;
    is_previous_allowed: boolean;
    is_next_allowed: boolean;
    is_pause_allowed: boolean;
    is_play_allowed: boolean;
    is_seek_allowed: boolean;
    queue_items_remaining?: number;
    queue_time_remaining?: number;
    settings?: ZoneSettings;
    now_playing?: NowPlaying;
  }

  export interface QueueItem {
    queue_item_id: number;
    length?: number;
    image_key?: string;
    one_line: { line1: string };
    two_line: { line1: string; line2?: string };
    three_line: { line1: string; line2?: string; line3?: string };
  }

  export type ResultCallback = (error: false | string) => void;
  export type ZonesCallback = (error: false | string, body?: { zones: Zone[] }) => void;

  export type SubscribeZonesResponse = "Subscribed" | "Changed" | "Unsubscribed";

  export interface SubscribeZonesMessage {
    zones?: Zone[];
    zones_added?: Zone[];
    zones_removed?: string[];
    zones_changed?: Zone[];
    zones_seek_changed?: Array<{
      zone_id: string;
      seek_position: number;
      queue_time_remaining: number;
    }>;
  }

  export type SubscribeZonesCallback = (
    response: SubscribeZonesResponse,
    msg: SubscribeZonesMessage,
  ) => void;

  class RoonApiTransport {
    constructor(core: RoonCore);
    static services: Array<{ name: string }>;
    _zones?: Record<string, Zone>;
    control(
      zone: Zone | Output | string,
      control: "play" | "pause" | "playpause" | "stop" | "previous" | "next",
      cb?: ResultCallback,
    ): void;
    seek(
      zone: Zone | Output | string,
      how: "relative" | "absolute",
      seconds: number,
      cb?: ResultCallback,
    ): void;
    change_volume(
      output: Output | string,
      how: "absolute" | "relative" | "relative_step",
      value: number,
      cb?: ResultCallback,
    ): void;
    mute(output: Output | string, how: "mute" | "unmute", cb?: ResultCallback): void;
    change_settings(
      zone: Zone | Output | string,
      settings: { shuffle?: boolean; auto_radio?: boolean; loop?: string },
      cb?: ResultCallback,
    ): void;
    get_zones(cb: ZonesCallback): void;
    subscribe_zones(cb: SubscribeZonesCallback): void;
    subscribe_queue(
      zone_or_output: Zone | Output | string,
      max_item_count: number,
      cb: (response: string, msg: { items?: QueueItem[]; changes?: unknown }) => void,
    ): { unsubscribe(): void };
    zone_by_zone_id(zone_id: string): Zone | null;
    zone_by_output_id(output_id: string): Zone | null;
  }

  export default RoonApiTransport;
}
