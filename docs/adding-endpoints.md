# Adding a new MCP endpoint

When you add a new tool to the roon-bridge MCP server, Claude Code will prompt for permission on every call until the tool name is allowlisted. Two prefixes need entries because the same server is registered twice.

## The two prefixes

The roon-bridge service is registered in Claude Code via two paths, and each shows up under a different prefix:

- **`mcp__roon-bridge__<tool>`** – local registration in `~/.claude/mcp-servers.json` (HTTP at the LAN address). Used by Claude Code on mini.
- **`mcp__2d96af36-3d1e-4a44-81a8-519d01f23b25__<tool>`** – claude.ai connector registration. Used by the Claude desktop app and claude.ai web. The UUID is stable per connector and only changes if the connector is deleted and re-added on claude.ai.

Both are present in any Claude Code session because claude.ai connectors sync down. Allowlist patterns match by exact prefix, so a tool needs an entry under each.

## Steps

1. Add the new tool to the server (`src/`) and confirm it shows up under both prefixes in a Claude Code session.
2. Edit `~/dev/dotclaude/settings.json` (the source of truth – `~/.claude/settings.json` is synced from there).
3. In the top-level `permissions.allow` array, add two entries:

   ```
   "mcp__roon-bridge__<new_tool>",
   "mcp__2d96af36-3d1e-4a44-81a8-519d01f23b25__<new_tool>",
   ```

4. Run `jq . settings.json > /dev/null` to validate JSON.
5. Commit on a branch and open a PR against `mkosma/dotclaude`.
6. After merge, sync to mini and mbp (the dotclaude install/sync script).

## Rules

- Use exact tool names. No wildcards (`mcp__roon-bridge__*`) – Claude Code's allowlist hygiene rules forbid wildcards on MCP prefixes.
- Add both prefixes in the same PR. One without the other leaves prompts on whichever surface uses the missing prefix.
- If the UUID rotates (connector re-added on claude.ai), update all 23+ UUID-prefixed entries at once. A grep + sed against the old UUID is the fastest path.

## Reference

PR [mkosma/dotclaude#12](https://github.com/mkosma/dotclaude/pull/12) is the worked example covering all 23 current endpoints under both prefixes.
