# Handback: curation reliability - 3 live-only queueing failures (2026-06-20, round 2)

**Branch:** `builder/queue-tracks-batch` · **Worktree:** `~/dev/roon-bridge-worktrees/queue-tracks-batch`
**Ticket:** `~/.agents/Maya/state/ticket-roon-bridge-curation-reliability-3bugs-2026-06-20.md`
(refs the queue-tracks-batch ticket BUG 1 = BUG B here, and the exact-id-resolver ticket = BUG A here)
**Status:** built, tsc-clean, full suite green. NOT deployed, NOT merged. Maya PM-reviews, runs the live
re-check below in an away-window, then merges.

Built by Builder-curation-reliability. Commits on the branch (this round):
- `2650eef` fix(queue-by-id/queue_tracks): pin exact recording + settle-aware verify (BUG A, BUG B)
- `fe72958` fix(add_to_queue): verify the whole album landed; honest under-add count (BUG C)

All three failures passed the 256-test mock suite and surfaced only against the real Roon bridge. The
mocks were too forgiving. Each fix lands a FAILING-FIRST adversarial fixture into the STANDARD `npm
test` suite (verified failing on pre-fix source, green after), so a regression is caught automatically.

## Test counts

- Before (baseline this round): **256 pass / 2 skip** (26 files).
- After: **264 pass / 2 skip** (29 files). Net **+8** new tests, no regressions, `tsc --noEmit` clean.
- New files: `tests/queue-by-id-recording.test.ts` (4, BUG A), `tests/queue-tracks-large-replace.test.ts`
  (2, BUG B), `tests/add-to-queue-album.test.ts` (2, BUG C).
- Fail-first proof: stashing the source fix and re-running shows the new tests RED (BUG A 4/4, BUG B
  drop-case, BUG C 2/2); restoring the fix makes them green.

## Root causes + fixes

### BUG A - "exact by ID" silently queued a live/alt recording (production: queue_by_id + queue_tracks)
**Root cause.** `resolveRoonRow` -> `pickTrackRow` (`src/tools/search-core.ts`) selected a Roon row by
NORMALIZED title + artist. `normalizeTitle` deliberately strips bracketed qualifiers, so "New Girl
(Live at The Crocodile)" collapses to "new girl" - identical to the studio cut. When Roon's
track-search surfaced only/first the live sibling, it passed as an exact, *unambiguous* match and was
queued, while the return reported the provider's intended studio title (a silent title/recording
mismatch - what hid the bug).
**Fix.** `pickTrackRow` now pins on live/studio character: `identityWantsLive(target)` derives whether
the provider id denotes a live take (from its title/version); rows whose `classifyVariant().is_live`
differs are dropped. If none match (e.g. only a live row exists for a studio id), it returns undefined
so the caller falls back to the album anchor or FAILS honestly (`track_not_in_album`) instead of
substituting. `TrackIdentity` carries `version`/`durationSec`. `executeAndVerify`
(`src/tools/play-by-id.ts`) reads back the ACTUAL landed row title (`queued_title` in the return) and
returns `wrong_recording_queued` if a live/studio mismatch lands. The return now reflects reality, not
the intended title.

### BUG B - large-queue replace dropped tracks while reporting order_verified=true (queue_tracks/play_tracks `now`)
**Root cause.** `verifyBlock` (`src/tools/play-by-id.ts`) broke out of its verify poll the instant it
saw `newRows.length >= resolved.length`. For a `now` replace the before-snapshot is skipped, so
`beforeIds` is empty and EVERY row counts as "new"; on a large existing queue (~38 items) that
condition is true on the FIRST snapshot, read while Roon was still draining+rebuilding (~9.7s settle).
A transient snapshot that briefly held all 5 tracks read as success before the queue collapsed to 2 -
`order_verified` was a false positive. Small queues settle instantly, so they never reproduced it.
**Fix.** New shared `waitForStableQueue` (`src/tools/search-core.ts`) polls until the queue SETTLES
(identical length + item ids across a 300ms quiet window, 12s deadline) before judging. `verifyBlock`
then counts the block off the SETTLED queue: for `now`/head anchor it counts a contiguous, in-order run
from the head (beforeIds is meaningless there); for `next`/`queue` it keeps the before/after new-id
diff. `count_queued`/`order_verified` now reflect what actually landed; a real drop reports `ok=false`
with the true count.

