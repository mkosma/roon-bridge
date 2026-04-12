declare module "node-roon-api-status" {
  import type RoonApi from "node-roon-api";

  class RoonApiStatus {
    constructor(roon: RoonApi);
    services: unknown[];
    set_status(message: string, is_error: boolean): void;
  }

  export default RoonApiStatus;
}
