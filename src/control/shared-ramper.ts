/**
 * Single VolumeRamper instance shared by both control surfaces.
 *
 * The HTTP /control router (roon-key keypresses) and the MCP volume tools
 * (the Maya agent) run in the same process. They must drive ONE ramper so a
 * fade started from MCP and a keypress ramp from roon-key supersede each other
 * through the same generation counter instead of fighting over the device.
 */

import { VolumeRamper } from "./volume-ramper.js";

export const sharedRamper = new VolumeRamper();