### BUG C - album-add under-filled to a single track (add_to_queue category='album')
**Root cause.** `add_to_queue category='album'` went through the generic `searchAndPlay`, whose queue
verify (`src/tools/browse.ts` step 7c) only checks the queue grew by >= 1 item, then claims success. An
album-level Queue action that under-commits (1 of ~11 landed, live 2026-06-20) therefore read as
success, and the return reported no count.
**Fix.** A dedicated `queueAlbum` path (mirroring the existing `queueArtist` pattern): resolve the album
(scored, variants penalized), read the album's real track count from its page (track rows, with a
one-level descent into the content listing and a `list.count` fallback for the popup shape), snapshot,
queue the whole album, then `waitForStableQueue` and report the ACTUAL `tracks_added`. Returns the full
album (`ok=true`, `tracks_added`/`tracks_expected`) or an honest under-add (`ok=false`,
`album_under_added`, the count, the resolved album title). `add_to_queue` routes `category='album'` here;
the tool description states the guarantee. Note: when Roon returns only an album action-popup with no
reachable track listing, `tracks_expected` is unknown and the path is best-effort (success on any
growth) - the live re-check below exercises the real shape.

## Live re-check script for Maya (away-window, WiiM + 1, real bridge on :3100)

Deploy the branch build (overlay + kickstart, full backup), run these against real Roon while Monty is
away / muted, then REVERT to main if not merging. All assertions are read-back against `get_queue`.

1. **BUG A - studio not live.** `search_tracks "The Long Winters New Girl"` to confirm the two ids.
   `queue_by_id 48916424` -> the return's `queued_title` is "New Girl" (NO "(Live ...)"), and
   `get_queue` shows the studio 2:31 cut, not the 3:02 Crocodile live. Repeat for any same-title
   studio/live pair (e.g. the Puppets/Atmosphere case). A pinned-but-unavailable studio cut must FAIL
   (`track_not_in_album` / honest error), never substitute a live take.
2. **BUG A - the Bride And Bridle id.** `queue_by_id 48916419` should land the studio album track or
   fail honestly - not silently queue a sibling.
3. **BUG B - large-queue replace.** Build a large queue (~30-40 items), then `play_tracks` with 5 known
   studio ids replacing it. The return's `count_queued` must equal what `get_queue` actually holds after
   it settles (poll `get_queue` a few seconds later); `order_verified=true` ONLY if all 5 are contiguous
   from the head. Confirm no silent drop. Re-run the clean small-queue 3- and 5-track replaces (should
   still be perfect).
4. **BUG C - album add.** `add_to_queue query="The Long Winters When I Pretend To Fall" category="album"`
   -> return reports `tracks_added` == the album's real length and `ok=true`; `get_queue` shows the whole
   album. Re-run the three albums that worked before (The Worst You Can Do Is Harm, Ultimatum, Putting
   The Days To Bed) - each should report its full count, not a partial.

## Not done / notes

- Live/audible verification is left to Maya + Monty (mock/unit-verified only here). The Roon-execution
  half (real browse ranking, real settle timing, real album-page shape) is exactly what differs from
  mocks - hence the live re-check above.
- BUG C `tracks_expected` is best-effort when Roon yields an album action-popup with no reachable track
  listing; in that case the path reports the count it added and succeeds on any growth. If the live
  re-check shows that shape, a follow-up could resolve the album's length via the provider (Qobuz album
  id) instead of the Roon page.
- No new tools, no schema/behavior changes to the working `queue_tracks` modes; BUG B only hardened the
  post-action verify. The existing queue-tracks suite stays green.

---

# Handback: queue_tracks / play_tracks - ordered, race-free batch enqueue

**Branch:** `builder/queue-tracks-batch` · **Worktree:** `~/dev/roon-bridge-worktrees/queue-tracks-batch`
**Ticket:** `~/.agents/Maya/state/ticket-roon-bridge-queue-tracks-batch-2026-06-20.md`
**Status:** built, tsc-clean, full suite green. NOT deployed, NOT merged. Maya PM-reviews, live-verifies on WiiM + 1 with Monty, then merges.

