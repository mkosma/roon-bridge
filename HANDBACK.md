# Handback: queue-by-id + richer search metadata + surfaced Roon commands

**Branch:** `builder/queue-by-id` · **Worktree:** `~/dev/roon-bridge-worktrees/queue-by-id`
**Ticket:** `~/.agents/Maya/state/ticket-roon-bridge-queue-by-id.md`
**Status:** built, unit-verified, Qobuz half live-verified. NOT deployed, NOT merged.
Do not merge until you PM-review the diff, re-run the suite, and live-verify the
Roon-execution paths with Monty at **WiiM + 1**.

## Test suite

`npx vitest run` → **247 passed | 2 skipped** (24 files). Baseline before this
work was 220 passed | 2 skipped. The 2 skipped are pre-existing
(`qobuz-provider.live.test.ts`), untouched. Clean `tsc` build (`npm run build`).

Note: `node_modules/` here was copied from `~/dev/roon-bridge` (git deps need
network); it is gitignored. If you re-clone the worktree, `npm install` first.

## What I built (6 commits)

1. **`feat(providers)`** - `ProviderTrack` enriched (albumId, trackNumber, year,
   explicit, version, instrumental, hires, inLibrary). New `getTrack(id)` (Qobuz
   `track/get`) and `tracksInLibrary(ids)` (Qobuz `favorite/status`, signed).
   Tidal stubs added. Pure helpers `inferInstrumental` / `yearFromReleaseDate`.
2. **`feat(queue-by-id)`** - HEADLINE `queue_by_id` / `play_by_id`. Resolve a
   provider track ID → authoritative metadata → EXACT Roon recording, bypassing
   fuzzy track-name search. `when: now|next|queue`, verified by queue growth /
   now-playing flip. Pure selection helpers `normalizeTitle`, `artistMatches`,
   `pickTrackRow` in search-core.
3. **`feat(search_tracks)`** - each result now carries duration, year, explicit,
   instrumental, version, hi-res, and `in_library`; `source=library` scoping.
4. **`feat(find_versions)`** - candidates carry the browse `item_key` and an
   inferred `instrumental` flag; payload documents the Roon-browse field limits.
5. **`feat(topology)`** - `transfer_zone`, `group_zones`, `ungroup_zone` (the
   transport commands the bridge never surfaced), each verify-by-reread.
6. **`docs`** - `docs/roon-api-command-surface.md` (the findings doc).

## How queue-by-ID is deterministic (the core design)

Roon exposes **no play-by-external-ID** primitive; playback is only through the
browse tree keyed by session-scoped `item_key`s, and a Qobuz track ID is not an
item_key. So:

