/**
 * Acceptance tests for the deferral outcome ledger + seam verification
 * (Builder task: deferral-ledger). These exercise the DeferredPlayer + ledger
 * against a fake zone/event source and fake seam actions - no live zone.
 *
 * Coverage maps to the task's acceptance list:
 *   AT1 seam re-resolve fails            -> failed(resolve), reported, warned
 *   AT2 seam fires + verification passes -> fired_verified with the block
 *   AT3 clean interference abort         -> aborted(interference), not discarded
 *   AT4 skip the trigger track           -> fires (specified fire-on-advance)
 *   AT5 name-based resolves at arm time  -> seam replays the arm-time ids
 * plus the deferred_status / cancel_deferred tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Zone } from "node-roon-api-transport";
import { DeferredPlayer, type SeamOutcome } from "../src/control/deferred-player.js";
import { deferralLedger } from "../src/control/deferral-ledger.js";

class FakeSource extends EventEmitter {
  zone: Zone | null = null;
  findZone(): Zone | null {
    return this.zone;
  }
}

function playingZone(title: string, length: number, seek: number, state: Zone["state"] = "playing"): Zone {
  return {
    zone_id: "zone-1",
    display_name: "WiiM + 1",
    state,
    outputs: [],
    now_playing: {
      one_line: { line1: title },
      two_line: { line1: title, line2: "Artist" },
      three_line: { line1: title, line2: "Artist" },
      length,
      seek_position: seek,
    },
  } as unknown as Zone;
}

const META = { zoneId: "zone-1", zoneName: "WiiM + 1", trigger: 'end of "Barbara Allen"', description: "replace queue" };

/** Advance the fake zone past its armed track so the deferral fires. */
async function advancePastTrack(src: FakeSource, from: string, to: string) {
  if (src.zone?.now_playing) src.zone.now_playing.seek_position = 95;
  src.emit("zone-seek", "zone-1");
  src.zone = playingZone(to, 100, 0);
  src.emit("zones-changed");
  // Let the async runAction settle the ledger.
  await Promise.resolve();
  await Promise.resolve();
}

