declare module "node-roon-api" {
  export interface RoonApiOptions {
    extension_id: string;
    display_name: string;
    display_version: string;
    publisher: string;
    email: string;
    website?: string;
    log_level?: "all" | "none";
    force_server?: boolean;
    core_paired?: (core: RoonCore) => void;
    core_unpaired?: (core: RoonCore) => void;
    core_found?: (core: RoonCore) => void;
    core_lost?: (core: RoonCore) => void;
    set_persisted_state?: (state: Record<string, unknown>) => void;
    get_persisted_state?: () => Record<string, unknown>;
  }

  export interface RoonCore {
    core_id: string;
    display_name: string;
    display_version: string;
    services: Record<string, unknown>;
    moo: unknown;
  }

  export interface WsConnectOptions {
    host: string;
    port: number;
    onclose?: () => void;
    onerror?: (moo: unknown) => void;
  }

  export interface ServiceOptions {
    required_services?: unknown[];
    optional_services?: unknown[];
    provided_services?: unknown[];
  }

  class RoonApi {
    constructor(options: RoonApiOptions);
    init_services(options: ServiceOptions): void;
    ws_connect(options: WsConnectOptions): unknown;
    start_discovery(): void;
    stop_discovery(): void;
    save_config(key: string, value: unknown): void;
    load_config(key: string): unknown;
  }

  export default RoonApi;
}