1. `provider.getTrack(id)` → authoritative `{title, artist, album, trackNumber}`.
2. Artist-scoped Roon track search → keep rows whose artist matches (kills
   covers / type-beats / wrong-artist - failure class #1). One exact match → done.
3. Tied (same artist, >1 album - the `queue_version` `ambiguous_ref` case) or
   none → **album-anchored**: search the album, open it, pick the track row by
   exact title (+ track number). Album is the unique disambiguator, from the
   provider, never guessed.
4. Execute `when` action; verify the queue grew / now-playing flipped.

## Investigation findings

Full write-up: **`docs/roon-api-command-surface.md`** (committed). Summary:

- **Command-surface gaps** (now built): transport `transfer_zone`,
  `group_outputs`, `ungroup_outputs` were unsurfaced → added as `transfer_zone`,
  `group_zones`, `ungroup_zone`.
- **Recommended next** (not built): `mute_all`/`pause_all`; `genres`/`composers`
  browse + `internet_radio`; album-level `in_library`.
- **Confirmed unavailable to extensions** (documented honestly, unchanged):
  queue remove/reorder (no primitive), Roon Focus filters (GUI-only),
  play-by-external-ID (none).

### Metadata-availability table (condensed)

| Field | Reachable? | Where |
| --- | --- | --- |
| track ID, duration, explicit, version, album, album ID, track #, year, ISRC, hi-res | YES (Qobuz) | `search_tracks` / `getTrack` |
| instrumental | best-effort (inferred; no native flag) | `search_tracks`, `find_versions` |
| in_library (track) | YES (`favorite/status`) | `search_tracks`, `tracksInLibrary` |
| duration / explicit / year / track ID on a Roon **browse** row | NO | not in `com.roonlabs.browse:1` - documented in `find_versions` output |
| Roon item_key on a browse row | YES but session-scoped | `find_versions` (transparency only) |

Live-verified against Monty's Qobuz account: `getTrack` distinguishes the two
"Puppets" by Atmosphere (When Life Gives You Lemons #2/2008/in-library vs Triple
X Years #17/2025); `favorite/status` returns true only for the in-library id;
enriched `search_tracks` returns both plus the instrumental edition.

## Acceptance items

| Item | Status |
| --- | --- |
| Puppets case: queue the studio "When Life Gives You Lemons" recording deterministically by ID, no `ambiguous_ref`, no playlist | Built + unit-proven end-to-end (mock browse) + Qobuz resolve live-verified. **Needs live WiiM + 1 confirm** (Roon-execution half). |
| `search_tracks` / `find_versions` return ID, duration, explicit, instrumental/version, album/year (or document unreachable) | DONE. `search_tracks` carries all (Qobuz, live-verified). `find_versions` carries item_key + instrumental and documents what Roon browse cannot expose. |
| Qobuz results carry accurate `in_library`; `source: library` scoping works | DONE, live-verified (`favorite/status`; bogus id correctly excluded). |
| Findings doc enumerating the command surface + what was unsurfaced | DONE (`docs/roon-api-command-surface.md`). |
| No regression to queue/playback/volume tools (re-run suite; report count) | DONE - 247 passed \| 2 skipped, +27 over baseline, no regressions. |

**What I could NOT verify (and why):** any tool that EXECUTES a Roon browse
action or transport topology change makes sound on the living-room system and/or
risks a pairing war with the running single bridge instance. Per the ticket I
did not deploy or live-test those. Their browse/transport mechanics follow the
already-live-proven patterns (play_track / queue_version / queue_next) and are
unit-tested against mocks. The Qobuz half (getTrack, tracksInLibrary, enriched
search_tracks) IS live-verified.

## Live checks Maya must run with Monty at "WiiM + 1"

Run in a quiet moment (these make sound / move playback). Suggested order:

1. **queue_by_id determinism (the headline).**
   - `search_tracks "Puppets Atmosphere"` → confirm distinct IDs with album/year/in_library.
   - `queue_by_id` with the *When Life Gives You Lemons* id (`95206613`), `when:"queue"` → expect `ok:true`, `verified:true`, `resolved_via:"album-anchored"`, `matched.album` contains "When Life Gives You Lemons". Confirm in Roon the queued "Puppets" is the 2008 album cut.
   - `queue_by_id` with the Triple X id (`337073075`) → confirm it queues the *Triple X* recording, not the other.
   - `play_by_id` with an id, `when:"now"` → confirm the right exact track starts.
2. **A clean single-match track** (e.g. a unique song) via `queue_by_id` → confirm path A (artist-scoped track search) resolves without album anchoring.
3. **A track whose album isn't well-matched in Roon** → confirm it fails honestly (`track_not_in_album` / `album_not_found`), never queues the wrong thing.
4. **search_tracks `source:"library"`** → confirm only in-library tracks return.
5. **find_versions** on a song with live/comp variants → confirm `item_key`, `instrumental`, and the `fields_note` are present.
6. **transfer_zone** (move a playing zone to another room) → confirm the track + queue land and `verified:true`.
7. **group_zones / ungroup_zone** → confirm a "WiiM + 1"-style group forms and breaks, `verified:true`. (Topology changes - do last, with Monty.)

If any Roon-execution path mis-selects, the likely tuning point is the browse-
tree traversal in `src/tools/play-by-id.ts` (`resolveRoonRow`) - specifically
whether opening a search-result album yields the track listing directly or an
action popup. The code handles both shapes, but that branch is the one piece I
could not exercise live; the pure selection logic (`pickTrackRow`) is fully tested.
