#!/bin/bash
# Post-deploy smoke check. Run after every `launchctl kickstart`, BEFORE
# declaring a deploy done - see the "Deploy" section of README.md.
#
#   scripts/smoke.sh                  # read-only checks
#   scripts/smoke.sh --live-mutation  # + the mutation smoke (Monty-approved windows only)
#   scripts/smoke.sh --zone "WiiM + 1"
#
# Exits non-zero if any check fails.

set -e
cd "$(dirname "$0")/.."

# launchd's default PATH doesn't include Homebrew; match start-bridge.sh.
export PATH="/opt/homebrew/bin:$PATH"

exec /opt/homebrew/bin/node scripts/smoke.mjs "$@"
