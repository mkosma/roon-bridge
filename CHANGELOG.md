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

- `is_public` (`create_playlist`), `confirm` (`delete_playlist`), `shuffle`
  (`play_artist`, `play_album`, `play_playlist`), `enabled` (`shuffle`),
  `relative` (`seek`), `exclude_live` (`find_versions`), `mute` (`mute`),
  `snap` (`change_volume`), `instant` (`volume_preset`): all switched from a
  plain `z.boolean()` to `boolish()`, which also accepts the stringified
  `"true"`/`"false"` a scalar-stringifying MCP client sends. Wire shape for
  each of these params changed from `{"type": "boolean"}` to
  `{"anyOf": [{"type": "boolean"}, {"type": "string", "enum": ["true", "false"]}]}`.
  A caller passing a real boolean sees no behavior change.
