declare module "node-roon-api-browse" {
  import type { RoonCore } from "node-roon-api";

  export interface BrowseList {
    title: string;
    count: number;
    subtitle?: string;
    image_key?: string;
    level: number;
    display_offset?: number;
    hint?: "action_list" | null;
  }

  export interface BrowseItem {
    title: string;
    subtitle?: string;
    image_key?: string;
    item_key?: string;
    hint?: "action" | "action_list" | "list" | "header" | null;
    input_prompt?: {
      prompt: string;
      action: string;
      value?: string;
      is_password: boolean;
    };
  }

  export interface BrowseResult {
    action: "message" | "none" | "list" | "replace_item" | "remove_item";
    item?: BrowseItem;
    list?: BrowseList;
    message?: string;
    is_error?: boolean;
  }

  export interface LoadResult {
    items: BrowseItem[];
    offset: number;
    list: BrowseList;
  }

  export interface BrowseOptions {
    hierarchy: string;
    multi_session_key?: string;
    item_key?: string;
    input?: string;
    zone_or_output_id?: string;
    pop_all?: boolean;
    pop_levels?: number;
    refresh_list?: boolean;
    set_display_offset?: number;
  }

  export interface LoadOptions {
    hierarchy: string;
    multi_session_key?: string;
    level?: number;
    offset?: number;
    count?: number;
    set_display_offset?: number;
  }

  export type BrowseCallback = (error: false | string, body: BrowseResult) => void;
  export type LoadCallback = (error: false | string, body: LoadResult) => void;

  class RoonApiBrowse {
    constructor(core: RoonCore);
    static services: Array<{ name: string }>;
    browse(opts: BrowseOptions, cb?: BrowseCallback): void;
    load(opts: LoadOptions, cb?: LoadCallback): void;
  }

  export default RoonApiBrowse;
}