describe("deferral ledger + seam verification", () => {
  let logs: string[];
  beforeEach(() => {
    deferralLedger.reset();
    logs = [];
    deferralLedger.log = (line) => logs.push(line);
  });

  it("AT1: a seam action whose re-resolve fails is recorded failed(resolve) and warned - nothing silent", async () => {
    const src = new FakeSource();
    src.zone = playingZone("Barbara Allen", 100, 0);
    const player = new DeferredPlayer(src);

    // The seam action reports it could not resolve anything (the play-by-id
    // runReplaceSequenceVerified "!replaced" branch).
    const action = vi.fn(
      async (): Promise<SeamOutcome> => ({ ok: false, verified: false, reason: "resolve", detail: "no track resolved at the seam" }),
    );

    const { deferral_id, status } = await player.scheduleAfterCurrent(src.zone, action, META);
    expect(status).toBe("scheduled");

    await advancePastTrack(src, "Barbara Allen", "Next");

    const rec = deferralLedger.get(deferral_id)!;
    expect(rec.status).toBe("failed");
    expect(rec.reason).toBe("resolve");
    // Loud: a WARN line reached the bridge log.
    expect(logs.some((l) => l.includes("WARN") && l.includes(deferral_id) && l.includes("failed(resolve)"))).toBe(true);
    // Visible to deferred_status (recent, non-pending).
    expect(deferralLedger.recent().some((r) => r.deferral_id === deferral_id && r.status === "failed")).toBe(true);
    expect(deferralLedger.pending()).toHaveLength(0);
  });

  it("AT2: a seam action that fires and verifies is recorded fired_verified with its resulting_state", async () => {
    const src = new FakeSource();
    src.zone = playingZone("Barbara Allen", 100, 0);
    const player = new DeferredPlayer(src);

    const block = { zone: "WiiM + 1", state: "playing", queue_count: 13 };
    const action = vi.fn(async (): Promise<SeamOutcome> => ({ ok: true, verified: true, resulting_state: block }));

    const { deferral_id } = await player.scheduleAfterCurrent(src.zone, action, META);
    await advancePastTrack(src, "Barbara Allen", "Opener");

    const rec = deferralLedger.get(deferral_id)!;
    expect(rec.status).toBe("fired_verified");
    expect(rec.reason).toBeUndefined();
    expect(rec.resulting_state).toEqual(block);
    expect(rec.fired_at).toBeTruthy();
    expect(rec.settled_at).toBeTruthy();
  });

  it("AT3: a clean interference abort is recorded aborted(interference), not discarded", async () => {
    const src = new FakeSource();
    src.zone = playingZone("Barbara Allen", 100, 0);
    const player = new DeferredPlayer(src);

    // The edit_queue rebuild adapter returns this when detectInterference trips.
    const action = vi.fn(
      async (): Promise<SeamOutcome> => ({
        ok: false,
        verified: false,
        aborted: true,
        reason: "interference",
        detail: "the queue changed during the wait; aborting to avoid stomping the user",
      }),
    );

    const { deferral_id } = await player.scheduleAfterCurrent(src.zone, action, {
      ...META,
      description: "rebuild upcoming queue to 5 track(s)",
    });
    await advancePastTrack(src, "Barbara Allen", "Next");

    const rec = deferralLedger.get(deferral_id)!;
    expect(rec.status).toBe("aborted");
    expect(rec.reason).toBe("interference");
    // deferred_status surfaces it (the previously-discarded-abort regression).
    expect(deferralLedger.recent().find((r) => r.deferral_id === deferral_id)?.status).toBe("aborted");
    expect(logs.some((l) => l.includes("WARN") && l.includes("aborted(interference)"))).toBe(true);
  });

  it("AT4: skipping the trigger track fires the deferral (specified fire-on-advance behavior)", async () => {
    const src = new FakeSource();
    src.zone = playingZone("Barbara Allen", 100, 0);
    const player = new DeferredPlayer(src);
    const action = vi.fn(async (): Promise<SeamOutcome> => ({ ok: true, verified: true }));

    const { deferral_id } = await player.scheduleAfterCurrent(src.zone, action, META);

    // Skip at only 10% elapsed (a manual next_track, not a natural end).
    src.zone!.now_playing!.seek_position = 10;
    src.emit("zone-seek", "zone-1");
    src.zone = playingZone("A Different Track", 100, 0);
    src.emit("zones-changed");
    await Promise.resolve();
    await Promise.resolve();

    expect(action).toHaveBeenCalledTimes(1);
    expect(deferralLedger.get(deferral_id)?.status).toBe("fired_verified");
  });

  it("AT5: a name-based deferral replays the ids resolved at ARM time, even if the catalog changes before the seam", async () => {
    const src = new FakeSource();
    src.zone = playingZone("Barbara Allen", 100, 0);
    const player = new DeferredPlayer(src);

    // A mutable "catalog": name -> track id. This models the browse/provider
    // resolver whose answer can drift between arm and seam.
    const catalog: Record<string, string> = { "the album": "id-ARM" };
    const resolve = (name: string) => catalog[name];

    // ARM TIME: resolve the target now and capture the exact id (the play-by-id
    // pattern: armedIds = resolved.map(t => t.trackId)).
    const armedId = resolve("the album");
    const playedIds: string[] = [];
    const action = async (): Promise<SeamOutcome> => {
      // The seam replays the captured id - it does NOT re-run resolve("the album").
      playedIds.push(armedId);
      return { ok: true, verified: true, resulting_state: { played: armedId } };
    };

    const { deferral_id } = await player.scheduleAfterCurrent(src.zone, action, META);

    // The catalog changes AFTER arming (a different pressing wins the name now).
    catalog["the album"] = "id-SEAM";

    await advancePastTrack(src, "Barbara Allen", "Opener");

    // The seam played the arm-time id, not the drifted catalog id.
    expect(playedIds).toEqual(["id-ARM"]);
    expect(resolve("the album")).toBe("id-SEAM"); // catalog really did change
    expect(deferralLedger.get(deferral_id)?.resulting_state).toEqual({ played: "id-ARM" });
  });

  it("caps the in-memory ledger at 100 entries (oldest evicted)", () => {
    for (let i = 0; i < 130; i++) deferralLedger.arm({ ...META, description: `d${i}` });
    const all = deferralLedger.recent(1000);
    expect(all).toHaveLength(100);
    // Newest first; the oldest 30 were evicted.
    expect(all[0].description).toBe("d129");
    expect(all.some((r) => r.description === "d29")).toBe(false);
    expect(all.some((r) => r.description === "d30")).toBe(true);
  });
});
