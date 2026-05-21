#!/bin/bash
# mcp-auth-proxy-wrapper.sh - launch wrapper for com.mcp-auth-proxy.plist.
# Sources the OAuth secrets, then execs the mcp-auth-proxy binary in front of
# the local roon-bridge MCP endpoint. The binary is not version-controlled
# (55 MB upstream release); it lives at ~/.local/bin/mcp-auth-proxy.
set -a
source ~/.claude/secrets/roon-oauth.env
set +a
exec "$HOME/.local/bin/mcp-auth-proxy" --trusted-proxies 127.0.0.1/32 --http-streaming-only http://127.0.0.1:3100
