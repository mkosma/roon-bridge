#!/bin/bash
# Wrapper used by the com.roon-bridge LaunchAgent. Rebuilds build/ if it
# is missing or older than any file under src/, then execs the server.
# Hard-fails if the build fails so a stale artifact never silently runs.

set -e
cd "$(dirname "$0")/.."

NPM=/opt/homebrew/bin/npm
NODE=/opt/homebrew/bin/node

if [ ! -f build/server.js ]; then
  echo "[start-bridge] build/server.js missing, building"
  "$NPM" run build
elif /usr/bin/find src -type f -newer build/server.js -print -quit | grep -q .; then
  echo "[start-bridge] src/ newer than build/server.js, rebuilding"
  "$NPM" run build
fi

exec "$NODE" build/server.js
