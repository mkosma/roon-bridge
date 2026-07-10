# roon-bridge

A persistent HTTP-based MCP server for controlling [Roon](https://roon.app) via Claude. Runs as a single background service on your Roon Core machine and serves any number of Claude sessions (Desktop, Cowork, Claude Code, Dispatch) simultaneously - over your local network or Tailscale.

## Why this exists

The original [roon-mcp](https://github.com/AzureStackNerd/roon-mcp) by AzureStackNerd is an excellent MCP server for Roon, but it uses stdio transport - meaning every Claude session spawns its own process and Roon connection. Roon sees each connection as a separate extension requiring individual authorization. With multiple Claude entry points (Dispatch, Cowork, Claude Code), this quickly becomes unworkable: duplicate extensions pile up, each needing manual approval.

**roon-bridge** solves this by decoupling the Roon connection from the MCP transport:

- **One process, one Roon extension** - a persistent HTTP server holds the single WebSocket connection to Roon Core. Pair once, done forever.
- **Many clients** - any Claude session on any device connects to the HTTP endpoint. No new Roon extensions, no re-authorization.
- **Network-accessible** - works across your LAN or Tailscale mesh, with bearer token auth.

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
| `MUSIC_PROVIDERS` | `qobuz` | Comma list of enabled playlist providers (`qobuz`, `tidal`) |
| `MUSIC_PROVIDER_DEFAULT` | first enabled | Default provider when a tool omits `provider` |
| `PLAYLIST_TOOLS` | *(on)* | Set `0` to omit the playlist tools entirely |
| `QOBUZ_AUTO_REFRESH` | *(off)* | Set `1` to let the bridge subprocess-run the external Qobuz refresher on token expiry |

If Roon Core runs on the same machine, use `ROON_HOST=127.0.0.1`.

### Playlist provider tools

roon-bridge exposes provider-neutral playlist tools (`search_tracks`,
`list_playlists`, `get_playlist`, `create_playlist`,
`add_tracks_to_playlist`, `remove_tracks_from_playlist`, `rename_playlist`,
`delete_playlist`). Each takes an optional `provider` argument; omit it for
`MUSIC_PROVIDER_DEFAULT`. `delete_playlist` requires `confirm: true`.

Qobuz is the only implemented provider. App credentials are extracted
browser-free from the Qobuz web bundle. The user token is read from
`~/.qobuz-mcp/token.json`, which is produced by the **standalone**
`refresh_token.py` (Playwright + one-time reCAPTCHA login) in the
`qobuz-mcp` repo - that script is intentionally **not** a dependency of
roon-bridge. On token expiry the tools return an actionable error telling
you to run it; `QOBUZ_AUTO_REFRESH=1` opts into auto-invoking it.

Adding Tidal (or another service) is implementing one interface - see
`src/providers/tidal/README.md`. The standalone `qobuz-mcp` MCP server is
now redundant for playlists; keep only its `refresh_token.py`.

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
6. **roon-bridge:** Handled by the LaunchAgent installed above - starts automatically on login

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

Log rotation is handled by macOS `newsyslog` - 5 rotated copies, compressed, up to 1MB each.

## Stdio mode

For local use or testing, you can run in stdio mode (like a traditional MCP server):

```bash
node build/server.js --stdio
```

This bypasses the HTTP server and speaks MCP over stdin/stdout. Not recommended for production since it only serves one client.

## Available tools

All the same tools as [roon-mcp](https://github.com/AzureStackNerd/roon-mcp):

- `list_zones` - list all Roon zones and their playback status
- `now_playing` - what's currently playing
- `get_queue` - view the play queue
- `play` / `pause` / `play_pause` / `stop` - transport controls
- `next_track` / `previous_track` - track navigation
- `seek` - seek within the current track
- `shuffle` / `loop` - playback mode
- `change_volume` / `mute` / `get_volume` - volume controls
- `search` - search the Roon library
- `play_artist` / `play_album` / `play_playlist` / `play_track` - search and play
- `add_to_queue` - search and queue (re-verified against a queue read). Prefers
  the studio cut by default - live takes, compilations, and tributes are
  demoted unless the query asks for one.
- `search_albums` / `play_album_by_id` / `queue_album_by_id` - the deterministic
  album counterpart of `search_tracks` / `play_by_id` / `queue_by_id` (below):
  search a provider (Qobuz) for albums, then play/queue the EXACT album by its
  provider id - pinned by title+artist+year, never a fuzzy name guess.

### Fuzzy name matching: a confidence floor, always

Every name-based play/queue tool (`play_artist`, `play_album`, `play_playlist`,
`play_track`, `add_to_queue`) scores its candidates and refuses to act below a
confidence floor - **0.75 by default**, **0.9** for a deliberate interrupt/
replace stomp (see below). Below the floor it returns the ranked candidates
(title, artist, confidence) and mutates nothing; it never silently substitutes
a loose match. For a query where the top match is genuinely ambiguous or
wrong, pick an exact candidate from the list, or resolve deterministically:
`search_tracks` + `play_by_id`/`queue_by_id`, or `search_albums` +
`play_album_by_id`/`queue_album_by_id`.

### Zone resolution

`zone` accepts an exact display name, a zone id, or a unique substring/prefix
(`"wiim u"` resolves to a lone "WiiM Ultra"). A name matching more than one
zone (e.g. `"WiiM"` when both "WiiM + 1" and "WiiM Ultra" exist) is an error
listing every candidate - it is never resolved by map-iteration order.

### Replacing the queue and playing now (the deliberate stomp)

Every play/queue tool is **safe by default**: it never cuts the current track.
To deliberately interrupt and replace the queue RIGHT NOW, use **`when: "replace"`**
- one intentional, single-valued stomp, string-typed so it survives a client
that stringifies scalars (a plain `immediate: true` boolean can arrive as the
string `"true"` and fail validation before the handler runs; `when: "replace"`
never has that problem). `immediate: true` still works and now also accepts the
strings `"true"`/`"false"`, but `when: "replace"` is the preferred form.

- Deterministic ID tools - `play_tracks`, `queue_tracks`, `play_by_id`,
  `queue_by_id`, `queue_version`: `when: "replace"` replaces the queue with the
  exact requested content and plays from the first item, verified to land as
  exactly that set (no leftover tail).
- Fuzzy name tools - `play_album`, `play_playlist`: `when: "replace"` only
  stomps when the name match is **>= 90% confidence**; below that it returns the
  candidate list and plays nothing (a stomp may never ride on a loose match).

Every mutating tool now appends a **`resulting_state`** block to its success
payload - the post-action `now_playing`, `queue_head`/`queue_count`, `volume`,
and `read_at` - so a caller does not need a follow-up `get_queue`/`now_playing`,
and a claim of success always carries the state that backs it. A play action
that Roon acks while playback never changes is reported as **not verified**
(isError), never as a false "Now playing".

### Deferred actions (safe default) and the deferral ledger

By default a play/queue/edit tool does not cut the current track: it **arms the
action at the next track seam** (the end of the current track, event-driven off
Roon's own zone events - never a wall-clock timer). Every such arming returns a
**`deferral_id`** and is recorded in a shared ledger with a terminal outcome:

- `fired_verified` - fired and a post-action state read confirmed it landed
- `fired_unverified` - fired but the landing could not be confirmed (loud)
- `failed(reason)` - the seam action threw or could not complete (e.g. a track
  could not be resolved/played)
- `aborted(reason)` - a clean stand-down (e.g. `interference` - the queue moved
  under an armed `edit_queue`; or `canceled`)
- `superseded` - a newer command (or an immediate play) replaced it
- `expired` - dropped without firing

Because a scheduled action can fail or be superseded after the schedule-time
`ok:true`, **never report a deferred action as done off the arming alone** - read
its outcome first:

- **`deferred_status`** - list what is still armed plus recent outcomes
  (optionally filtered by `zone`).
- **`cancel_deferred(deferral_id)`** - cancel the armed deferral (recorded
  `aborted(canceled)`).
- The `GET /monitor/state` read also carries a per-zone `deferrals` block (armed
  + recent outcomes) for the music-monitor daemon.

Seam semantics worth knowing:

- **Skipping the current track fires the armed action** (any advance past the
  trigger track, natural end or manual skip - a deferral means "do this once we
  leave THIS track"). Pause/seek/volume changes never fire it.
- The deterministic ID tools **resolve to exact provider ids at arm time and
  replay those exact ids at the seam** - a catalog change between arm and seam
  cannot substitute a different track. The fuzzy name path (`play_album`/
  `play_track` by name, deferred) resolves at the seam under the same **>= 90%
  confidence** gate and full verification, so it can never stomp a wrong match
  unattended.

### Version selection (studio vs live, precise pick)

The universal Roon search mixes studio, live, and compilation recordings of the
same song. The scorer demotes live/comp by default; these two tools let you see
and pin an exact recording.

- `find_versions` - search and return the ranked candidate **versions** of a
  track/album, each with `is_live`, `is_compilation`, `confidence`, and an
  opaque `ref`. `exclude_live` drops live takes; `source: library|all` scopes to
  the library (album/artist only - see note below).
- `queue_version` - queue/play the EXACT recording named by a `ref` from
  `find_versions`, re-resolved by exact title+subtitle (never a fresh fuzzy
  pick) and verified by queue growth. `when: queue|next|replace` (replace =
  interrupt and replace the queue now).

> Roon's browse API exposes only title/subtitle/item_key per row - no structured
> year, format, or library-membership flag - and Roon's Focus filtering is
> GUI-only (no focus param). So studio preference is done by result scoring, not
> Focus; `is_live`/`is_compilation` are inferred from text; and `source:library`
> uses Roon's library-only browse hierarchies, which cover albums/artists but
> not tracks.

### Queue editing (stable item ids)

- `get_queue` - now returns a stable `queue_item_id` per row plus structured
  metadata (title, artist, album, length, `is_now_playing`), alongside the
  human-readable list.
- `queue_next` - insert a track/album/playlist immediately after the current
  track (Roon "Add Next"); verified against a follow-up queue read.
- `play_from_here` - jump playback to a queued item by `queue_item_id`.
- `remove_from_queue` - remove a **contiguous block of next-up items** by
  skipping past it (the only removal Roon's extension API permits). Fails
  loudly for non-contiguous, now-playing, or stale-id removals.
- `reorder_queue` - Roon's extension API exposes **no** queue-move primitive;
  this tool reports that honestly rather than returning a false success. Use
  `queue_next` / `play_from_here` instead.

### Roon-native playlists

- `list_roon_playlists` - list Roon's OWN playlists (e.g. "Hearted Albums &
  Songs", "Roon Discoveries") that the Qobuz/Tidal tools cannot see.
- `get_roon_playlist` - read a Roon-native playlist's full track list by name
  or item_key, paginated (`offset`/`limit`) for large lists.

## Monitor endpoint (cheap, script-callable)

For a deterministic daemon that polls zone state frequently without an LLM or
MCP session:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3100/monitor/state?zone=WiiM%20%2B%201"
```

Returns, reading only the in-memory zone map (sub-150ms, negligible load):

```json
{
  "ok": true,
  "zone": "WiiM + 1",
  "state": "playing",
  "now_playing": { "title": "...", "artist": "...", "album": "..." },
  "queue_remaining_count": 29,
  "queue_time_remaining_seconds": 3600
}
```

`GET /monitor/state/all` returns the same snapshot for every zone. Same bearer
token as `/mcp` and `/control`. Unknown explicit zone → 404; Roon down → 503.

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

## Perf scripts

Two standalone scripts in `scripts/` benchmark and explore the Roon
browse API. Both pair as the same extension as the bridge and reuse
`config.json`, so **the bridge must be stopped before running them**.

```bash
# Stop the bridge
launchctl bootout gui/$(id -u)/com.roon-bridge

# Benchmark: best-of-3 timings for 8 library/search calls,
# printed as a markdown table
npm run perf:baseline

# Probe: dump the root of the browse hierarchy + Library section,
# plus direct albums/artists roots. Useful for spotting structural
# changes in the Roon API.
npm run perf:probe

# Restart the bridge
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roon-bridge.plist
```

Override the Roon Core address with `ROON_HOST` / `ROON_PORT` env vars
(defaults: `127.0.0.1:9330`).

## Deploy

The live daemon serves Maya's MCP connection and active playback. A deploy is:
**pull, build, kickstart, smoke.sh, gen:toolref, handoff note.**

```bash
# 1. Pull (merge to main first, or fast-forward it)
git -C ~/dev/roon-bridge checkout main
git -C ~/dev/roon-bridge pull

# 2. Build + test green BEFORE touching the running daemon
npm --prefix ~/dev/roon-bridge run build
npm --prefix ~/dev/roon-bridge test

# 3. Restart the daemon onto the new build
launchctl kickstart -k gui/$(id -u)/com.roon-bridge

# 4. Smoke-check - fails loudly if the daemon is still serving the old
#    build (stale-bridge class) or Roon/the subscription looks unhealthy.
#    Never pass --live-mutation as part of an unattended deploy.
~/dev/roon-bridge/scripts/smoke.sh

# 5. Regenerate Maya's tool reference from the now-live schema
python3 ~/.agents/Maya/code/gen-tool-reference.py

# 6. Handoff note - tell Maya (and anyone else relying on the bridge) what
#    changed, especially if scripts/smoke.sh flagged a schema/enum change.
```

Restarting drops in-flight MCP sessions (clients auto-reconnect) but does not
disturb Roon playback. The new MCP tools appear after the client reconnects.

For the Roon-native Playlists path specifically (perf:probe pairs as the same
extension, so it needs the bridge stopped first):

```bash
launchctl bootout gui/$(id -u)/com.roon-bridge
npm --prefix ~/dev/roon-bridge run perf:probe   # look for the Playlists node block
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roon-bridge.plist
~/dev/roon-bridge/scripts/smoke.sh
```

## Credits

- [AzureStackNerd/roon-mcp](https://github.com/AzureStackNerd/roon-mcp) - the original MCP server for Roon that this project is based on. Tool definitions, Roon API integration patterns, and the WebSocket patch are adapted from that project (MIT license).
- [Roon Labs](https://roon.app) - for the Roon API and Node.js client libraries.
- [Model Context Protocol](https://modelcontextprotocol.io) - the protocol that makes all of this work.

## License

MIT
