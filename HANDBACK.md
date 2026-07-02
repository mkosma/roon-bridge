# Handback: edit_queue (delete/reorder upcoming queue via safe rebuild)

**Branch:** `builder/edit-queue` · **Worktree:** `~/dev/roon-bridge-worktrees/edit-queue`
**Ticket:** `~/.agents/Maya/state/ticket-roon-bridge-edit-queue-2026-06-18.md`
**Status:** built, unit-verified. NOT deployed, NOT merged. PM-review the diff,
re-run the suite, then live-verify the Roon-execution paths with Monty at
**WiiM + 1** before merging.

## Test suite

`npx vitest run` -> **266 passed | 2 skipped** (26 files). Baseline before this
work was 247 | 2 skipped; +19 new (`tests/edit-queue.test.ts`), no regressions.
The 2 skipped are the pre-existing `qobuz-provider.live.test.ts`. Clean `tsc`
(`npm run build`).

Note: `node_modules/` here was copied from `~/dev/roon-bridge` (git deps need
network) and is gitignored. If you re-clone the worktree, `npm install` first.

## What I built (3 commits)

1. **`feat(play-by-id)`** - in-memory queue-provenance store
   (`src/control/queue-provenance.ts`) + extracted reusable core in
   `src/tools/play-by-id.ts` (`executeIdentity` / `executeById` returning a
   structured `ExecResult`; the MCP tools just JSON-wrap it). No behavior change
   to `queue_by_id` / `play_by_id`.
2. **`feat(edit_queue)`** - the new tool (`src/tools/edit-queue.ts`) + server
   registration. Params: `delete` (queue_item_ids), `reorder` (desired order of
   the remaining upcoming ids), `zone`, `when` (`after_current` default | `now`).
3. **`test(edit_queue)`** - pure-helper + integration tests.

## The provider-id-map approach (the key design decision)

`get_queue` gives each item's stable `queue_item_id` + title/artist/album but
**no provider (Qobuz) track id**, so a rebuild can't just replay ids. So:

- **Capture at enqueue time.** When `queue_by_id` / `play_by_id` enqueue a track
  they know the provider id; after the add verifies, the new `queue_item_id` is
  recorded in `queueProvenance` as `queue_item_id -> {providerId, provider,
  title, artist, album, trackNumber}`. (Recorded only when the add introduced
  exactly one new item, so a stray radio append is never mislabeled.)
- **Replay EXACT on rebuild.** `edit_queue` looks up each edited item's
  provenance and re-queues via the deterministic `queue_by_id` path
  (`executeById`) - same recording, no re-matching, no covers.
