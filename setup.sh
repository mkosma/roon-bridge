#!/bin/bash
set -euo pipefail

# roon-bridge setup script
# Run this once to install dependencies, build, and register the launchd service.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== roon-bridge setup ==="

# 1. Check node is available
NODE_PATH=$(which node 2>/dev/null || true)
if [ -z "$NODE_PATH" ]; then
    echo "ERROR: node not found in PATH. Install Node.js >= 18."
    exit 1
fi
echo "Using node: $NODE_PATH ($(node --version))"

# 2. Install dependencies
echo ""
echo "--- Installing dependencies ---"
npm install

# 3. Build TypeScript
echo ""
echo "--- Building TypeScript ---"
npm run build

# 4. Update the plist with the correct node path
echo ""
echo "--- Configuring launchd plist ---"
PLIST="$SCRIPT_DIR/com.roon-bridge.plist"

# Update node path in plist
sed -i '' "s|/usr/local/bin/node|$NODE_PATH|" "$PLIST"

# Update working directory and script path
sed -i '' "s|/Users/monty/dev/roon-bridge|$SCRIPT_DIR|g" "$PLIST"

# 5. Prompt for Roon Core IP
echo ""
read -p "Roon Core IP address [192.168.1.100]: " ROON_IP
ROON_IP="${ROON_IP:-192.168.1.100}"
sed -i '' "s|<string>192.168.1.100</string>|<string>$ROON_IP</string>|" "$PLIST"

# 6. Prompt for Roon Core port
read -p "Roon Core port [9100]: " ROON_PORT_INPUT
ROON_PORT_INPUT="${ROON_PORT_INPUT:-9100}"
sed -i '' "s|<string>9100</string>|<string>$ROON_PORT_INPUT</string>|" "$PLIST"

# 7. Generate auth token
echo ""
AUTH_TOKEN=$(openssl rand -hex 32)
echo "Generated auth token: $AUTH_TOKEN"
echo "Save this — Claude clients will need it to connect."
echo ""

# Uncomment and set the auth token in plist
sed -i '' "s|<!-- <key>BRIDGE_AUTH_TOKEN</key> -->|<key>BRIDGE_AUTH_TOKEN</key>|" "$PLIST"
sed -i '' "s|<!-- <string>your-token-here</string> -->|<string>$AUTH_TOKEN</string>|" "$PLIST"

# 8. Install launchd service
echo "--- Installing launchd service ---"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENTS_DIR"

# Stop existing service if running
launchctl bootout "gui/$(id -u)/com.roon-bridge" 2>/dev/null || true

# Copy and load
cp "$PLIST" "$LAUNCH_AGENTS_DIR/com.roon-bridge.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/com.roon-bridge.plist"

echo ""
echo "=== Setup complete ==="
echo ""
echo "The roon-bridge service is now running."
echo "  Health check: curl http://localhost:3100/health"
echo "  Logs:         tail -f ~/Library/Logs/roon-bridge.log"
echo ""
echo "IMPORTANT: Approve the 'Roon Bridge for Claude' extension in"
echo "  Roon Settings > Extensions (one-time only)."
echo ""
echo "To configure Claude clients, add this MCP server config:"
echo ""
echo "  URL: http://<mac-mini-ip>:3100/mcp"
echo "  Auth: Bearer $AUTH_TOKEN"
echo ""
echo "To stop:   launchctl bootout gui/$(id -u)/com.roon-bridge"
echo "To start:  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roon-bridge.plist"
echo "To reload: launchctl kickstart -k gui/$(id -u)/com.roon-bridge"
