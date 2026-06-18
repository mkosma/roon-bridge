# Roon + Qobuz command surface: what's reachable, what the bridge exposed, and the gaps

Investigation for the queue-by-id build (2026-06-18). Enumerated against the
installed `node-roon-api`, `node-roon-api-browse` (`com.roonlabs.browse:1`), and
`node-roon-api-transport` (`com.roonlabs.transport:2`) library sources, and
against the live Qobuz catalog API (read-only). The goal: confirm whether
deterministic queue-by-ID is buildable, and surface useful commands the bridge
was not exposing.

## Headline finding: there is no "play by external/provider ID" primitive

Roon plays a track ONLY through the browse tree
(`search -> category -> item -> action -> execute`), keyed by **session- and
stack-scoped `item_key`s**. The transport service has no play-by-id either. A
Qobuz catalog track ID (e.g. `95206613`) is **not** a Roon `item_key` and cannot
be handed to any Roon call directly.

So deterministic queue-by-ID is built by **bridging the two ID spaces**:
`provider.getTrack(id)` returns authoritative `{title, artist, album,
trackNumber}` from Qobuz, and the bridge then pins the EXACT Roon row -
artist-scoped track search (kills covers/type-beats/wrong-artist) and, for the
tied same-artist/multi-album case, album-anchored resolution (search the album,
open it, pick the track by exact title + track number). This is what
`queue_by_id` / `play_by_id` do. It bypasses fuzzy track-NAME matching entirely:
the only search is artist/album-scoped and the selection among results is exact.

## Transport service (`com.roonlabs.transport:2`) - full method list

| Method | Bridge tool before | Status |
| --- | --- | --- |
| `control` (play/pause/playpause/stop/previous/next) | play/pause/stop/next_track/previous_track/play_pause | exposed |
| `seek` | seek | exposed |
| `change_volume` | change_volume / volume_preset / ramp_volume | exposed |
| `mute` | mute / mute_toggle | exposed |
| `change_settings` (shuffle/auto_radio/loop) | shuffle / loop | exposed |
| `subscribe_zones` / `get_zones` | list_zones / now_playing / zone_state | exposed |
| `subscribe_queue` | get_queue | exposed (read) |
| `play_from_here` | play_from_here | exposed |
| **`transfer_zone`** | — | **NEW: `transfer_zone`** (built this round) |
| **`group_outputs`** | — | **NEW: `group_zones`** (built this round) |
| **`ungroup_outputs`** | — | **NEW: `ungroup_zone`** (built this round) |
| `get_outputs` / `subscribe_outputs` | — | not surfaced (output-level enumeration; only needed to drive grouping, which `group_zones` resolves from zone names) |
| `mute_all` / `pause_all` | — | not surfaced (global panic mute/pause) - recommended next, low effort |
| `standby` / `toggle_standby` / `convenience_switch` | — | not surfaced (output power; only some outputs support standby) - low value |
| `transfer_zone`/`group`/`ungroup` callbacks | n/a | wrapped as promises in `roon-connection.ts` |

### Not available to extensions at all (confirmed, documented honestly)

- **Queue remove / reorder.** No transport or browse primitive. The only
  approximation (`play_from_here` past items) discards the now-playing track, so
  `remove_from_queue` / `reorder_queue` refuse honestly. Roon's own apps use a
  private service not granted to extensions. (Unchanged this round.)
- **Roon "Focus" filters.** GUI-only. The browse API has no focus parameter or
  hierarchy, so library/format/era filtering cannot be driven from an extension.

## Browse service (`com.roonlabs.browse:1`) - full method list

Only **two** methods exist: `browse` and `load`. Everything (search, drill,
action execution) is expressed through them. Per-row data is limited to
`title`, `subtitle`, `image_key`, `item_key`, `hint`
(`action | action_list | list | header | null`) and an optional `input_prompt`.

**There is no structured metadata on a browse row** - no duration, no explicit
flag, no year, no album field (the album is the page you navigate, not a column
on the track row), no provider track ID. This is why `find_versions` (which runs
on browse) can only infer `is_live` / `is_compilation` / `instrumental` from
title+subtitle text, and why the rich, authoritative metadata lives on
`search_tracks` (Qobuz), which is also the directly-queueable-by-ID path.

### Browse hierarchies

`browse` accepts a `hierarchy`: `browse`, `playlists`, `settings`,
`internet_radio`, `albums`, `artists`, `genres`, `composers`, `search`.

| Hierarchy | Bridge use | Note |
| --- | --- | --- |
| `search` | all play/queue/version tools | universal (library + Qobuz/Tidal) |
| `albums` / `artists` | `find_versions` source=library | library-only scoping |
| `genres` / `composers` | — | not surfaced - browse-by-genre/composer curation; recommended next |
| `internet_radio` | — | not surfaced - play internet radio stations |
| `playlists` | (Roon playlists via roon-playlists tools) | partially used |

## Qobuz catalog API - metadata availability (live, read-only)

`catalog/search?type=tracks` and `track/get` return rich, authoritative
metadata. Verified live against Monty's account.

| Field | Qobuz source | Surfaced by |
| --- | --- | --- |
| track ID | `id` | search_tracks, getTrack -> queue_by_id |
| duration (s) | `duration` | search_tracks (`durationSec`) |
| explicit | `parental_warning` | search_tracks (`explicit`) |
| version/edition | `version` (e.g. "Live", "Instrumental"; null = studio) | search_tracks (`version`) |
| instrumental | inferred from title/`version` (no native boolean) | search_tracks (`instrumental`) - best-effort hint |
| album | `album.title` | search_tracks (`album`) |
| album ID | `album.id` | getTrack (`albumId`) - anchors the Roon resolve |
| track number | `track_number` | getTrack (`trackNumber`) - album disambiguator |
| year | `release_date_original` (YYYY-...) | search_tracks (`year`) |
| ISRC | `isrc` | search_tracks (`isrc`) - cross-provider join key |
| hi-res | `hires` / `maximum_bit_depth` | search_tracks (`hires`) |
| has lyrics | `has_lyrics` (track/get only) | not surfaced - weak vocal/instrumental proxy |
| **library membership** | `favorite/status?item_id&type=track` (signed) -> `{status: bool}` | search_tracks (`in_library`), `tracksInLibrary()` |

`favorite/getUserFavorites?type=tracks` also lists the full library (≈5,900
tracks for this account); `favorite/status` per item is the lighter, exact path
used for `in_library` on a search result set.

### Worked determinism proof (the ticket's "Puppets" case)

`search_tracks "Puppets Atmosphere"` returns, distinguished:

- `95206613` - "Puppets" / Atmosphere / *When Life Gives You Lemons...* / #2 / 2008 / **in library**
- `337073075` - "Puppets" / Atmosphere / *Triple X Years In The Game* / #17 / 2025
- `337031818` - "Puppets" (Instrumental) / *When Life Gives You Lemons...* / 2008

`queue_by_id 95206613` resolves album-anchored to the *When Life Gives You
Lemons* recording with no `ambiguous_ref` and no playlist - the exact case
`queue_version` refuses.

## Recommended next (not built this round)

1. `mute_all` / `pause_all` - one-call global panic stop. Low effort.
2. `genres` / `composers` browse + `internet_radio` - curation breadth.
3. Album `in_library` on an album-search tool (the `favorite/status?type=album`
   primitive works; no album-search tool is exposed yet).