- **Fallback, flagged.** Items with no provenance (queued by the Roon GUI, by
  name search, or before this process started) fall back to title+artist
  re-resolution (`executeIdentity` with the queue row's metadata) and are
  flagged `reresolved: true` per item, with a `reresolved_count` in the plan.

In-memory and process-lifetime only (bounded to 1000 entries, LRU). A miss is
always safe (it just takes the fallback path). This means: provenance-exact
replay works for tracks queued via `queue_by_id`/`play_by_id` in the **same**
running bridge process; otherwise the (flagged) title+artist fallback is used.

## The algorithm (Monty's design)

1. Snapshot the queue; the currently-playing track is left alone.
2. `planEditedList` (pure) computes the intended **upcoming** list: delete named
   ids, then apply `reorder` (must be a permutation of the ids remaining after
   deletion - it cannot include the now-playing track or a deleted id).
3. `when="after_current"` (default): arm the event-driven `DeferredPlayer` (the
   same after-current impl `play_track`/`play_album` use - fires on the real
   track-end event, distinguishes a natural end from a manual skip, never a
   wall-clock timer). `when="now"`: rebuild immediately.
4. At the seam: interference check (below) -> start the first edited track via
   `executeById`/`executeIdentity` with `when="now"` (replace) -> the execute
   path **validates it is actually now-playing** (`verified`) before continuing
   -> append the rest in order with `when="queue"`.
5. Re-read the queue and verify the final order matches intent (`final_match`).

## Hard requirement: abort on interference (never fight the user)

Detection, layered:

- **DeferredPlayer generation guard** - a newer `edit_queue`/play supersedes a
  pending one; a manual skip re-arms (never fires mid-track).
- **Snapshot-compare** (`detectInterference`) at fire time: the upcoming ids
  captured when armed must still be present, in the same relative order, in the
  live queue. If the user/another process removed, consumed-past, or reordered
  them, **abort**. Tolerant of the consumed head and trailing radio adds.
- **Zone-state check** - if playback is `stopped`/`paused` at fire time, abort.
- **First-track guard** - if the first edited track can't be made now-playing
  (`verified !== true`), abort before appending onto a wrong base.

Every abort logs `[roon-bridge] edit_queue abort: <reason>` and touches nothing
further. `when="now"` is treated as an explicit user action, so it skips the
wait-window interference/state guards (the window is a single read).

## Acceptance status

| Item | Status |
| --- | --- |
| Delete a mid-queue track; current plays to its end, queue continues with it gone, order intact, no mid-track cut | Built; unit-proven (now + after_current paths). **Needs live WiiM + 1 confirm.** |
| Reorder remaining tracks; final queue matches requested order | Built; unit-proven (`final_match`). **Needs live confirm.** |
| Delete the currently-playing track's successor | Built; unit-proven. **Needs live confirm.** |
| Deleting the currently-*playing* track | Documented: it keeps playing to its end, then the edited queue takes over (`deleted_playing_note`). **Needs live confirm.** |
| Interference abort (skip/pause/requeue mid-wait -> rebuild aborts, user wins) | Built; unit-proven (snapshot-compare + state + generation). **Needs live confirm** (the headline safety property). |
| Re-queued tracks are the EXACT recordings (provider-id map), not re-matched | Built; unit-proven (provenance path executes `act:*:idD` exactly; fallback flagged). **Needs live confirm** that provenance is populated in the live process. |
| No regression; re-run suite, report count | DONE - 266 \| 2, +19, no regressions. |

**What I could NOT verify (and why):** anything that EXECUTES a Roon browse
action or moves playback makes sound on the living-room system and risks a
pairing interaction with the live single bridge. Per the ticket I did not deploy
or live-test. The browse/transport mechanics reuse the already-live-proven
`queue_by_id` path and the already-live-proven `DeferredPlayer`; the new logic
(planning, interference, orchestration) is unit-tested against mocks.

## Live checks Maya must run with Monty at "WiiM + 1"

Run in a quiet moment (these move playback). Build a known queue first via
`queue_by_id` (so provenance is captured), e.g. queue 4 distinct tracks, then
`get_queue` to read their `queue_item_id`s.

1. **Delete a mid-queue track, after_current (headline).** `edit_queue
   delete:[<id of track 3>]` (default `when`). Expect `scheduled:true`. Let the
   current track finish naturally -> the deleted track is gone, the rest keep
   their order, and the current track was never cut. Confirm in Roon.
2. **Reorder, after_current.** `edit_queue reorder:[<ids in a new order>]`.
   After the seam, confirm the upcoming order matches exactly. Check the result's
   `outcome.final_match` is `true`.
3. **Delete + reorder together**, after_current. Confirm both applied.
4. **EXACT recording.** Verify a re-queued track is the same recording you
   queued (provenance), and that `plan.reresolved_count` is `0` when everything
   was queued via `queue_by_id`. Then `get_queue` a GUI-queued track and confirm
   editing it shows `reresolved:true` for that item but still lands the right song.
5. **Interference abort (the safety headline).** Start an `after_current` edit,
   then before the current track ends: (a) manually skip -> rebuild must abort,
   your skip wins; (b) repeat and pause -> abort; (c) repeat and queue something
   new -> abort. In each case nothing from the edit should be forced; check the
   logs for `edit_queue abort: <reason>`.
6. **when="now".** `edit_queue delete:[...] when:"now"` -> rebuilds immediately
   (cuts the current track). Confirm the edited queue and `outcome.final_match`.
7. **Edge cases.** Delete all upcoming -> expect `cannot_empty_queue` (refused,
   nothing touched). No-op (reorder to current order) -> `noop:true`, playback
   untouched.

This is the "tweak the queue" step of the ramp-to-silence -> edit -> ramp-up
maneuver, so step 5 (never stomping) is the one to lean on hardest in live test.

If a rebuild mis-selects a recording, the tuning point is the same browse
traversal `queue_by_id` uses (`resolveRoonRow` in `src/tools/play-by-id.ts`); if
it re-resolves something it shouldn't, check that the item's provenance was
captured (only same-process `queue_by_id`/`play_by_id` enqueues populate it).
