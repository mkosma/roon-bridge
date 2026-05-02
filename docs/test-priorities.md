# Roon-bridge test coverage – gaps and priorities

## Current state (2026-05-02)

Vitest suite, 4 files / 59 tests:

| File | Scope |
|---|---|
| `tests/control-endpoints.test.ts` | `/control/*` and `/config/*` REST routes (mocked Roon transport) |
| `tests/config-roundtrip.test.ts` | roon-key config persistence |
| `tests/volume-ramper.test.ts` | `VolumeRamper` ramp scheduling logic |
| `tests/mcp-http-initialize.test.ts` | regression: `POST /mcp` initialize must succeed when express.json() ran first |

Everything that runs over the wire (auth middleware, OAuth dance, MCP session lifecycle, mDNS, the actual Roon connection) is essentially untested. The two production incidents we have on record (this conversation's body-parsing 400, and the FD-exhaustion crash from 2026-04-25) were both invisible to the suite.

## Priority groupings

Priorities reflect blast radius, not implementation cost. "High" means the bug, if shipped, takes the bridge offline for every consumer (Claude Code, Claude Desktop, Roon-key, iOS Shortcut). "Medium" means it degrades over time or under stress. "Low" means a single feature misbehaves but the bridge keeps serving.

### High priority – inbound channels and the cold-start path

Anything that prevents a fresh client from completing a handshake against a freshly-started bridge.

1. **`POST /mcp` initialize handshake (covered as of this commit).** Keep it; extend with:
   - Initialize without bearer token returns 401 with the right `WWW-Authenticate` header.
   - Initialize with bearer token returns 200 + `Mcp-Session-Id`.
   - Subsequent `tools/list` on the same session ID returns the registered tool set.
   - Re-initialize on a known session ID is rejected per spec.
2. **OAuth 2.1 dance end-to-end.** `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize` (PKCE round-trip), `/token`. Assert the access token returned is the same one the auth middleware accepts.
3. **Auth middleware.** No token, wrong token, right token, malformed `Authorization` header. Today only the happy path is implicitly exercised.
4. **`GET /health`.** Always 200, no auth required, JSON shape stable. This is what monitoring (LaunchAgent health check, Brody, you-in-Chrome) hits first.
5. **`/control/:action` smoke.** Every alias in `CONTROL_ALIASES` resolves and dispatches; unknown alias is 404 with the valid list. Already partially covered – verify the catch-all route is registered AFTER the specific roon-key routes (regression risk: route order).
6. **Process boot.** `startHttpServer()` listens on the configured port, advertises mDNS, returns from `app.listen` callback within a deadline. This is the test that would have caught a "bridge silently exits before binding" regression.
7. **Server boots when Roon Core is unreachable.** The bridge must come up and serve `/health` (with `roon_connected: false`) and `/mcp` (tools list) even if Roon is down – clients that connect first should not wedge. Today the tests mock Roon away; nothing asserts the no-Roon path.

### Medium priority – stress, longevity, resource hygiene

Things that pass a single-shot smoke test and fail under sustained or adversarial load.

1. **Session map leak.** Open N sessions, drop them without `DELETE /mcp`, assert `sessions` map shrinks (or document that it doesn't and bound it). The `Map<string, …>` in `server.ts` has no eviction.
2. **`pendingCodes` leak.** Open N OAuth codes, never redeem them, assert the 5-minute timer cleans them all up. Easy to assert with fake timers.
3. **File descriptor / handle leak under repeated reconnects.** Force the Roon WebSocket to drop and reconnect 100x, assert open handles plateau. The 2026-04-25 incident was FD-exhaustion via `bfs` but the bridge's own reconnect loop is in the same risk class.
4. **Roon WebSocket reconnect backoff.** Assert the 3-second reconnect actually fires, doesn't double-fire, and doesn't tight-loop if the core stays down.
5. **VolumeRamper cancellation under load.** Start a ramp, fire a second ramp on the same zone before the first completes, assert exactly one timer is live. Ramp + manual volume change interaction.
6. **Concurrent `/control` requests.** Two simultaneous `play` and `pause` to the same zone do not crash the transport callback handling.
7. **mDNS lifecycle.** Publishes on boot, unpublishes on SIGTERM. Today shutdown is best-effort; a missing unpublish leaves stale records on the LAN.
8. **Crash-restart contract.** Kill -9 the process, restart, assert clients can re-handshake without manual intervention. (LaunchAgent handles the restart; the test asserts the bridge doesn't need a stale-lock cleanup step.)

### Low priority – functional correctness inside individual features

These break one feature for one user. Worth having, not worth blocking on.

1. **Zone defaulting.** Omitted `zone` falls back to `WiiM + 1`; explicit `zone=Foo` overrides; unknown zone returns a clear error.
2. **MCP tool numeric coercion.** `z.coerce.number()` on every tool that takes a numeric arg (per the existing memory note – string-serialized JSON args from MCP clients).
3. **roon-key config roundtrip edge cases.** Missing file, malformed JSON, partial fields, atomic write under crash mid-write.
4. **Control aliases.** `prev` vs `previous` vs `previous_track` all map to the same action. Already partly covered; expand to every alias.
5. **`/control/:action` accepts both GET and POST.** iOS "Get Contents of URL" can't set a method – this contract should be pinned.
6. **OAuth `/authorize` with missing `redirect_uri`** returns 400 `invalid_request`.
7. **`/token` with expired or already-redeemed code** returns `invalid_grant`.
8. **MCP `tools/call` happy paths** for each registered tool, with mocked Roon transport asserting the right `transport.control` / `change_volume` calls.

## Suggested next steps

If we only add three tests this week, do the High-priority 2, 3, and 7 (OAuth dance, auth middleware matrix, no-Roon-Core boot). Those three together would have caught both shipped regressions on this branch and would catch the most likely class of future ones (auth changes silently locking everyone out).

If we add a CI gate, run the full Vitest suite plus a 30-second integration smoke that boots the real binary against a stubbed Roon and runs steps 1, 2, 4 from High against the live port. The unit tests are fast (~700ms today) so the bottleneck is the integration step, not the suite.
