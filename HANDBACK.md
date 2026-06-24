# Handback: BUG D - queue_by_id / queue_tracks fail on a two-action "(Album)" disambiguation

**Branch:** `builder/album-action-fix` · **Worktree:** `~/dev/roon-bridge-worktrees/album-action-fix`
**Ticket:** `~/.agents/Maya/state/ticket-roon-bridge-album-action-disambiguation-2026-06-24.md`
**Status:** built, tsc-clean, full suite green (267 pass, +3 over the 264 baseline; 2 pre-existing skips).
NOT deployed, NOT merged, NOT restarted. Maya deploys and live-verifies.

Built by Builder-album-action-fix.

## The defect

`queue_by_id {track_id: "121053082"}` (Heart Cooks Brain, Modest Mouse / The Lonesome Crowded West)
resolved the right row, then returned `error: "no_action"` with
`available_actions: ["Heart Cooks Brain (Album)", "Heart Cooks Brain"]`. Hit 12 of 15 LCW tracks;
single-action tracks (e.g. "Doin' the Cockroach") queued fine. `queue_tracks` failed the same way
(`count_queued: 0`). Album-level `add_to_queue category=album` / `play_album` were unaffected.

## Root cause

When the resolver drills the pinned track row, Roon does not always return the action verbs
(Play Now / Add Next / Queue) directly. For these tracks it returns a TWO-ITEM disambiguation - the
album-context item "X (Album)" and the standalone item "X" - each a navigable child leading to its own
action list. `drillToActions` only descended when exactly ONE navigable child existed
(`if (navigable.length !== 1) break;`), so it stopped on the two-item case and handed the two
disambiguation items to `resolveActionItem`, which found no queue verb among them -> `no_action`.

## The fix (`src/tools/play-by-id.ts`)

`drillToActions` now takes `opts: { expectedTitle?, preferAlbumContext? }`. When the drill yields
multiple navigable children, `selectSameRecordingItem` checks whether EVERY child reduces to the same
recording as `expectedTitle` (via `recordingKey`: strips Roon links, a leading track-number prefix, and
ONLY the trailing `(Album|Single|EP)` context tag - deliberately preserving any `(Live ...)` qualifier so
a genuine live/studio split fails the match). If so, it deterministically selects the album-context item
(`preferAlbumContext`, true when the track has an album) and descends into it to read the real action
list. If the children are NOT the same recording, it returns undefined and the old behavior stands - no
guessing among different recordings (per the determinism directive). Both callsites
(`executeAndVerify` for queue_by_id, `resolveOneForBatch` for queue_tracks) pass
`{ expectedTitle: meta.title, preferAlbumContext: !!meta.album }`.

## Tests (`tests/queue-by-id-album-action.test.ts`, new file)

Mocks the real two-action Roon shape: drilling the resolved track row returns the
`["Heart Cooks Brain (Album)", "Heart Cooks Brain"]` navigable disambiguation; only the album-context
child reveals the action verbs. A second track ("Doin' the Cockroach") drills straight to verbs
(single-action control).

- `queue_by_id queues a track whose Roon row drills to the '(Album)' two-item disambiguation` -
  asserts ok, and that the ALBUM-context item (`act:queue:hcb`) was executed, not the standalone single.
- `queue_by_id queues a single-action control track` - single-action path still works.
- `queue_tracks queues a two-action track and a single-action track together` - `count_queued: 2`,
  every track ok.

**Failing-first verified:** against pre-fix `src/tools/play-by-id.ts` (stashed), the two two-action tests
FAIL with the `no_action` shape (`count_queued: 0`); the single-action control passes (the bug never
affected it). With the fix all three pass. The pre-existing 264-test suite never reproduced the
multi-action shape - its mocks drilled straight to action verbs - which is why the bug shipped green.

## How verified

- `./node_modules/.bin/tsc --noEmit` -> exit 0 (clean).
- `./node_modules/.bin/vitest run tests/queue-by-id-album-action.test.ts` -> 3 passed.
- Stash the source fix, re-run -> 2 failed / 1 passed (failing-first confirmed); pop.
- `./node_modules/.bin/vitest run` (full) -> 30 files passed, 1 skipped; 267 passed, 2 skipped.

## Not done / for Maya

- Live-verify on the WiiM + 1 zone: `queue_by_id 121053082` (and a couple more LCW tracks) must queue,
  and a `queue_tracks` batch of LCW tracks must land contiguous and in order. The mock proves the logic;
  only the real bridge proves the Roon action shape was read correctly.
- Deploy + restart :3100 is Maya's (handoff note: start extensions after the Core library scan settles).
