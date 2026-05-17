# Tidal adapter (not yet implemented)

This directory is the proof that the provider port is genuinely pluggable.
Adding Tidal is: implement one interface, register it in one place. No MCP
tool, no `server.ts`, and no Roon code changes.

## Contract

Implement `MusicProvider` from `../types.ts`:

| Method | Notes |
|---|---|
| `searchTracks(query, limit)` | Return `ProviderTrack[]`. Populate `isrc` when Tidal exposes it — it is the cross-provider join key (e.g. clone a Qobuz playlist onto Tidal by ISRC). |
| `listPlaylists(limit)` | Current user's playlists. |
| `getPlaylist(id, limit)` | Playlist + its tracks. |
| `createPlaylist(name, opts)` | `opts.description`, `opts.isPublic`. |
| `addTracks(id, trackIds)` | Tidal track IDs. |
| `removeTracks(id, trackIds)` | Map track IDs to Tidal's removal unit (index/item id) inside the adapter, as the Qobuz adapter does for `playlist/deleteTracks`. |
| `renamePlaylist(id, name)` | |
| `deletePlaylist(id)` | Irreversible; the tool layer already gates this behind `confirm: true`. |

Set `name = "tidal"` and return `ProviderTrack/ProviderPlaylist` with
`provider: "tidal"`.

## Auth (the part that differs from Qobuz)

Qobuz uses browser-free bundle credential extraction plus a token.json
written by an external Playwright refresher. Tidal is different:

- Tidal uses **OAuth 2.0 device authorization flow** (user approves a code on
  tidal.com, the adapter polls the token endpoint, then refreshes with a
  long-lived refresh token).
- Keep token acquisition isolated exactly as Qobuz does: the adapter only
  *reads* a stored token; a separate, rarely-run helper performs the
  interactive device-flow login. Do not pull an interactive auth dependency
  into roon-bridge's process.
- Throw `ProviderError("auth", <run-the-helper hint>, "tidal")` when no usable
  token exists, mirroring `qobuz/token.ts`.

## Wiring

1. Add `tidal` to `MUSIC_PROVIDERS` (and optionally `MUSIC_PROVIDER_DEFAULT`).
2. Implement `TidalProvider` in `index.ts` (skeleton already present).
3. In `../bootstrap.ts`, register it under the existing
   `enabledNames.includes("tidal")` guard.

Nothing else changes. Tools accept `provider: "tidal"` automatically.
