# Claude Instructions for Roon Bridge

## Default Zone

Always use the **"WiiM + 1"** zone for all Roon commands unless the user expressly asks for another device or zone.

## Playlist providers

Playlist write lives behind the `MusicProvider` port in `src/providers/`.
Add a service by implementing that interface and registering it in
`src/providers/bootstrap.ts` — never add provider-specific MCP tools.
Qobuz user token comes from `~/.qobuz-mcp/token.json` (external Playwright
refresher); never import Playwright into roon-bridge.
