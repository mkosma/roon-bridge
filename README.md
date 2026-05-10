# roon-bridge

A persistent HTTP-based MCP server for controlling [Roon](https://roon.app) via Claude. Runs as a single background service on your Roon Core machine and serves any number of Claude sessions (Desktop, Cowork, Claude Code, Dispatch) simultaneously — over your local network or Tailscale.

## Why this exists

The original [roon-mcp](https://github.com/AzureStackNerd/roon-mcp) by AzureStackNerd is an excellent MCP server for Roon, but it uses stdio transport — meaning every Claude session spawns its own process and Roon connection. Roon sees each connection as a separate extension requiring individual authorization. With multiple Claude entry points (Dispatch, Cowork, Claude Code), this quickly becomes unworkable: duplicate extensions pile up, each needing manual approval.

**roon-bridge** solves this by decoupling the Roon connection from the MCP transport:

- **One process, one Roon extension** — a persistent HTTP server holds the single WebSocket connection to Roon Core. Pair once, done forever.
- **Many clients** — any Claude session on any device connects to the HTTP endpoint. No new Roon extensions, no re-authorization.
- **Network-accessible** — works across your LAN or Tailscale mesh, with bearer token auth.

The tool definitions (playback, volume, search, browse) are ported from roon-mcp with minimal changes. Full credit to [AzureStackNerd/roon-mcp](https://github.com/AzureStackNerd/roon-mcp) for the original implementation and Roon API integration patterns.

## Quick start

```bash
cd ~/dev/roon-bridge
npm install
npm run build
npm start
```

On first run, approve **"Roon Bridge for Claude"** in Roon Settings → Extensions. This is a one-time step.

Verify it's working:

```bash
curl http://localhost:3100/health
```

## Configuration

Environment variables (set in `.env`, shell, or the launchd plist):

| Variable | Default | Description |
|---|---|---|
| `ROON_HOST` | `192.168.1.100` | Roon Core IP address |
| `ROON_PORT` | `9100` | Roon Core WebSocket port |
| `BRIDGE_PORT` | `3100` | HTTP server port |
| `BRIDGE_HOST` | `0.0.0.0` | HTTP bind address |
| `BRIDGE_AUTH_TOKEN` | *(none)* | Bearer token for auth (recommended) |

If Roon Core runs on the same machine, use `ROON_HOST=127.0.0.1`.

### Generate an auth token

```bash
openssl rand -hex 32
```

## Connecting Claude clients

### Claude Desktop / Cowork

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roon-bridge": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://127.0.0.1:3100/mcp",
        "--header",
        "Authorization: Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

Replace `127.0.0.1` with the Tailscale IP of your Roon Core machine if connecting from another device.

Restart Claude Desktop after editing.

### Claude Code

```bash
claude mcp add roon-bridge \
  --transport http \
  --url http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer YOUR_TOKEN_HERE"
```

### From other devices on your Tailscale network

Same configuration as above, but use the Tailscale IP of your Roon Core machine:

```json
{
  "mcpServers": {
    "roon-bridge": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://100.x.y.z:3100/mcp",
        "--header",
        "Authorization: Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

## Public exposure with OAuth (for ChatGPT)

ChatGPT's MCP connector requires OAuth 2.1; it cannot send a static
bearer header. Claude Desktop, Claude Code, and iOS Shortcuts all
work fine with the bearer token described above, but ChatGPT does not.

To support ChatGPT we sit [`mcp-auth-proxy`](https://github.com/sigbit/mcp-auth-proxy)
in front of `roon-bridge` on the same machine, fronted by a Cloudflare
Tunnel. The proxy terminates OAuth (Google OIDC, single-email allowlist)
and forwards authenticated requests to `roon-bridge` with the static
bearer token injected. The `/control/*` and `/health` paths bypass the
proxy entirely so iOS Shortcuts continue to work unchanged.

Layout:

```
ChatGPT ─┐
Claude  ─┼─► https://roon.kindredic.app  ──► cloudflared tunnel
mcp-rem ─┘                                       │
                                                 ├─► /control/*  ─► roon-bridge :3100  (static bearer)
                                                 ├─► /health     ─► roon-bridge :3100
                                                 └─► /*          ─► mcp-auth-proxy :3101  (OAuth)
                                                                       │ on success, injects bearer
                                                                       └─► roon-bridge :3100/mcp
```

Components on the Roon Core machine:

- `cloudflared` LaunchAgent (`launchd/com.cloudflared-roon.plist`) terminates the tunnel
- `mcp-auth-proxy` LaunchAgent (`launchd/com.mcp-auth-proxy.plist`) handles OAuth on `127.0.0.1:3101`
- `roon-bridge` LaunchAgent (`launchd/com.roon-bridge.plist`) listens on `127.0.0.1:3100` as before

The proxy is configured via `~/.claude/secrets/roon-oauth.env` (chmod 600)
with Google client ID/secret, an `mkosma@gmail.com` allowlist, and the
existing `BRIDGE_AUTH_TOKEN` as `PROXY_BEARER_TOKEN` for upstream
injection. The plist execs a wrapper script at `~/bin/mcp-auth-proxy-wrapper.sh`
that sources the env file and runs the binary.

`cloudflared` ingress (`~/.cloudflared/config.yml`) splits traffic by path:

```yaml
ingress:
  - hostname: roon.kindredic.app
    path: ^/(control|health)
    service: http://localhost:3100
  - hostname: roon.kindredic.app
    service: http://localhost:3101
  - service: http_status:404
```

### Connecting ChatGPT

Settings → Apps & connectors → Developer mode → Create.

- MCP Server URL: `https://roon.kindredic.app/mcp`
- Authentication: OAuth
- Registration method: Dynamic Client Registration (DCR)

Sign in with the allowlisted Google account on first use; ChatGPT
caches the resulting token.

## Running as a persistent service

### Install

```bash
bash install.sh
```

This builds the project, installs a macOS LaunchAgent, generates an auth token, and starts the service. It will prompt for your Roon Core IP and port.

### Auto-start at boot (headless Mac Mini)

macOS restricts network access for background processes when no user session is active, so a true LaunchDaemon (pre-login service) won't work reliably for either Roon Server or roon-bridge. The recommended approach is **auto-login + LaunchAgent**:

1. **Auto-login:** System Settings → Users & Groups → Automatic Login → select your user
2. **Prevent logout:** System Settings → Privacy & Security → set "Log Out After" to **Never**
3. **Prevent sleep:** System Settings → Energy Saver → turn on "Prevent automatic sleeping when the display is off"
4. **Wake for network:** System Settings → Energy Saver → turn on "Wake for network access"
5. **Roon Server:** Enable "Launch at startup" in the Roon Server menu bar icon
6. **roon-bridge:** Handled by the LaunchAgent installed above — starts automatically on login

With auto-login enabled, the Mac boots straight into your user session, both services start, and they stay running even when the screen locks.

**Why not a LaunchDaemon?** Roon Server stores its database in `~/Library/RoonServer/` and needs user-level network access. Running it under a different user ID makes Roon think it's a different server. macOS also restricts WiFi access for pre-login background processes. See the [Roon community discussion](https://community.roonlabs.com/t/start-roonserver-on-a-mac-at-startup-not-login/94641) for more detail.

### Managing the service

```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.roon-bridge

# Stop
launchctl bootout gui/$(id -u)/com.roon-bridge

# Start (after stop)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roon-bridge.plist

# Check status
launchctl print gui/$(id -u)/com.roon-bridge
```

### Logs

```bash
tail -f ~/Library/Logs/roon-bridge.log
```

Log rotation is handled by macOS `newsyslog` — 5 rotated copies, compressed, up to 1MB each.

## Stdio mode

For local use or testing, you can run in stdio mode (like a traditional MCP server):

```bash
node build/server.js --stdio
```

This bypasses the HTTP server and speaks MCP over stdin/stdout. Not recommended for production since it only serves one client.

## Available tools

All the same tools as [roon-mcp](https://github.com/AzureStackNerd/roon-mcp):

- `list_zones` — list all Roon zones and their playback status
- `now_playing` — what's currently playing
- `get_queue` — view the play queue
- `play` / `pause` / `play_pause` / `stop` — transport controls
- `next_track` / `previous_track` — track navigation
- `seek` — seek within the current track
- `shuffle` / `loop` — playback mode
- `change_volume` / `mute` / `get_volume` — volume controls
- `search` — search the Roon library
- `play_artist` / `play_album` / `play_playlist` / `play_track` — search and play
- `add_to_queue` — search and queue

## REST control endpoint

For one-shot HTTP clients (iOS Shortcuts, browser bookmarks, `curl`),
`roon-bridge` exposes a simple REST endpoint that wraps the same
playback controls as the MCP `play_pause` / `play` / `pause` / etc.
tools. It uses the same bearer token as `/mcp` and operates on the
default zone unless `?zone=Name` is supplied.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3100/control/play_pause
```

Both GET and POST are accepted (Shortcuts' "Get Contents of URL"
defaults to GET, which is convenient). Valid actions:

- `play_pause` (alias: `playpause`, `toggle`)
- `play`
- `pause`
- `stop`
- `next` (alias: `next_track`)
- `previous` (alias: `prev`, `previous_track`)

Returns `{"ok":true,"zone":"WiiM + 1","state":"playpause"}` on success
or `{"ok":false,"error":"..."}` on failure (HTTP 500).

## Health endpoint

```bash
curl http://localhost:3100/health
```

Returns:

```json
{
  "status": "ok",
  "roon_connected": true,
  "zones": [
    { "name": "Living Room", "state": "playing" },
    { "name": "Kitchen", "state": "stopped" }
  ]
}
```

## Credits

- [AzureStackNerd/roon-mcp](https://github.com/AzureStackNerd/roon-mcp) — the original MCP server for Roon that this project is based on. Tool definitions, Roon API integration patterns, and the WebSocket patch are adapted from that project (MIT license).
- [Roon Labs](https://roon.app) — for the Roon API and Node.js client libraries.
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol that makes all of this work.

## License

MIT