Built by Builder-queue-tracks. Commits on the branch:
- `efb5846` refactor(deferred-player): single shared instance across tools
- `81390aa` feat(queue_tracks/play_tracks): ordered batch enqueue + robust add-verify

---

## What shipped

1. **`queue_tracks`** and **`play_tracks`** in `src/tools/play-by-id.ts`. Args:
   `track_ids: string[]` (ordered, min 1), `provider`, `zone`, `when`.
   - `queue_tracks` default `when='next'`; `play_tracks` default `when='now'`.
   - Modes: `queue` (append all to tail, in order), `next` (place set right after current),
     `now` (replace queue, play from first), `after_current` (deferred replace at the track seam).
   - Reuses the exact-ID resolver (`resolveRoonRow` / `drillToActions`) from `queue_by_id` and the
     `DeferredPlayer` seam machinery for `after_current`.
2. **Honest per-track status.** Return shape:
   `{ ok, when, zone, count_requested, count_queued, order_verified, contiguous, anchor_ok, block_first_position, strategy, tracks: [{index, track_id, ok, title, artist, album, resolved_via, unambiguous, reason?}] }`.
   A track that fails to resolve is flagged with its index + reason; the rest still queue in correct
   relative order (best-effort). Nothing is silently dropped.
3. **Built-in verification** (`verifyBlock`): re-reads the queue, locates the added block by
   queue_item_ids absent from the before-snapshot, and asserts it is contiguous + in order at the
   expected anchor (head for `now`, after-current for `next`-reverse, tail otherwise). Robust to a
   concurrent natural advance (the consumed head never hides the block).
4. **Shared `DeferredPlayer` instance** (`src/control/deferred-player-instance.ts`): one scheduler for
   browse.ts and play-by-id.ts, so an immediate play from any tool supersedes any armed deferral.
5. **Item 7 fix** (`queue_by_id` add-verify): now also treats a now-playing flip to the added title
   as success. See root cause below.

---

## The order-guarantee mechanism, and why it beats reverse-next

Roon exposes only three queue mutators to an extension (confirmed in `queue.ts` and the transport
type): **Add Next** (insert immediately after the current track, LIFO), **Queue** (append to the
tail), and **play_from_here** (jump). There is no insert-at-position and no move.

The set's internal order is built from the ONE race-free, forward-ordered primitive: **append-to-tail**.
Each `Queue` action appends after the previous one, and a track boundary never reorders the tail, so a
forward loop `id1..idN` always lands `[..., id1, id2, ..., idN]` contiguous and in order. Positioning
is then layered on top per `when`:

| when | mechanism | result |
|------|-----------|--------|
| `queue` | append block to tail | `[cur, ...prior, block]` |
| `now` | Play Now id1 (replaces queue) + append id2..idN to tail | `[block]`, plays id1 |
| `after_current` | arm DeferredPlayer; at the real seam, re-resolve fresh + run the now-sequence | `[block]` after cur ends, prior discarded |
| `next` | see below | `[cur, block, ...prior]` |

This beats Maya's 2026-06-20 reverse-next because reverse-next inserts N times at the moving anchor
"immediately after current"; if the current track ends mid-burst the anchor jumps and the set
scrambles (what pulled "Waiting Room" to the front). Append-to-tail has no moving anchor.

### The `next` case + the spec tension I had to resolve (flag for Maya)

`next` is the one mode append-to-tail cannot position alone: `[cur, block, ...prior]` requires
inserting BETWEEN the current track and the already-queued upcoming items, and Roon's only
after-current primitive is Add Next (LIFO), so a forward set needs **reverse** Add Next calls.

**This is a genuine internal contradiction in the ticket:** item 3 says the implementation "MUST NOT
be N independent `when='next'` inserts" and offers "(a) append to tail + a single jump"; but
acceptance A requires `[current, id1..id5, ...prior]`, which append-to-tail + jump cannot produce
(a jump via `play_from_here` discards everything before the landing item, i.e. cuts current and
drops prior). The only Roon mechanism that yields acceptance A is reverse Add Next. The two cannot
both be satisfied.

