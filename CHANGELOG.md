# Changelog

Tool-schema changes only: anything that changes a public tool's params, types,
enum values, or presence. Ordinary bug fixes and internal refactors do not
need an entry. This is the record `tests/tool-schema-snapshot.test.ts`'s
enum-drift snapshot forces a deliberate update against - when you update that
snapshot (`npx vitest run tests/tool-schema-snapshot.test.ts -u`), add an
entry here describing what changed and why. Maya's generated tool reference
(`~/.agents/Maya/code/knowledge/tool-reference.md`, built by
`gen-tool-reference.py` in the agents/Maya repo) surfaces the most recent
entries so she knows her tool surface moved.

## Unreleased

- Deterministic playback poka-yoke (no param/enum change; return-shape +
  behavior change). The five name-based tools - `play_album`, `play_track`,
  `play_artist`, `play_playlist`, `add_to_queue` (by-name path) - now resolve to
  a SINGLE exact match or return an error; they never guess among several and
  never auto-select a fuzzy "best". The confidence gate (0.75/0.90) is deleted.
  album/track/playlist resolve an exact provider id (Qobuz search) and funnel
  through the `*_by_id` gateway; artist and shuffle stay on the Roon-browse path
  with the same unique-or-error rule. On an ambiguous or unmatched name the tool
  mutates nothing and returns `{ ok:false, error:"ambiguous"|"not_found",
  query, category, zone, candidates:[{ id, title, artist, year, ... , confidence }] }`
  (`isError:true`); each candidate carries an exact id for a one-hop by-id
  follow-up. `add_to_queue category=album` now verifies queue growth via
  `queue_album_by_id` rather than reading the album's full track count (the old
  under-add count report is gone).

- `is_public` (`create_playlist`), `confirm` (`delete_playlist`), `shuffle`
  (`play_artist`, `play_album`, `play_playlist`), `enabled` (`shuffle`),
  `relative` (`seek`), `exclude_live` (`find_versions`), `mute` (`mute`),
  `snap` (`change_volume`), `instant` (`volume_preset`): all switched from a
  plain `z.boolean()` to `boolish()`, which also accepts the stringified
  `"true"`/`"false"` a scalar-stringifying MCP client sends. Wire shape for
  each of these params changed from `{"type": "boolean"}` to
  `{"anyOf": [{"type": "boolean"}, {"type": "string", "enum": ["true", "false"]}]}`.
  A caller passing a real boolean sees no behavior change.
