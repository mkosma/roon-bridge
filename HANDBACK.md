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