Resolution I shipped (please confirm or redirect):
- **upcoming queue empty** (the set-building case Maya actually hit): forward append-to-tail IS
  `[cur, block]`. Race-free, no reverse.
- **prior present + current track has >= 8s left** (`SAFE_REVERSE_MS`): reverse Add Next from
  **pre-resolved** rows - a single guarded burst (resolution done up front, so it is NOT the naive
  per-call-search pattern that caused the bug), then `verifyBlock` asserts the order landed. This is
  what passes acceptance A.
- **prior present + current near its boundary**: do NOT risk a scramble; fall back to ordered
  tail-append (contiguous, in order, no reversal/split/pull-to-front) and report the anchor honestly
  via the `strategy` and `anchor_ok` fields.

I read item 3's prohibition as targeting the *racy* reverse-next, and honored its intent (no moving
anchor under a live boundary) while still meeting acceptance A in the safe window. If you'd rather
`next` NEVER use Add Next (strict literal item 3), the one-line change is to make the
`priorCount > 0` branch always tail-append; acceptance A would then become "block appended in order
after the existing upcoming items" and you'd steer "play this set instead of what's up next" to
`now`/`after_current`. Your call.

---

## The race test (acceptance B) - result

**Honesty note:** I did NOT run the adversarial seek-near-end test on the LIVE bridge - the ticket
forbids disruptive sound and the living room was in active morning use. B was exercised against the
unit mock, and the near-boundary path is handled by the strategy branch above. The TRUE audible B is
in the live-check script for Maya + Monty below.

Unit result, verbatim (`npx vitest run tests/queue-tracks.test.ts tests/queue-verify-advance.test.ts --reporter=verbose`):

```
 ✓ tests/queue-tracks.test.ts > ... > batch resolver: queues all 5 tracks in the given order (when='queue') 8ms
 ✓ tests/queue-tracks.test.ts > ... > order assertion: when='next' with prior present lands the set forward, contiguous, right after current 1ms
 ✓ tests/queue-tracks.test.ts > ... > when='next' with an empty upcoming queue places the set right after current (race-free, no reverse) 1ms
 ✓ tests/queue-tracks.test.ts > ... > play_tracks when='now' replaces the queue and plays from the first, rest in order 1ms
 ✓ tests/queue-tracks.test.ts > ... > partial failure: a bogus id is flagged by index, the rest queue in correct relative order 1ms
 ✓ tests/queue-tracks.test.ts > ... > reports no_tracks_resolved when every id fails, touching nothing 1ms
 ✓ tests/queue-tracks.test.ts > ... > when='after_current' defers the replace until the real track seam, then plays the set in order 8ms
 ✓ tests/queue-verify-advance.test.ts > ... > reports ok=true when the added 'next' track became now-playing (no net queue growth) 7ms
 ✓ tests/queue-verify-advance.test.ts > ... > still reports ok=false for a genuine no-op (queue unchanged, now-playing did NOT flip) 2589ms
 Test Files  2 passed (2)
      Tests  9 passed (9)
```

B's guarantee, stated precisely: under a boundary the tool NEVER scrambles. With ample time left it
inserts after current (verified); near a boundary it appends the block in order at the tail rather
than risk a reverse-insert race. In neither case is a track reversed, split, or pulled to the front -
that is the property to confirm audibly.

---

## queue_by_id `ok=False` root cause (item 7)

The lone `ok=False` on 2026-06-20 was a verification false-negative, not a failed add. For a
`when='next'` add, if the current track ends naturally between the action and the verifying re-read:
- Roon consumes the played head item, so the queue length need not grow (one added, one consumed).
- The just-added "next" track becomes the now-playing head, i.e. it is no longer an "upcoming" queue
  row - so the "a new queue_item_id appeared among upcoming items" check can momentarily miss it too.

The old check (`length grew OR new id present`) could therefore report a real success as a failure.
**Fix:** the add-verify now also treats **now-playing flipped to the added track's title** as success
(`src/tools/play-by-id.ts`, `executeAndVerify`). Proven by `queue-verify-advance.test.ts`: the
concurrent-advance case now returns `ok=true`, while a genuine no-op (queue unchanged AND no flip)
still returns `ok=false` (`add_not_verified`) - so the fix did not weaken verification into
always-true.

---

## Test counts

| | before (baseline) | after |
|--|--|--|
| pass | 247 | **256** |
| skip | 2 | 2 |

+9 tests: 7 in `tests/queue-tracks.test.ts` (resolver, order assertion, next/empty-prior, now,
partial failure, all-fail, after_current) and 2 in `tests/queue-verify-advance.test.ts` (item 7).
tsc clean.

---

## Live-check script for Maya + Monty (WiiM + 1) - the audible verification

Run with Monty present, during a non-disruptive window. Use real Qobuz track IDs from `search_tracks`.
Replace `ID1..ID5` with five known studio tracks (note their titles to eyeball order). Use `get_queue`
after each step to read the actual queue.

```
# Pick 5 tracks and capture IDs + titles first:
search_tracks "<artist> <title>"   # x5, note id + title for each

# A. ORDER, ample headroom (acceptance A):
#    Start something playing with >60s left. Then:
queue_tracks track_ids=[ID1,ID2,ID3,ID4,ID5] when="next" zone="WiiM + 1"
get_queue zone="WiiM + 1"
#    EXPECT: [current, ID1, ID2, ID3, ID4, ID5, ...anything already queued].
#    Titles in the exact order requested. Return: ok=true, order_verified=true, anchor_ok=true.

# B. THE RACE TEST (acceptance B):
seek <to ~5s before the end of the current track> zone="WiiM + 1"
queue_tracks track_ids=[ID1,ID2,ID3,ID4,ID5] when="next" zone="WiiM + 1"
get_queue zone="WiiM + 1"
#    EXPECT: NO reversal, NO split, NO track pulled to the front. The set is
#    contiguous and in order. The return's `strategy` field says whether it
#    inserted after current or fell back to tail-append near the boundary; either
#    way the 5 must be contiguous and in the requested order. Listen across the
#    track change: the set plays in order, none jumping ahead.

# C. after_current (acceptance C):
#    With a multi-track queue playing:
queue_tracks track_ids=[ID1,ID2,ID3,ID4,ID5] when="after_current" zone="WiiM + 1"
#    Let the current track FINISH. EXPECT: the 5 play in order; the prior queue is gone.

# D. queue (acceptance D):
queue_tracks track_ids=[ID1,ID2,ID3,ID4,ID5] when="queue" zone="WiiM + 1"
get_queue zone="WiiM + 1"
#    EXPECT: 5 appended to the tail in order; current playback undisturbed.

# E. now (acceptance E):
play_tracks track_ids=[ID1,ID2,ID3,ID4,ID5] zone="WiiM + 1"
#    EXPECT: queue replaced; ID1 plays immediately; ID2..ID5 follow in order.

# F. partial failure (acceptance F):
queue_tracks track_ids=[ID1,ID2,"0000000",ID4,ID5] when="queue" zone="WiiM + 1"
#    EXPECT return: ok=false, count_requested=5, count_queued=4, tracks[2].ok=false
#    with a reason; the other 4 queued in correct relative order. get_queue to confirm.

# G. exact-recording (acceptance G):
#    Use a same-title/two-album case (e.g. the "Puppets"/Atmosphere IDs from the
#    queue_by_id tests). Confirm the EXACT albums land (resolved_via in the return).
```

Reminder from fleet memory for the live run: WiiM + 1 grouped volume is not atomic (use mute or
>= 1s ramps, never instant bursts); default to add-to-end and do not stomp playback unless Monty
says "now"; confirm the room before putting test sound on the living-room system.

---

## What is NOT done / open

- **No live verification.** Per the ticket, all live/audible checks are Maya's with Monty. Everything
  here is unit-verified against mocks only.
- **The `next` + non-empty-prior spec tension** (above) is resolved by my best judgment but is the one
  decision that genuinely needs Maya's sign-off before merge - the only place acceptance A and item 3
  could not both be honored literally.
- **`after_current` count is a preview.** It returns `count_queued` from the pre-resolve and re-resolves
  fresh at the seam (item_keys go stale by then). The audible C check is the real proof.
- **Not deployed, not merged, not pushed.** Branch only.
