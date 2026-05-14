#!/bin/bash
set -euo pipefail

# roon-bridge installer
#
# Installs roon-bridge as a LaunchAgent that starts automatically when
# your user logs in. Combined with macOS auto-login, this gives you
# boot-time startup without fighting macOS security restrictions.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== roon-bridge installer ==="
echo ""

# 1. Check node is available
NODE_PATH=$(which node 2>/dev/null || true)
if [ -z "$NODE_PATH" ]; then
    echo "ERROR: node not found in PATH. Install Node.js >= 18."
    exit 1
fi
echo "Using node: $NODE_PATH ($(node --version))"

# 2. Install dependencies and build
echo ""
echo "--- Installing dependencies ---"
npm install

echo ""
echo "--- Building TypeScript ---"
npm run build

# 3. Prepare the plist
PLIST_SRC="$SCRIPT_DIR/launchd/com.roon-bridge.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.roon-bridge.plist"

# Stage the plist for path rewriting
cp "$PLIST_SRC" /tmp/com.roon-bridge.plist.tmp

# Update project path (the wrapper script itself uses /opt/homebrew/bin/{node,npm}
# directly, so node path no longer flows through the plist)
sed -i '' "s|/Users/monty/dev/roon-bridge|$SCRIPT_DIR|g" /tmp/com.roon-bridge.plist.tmp

# Update log path
sed -i '' "s|/Users/monty/Library/Logs|$HOME/Library/Logs|g" /tmp/com.roon-bridge.plist.tmp

# 4. Prompt for Roon Core connection
echo ""
CURRENT_HOST=$(grep -A1 'ROON_HOST' /tmp/com.roon-bridge.plist.tmp | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>/\1/')
read -p "Roon Core IP address [$CURRENT_HOST]: " ROON_IP
ROON_IP="${ROON_IP:-$CURRENT_HOST}"

CURRENT_PORT=$(grep -A1 'ROON_PORT' /tmp/com.roon-bridge.plist.tmp | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>/\1/')
read -p "Roon Core port [$CURRENT_PORT]: " ROON_PORT_INPUT
ROON_PORT_INPUT="${ROON_PORT_INPUT:-$CURRENT_PORT}"

# Check if a token already exists in the plist
CURRENT_TOKEN=$(grep -A1 'BRIDGE_AUTH_TOKEN' /tmp/com.roon-bridge.plist.tmp | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>/\1/' || true)
if [ -n "$CURRENT_TOKEN" ] && [ "$CURRENT_TOKEN" != "changeme" ]; then
    echo ""
    echo "Existing auth token found."
    read -p "Generate a new auth token? [y/N]: " REGEN_TOKEN
    if [[ "$REGEN_TOKEN" =~ ^[Yy]$ ]]; then
        AUTH_TOKEN=$(openssl rand -hex 32)
        echo "New token: $AUTH_TOKEN"
    else
        AUTH_TOKEN="$CURRENT_TOKEN"
    fi
else
    AUTH_TOKEN=$(openssl rand -hex 32)
    echo ""
    echo "Generated auth token: $AUTH_TOKEN"
fi

# Apply settings to plist
sed -i '' "s|<string>$CURRENT_HOST</string>|<string>$ROON_IP</string>|" /tmp/com.roon-bridge.plist.tmp
sed -i '' "s|<string>$CURRENT_PORT</string>|<string>$ROON_PORT_INPUT</string>|" /tmp/com.roon-bridge.plist.tmp
if [ -n "$CURRENT_TOKEN" ]; then
    sed -i '' "s|<string>$CURRENT_TOKEN</string>|<string>$AUTH_TOKEN</string>|" /tmp/com.roon-bridge.plist.tmp
fi

# 5. Install LaunchAgent
echo ""
echo "--- Installing LaunchAgent ---"
mkdir -p "$HOME/Library/LaunchAgents"

# Stop existing service if running
launchctl bootout "gui/$(id -u)/com.roon-bridge" 2>/dev/null || true
sleep 1

cp /tmp/com.roon-bridge.plist.tmp "$PLIST_DEST"
rm -f /tmp/com.roon-bridge.plist.tmp

launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

# 6. Set up log rotation
echo ""
echo "--- Configuring log rotation ---"
sudo cp "$SCRIPT_DIR/launchd/roon-bridge.newsyslog.conf" /etc/newsyslog.d/roon-bridge.conf 2>/dev/null || {
    echo "NOTE: Could not install log rotation config (needs sudo)."
    echo "Run: sudo cp $SCRIPT_DIR/launchd/roon-bridge.newsyslog.conf /etc/newsyslog.d/roon-bridge.conf"
}

echo ""
echo "=== Setup complete ==="
echo ""
echo "roon-bridge is now running and will start automatically on login."
echo ""
echo "IMPORTANT — one-time steps:"
echo "  1. Approve 'Roon Bridge for Claude' in Roon Settings > Extensions"
echo "  2. Verify: curl http://localhost:3100/health"
echo ""
echo "For auto-start at boot (recommended for headless Mac Mini):"
echo "  - Enable auto-login: System Settings > Users & Groups > Auto Login"
echo "  - Disable logout on inactivity: System Settings > Privacy & Security > Log Out After > Never"
echo "  - Prevent sleep: System Settings > Energy Saver > Prevent automatic sleeping"
echo "  - Enable: System Settings > Energy Saver > Wake for network access"
echo ""
echo "Claude client config (add to claude_desktop_config.json):"
echo ""
echo '  "roon-bridge": {'
echo '    "command": "npx",'
echo '    "args": ['
echo '      "mcp-remote",'
echo "      \"http://127.0.0.1:3100/mcp\","
echo '      "--header",'
echo "      \"Authorization: Bearer $AUTH_TOKEN\""
echo '    ]'
echo '  }'
echo ""
echo "Manage service:"
echo "  Restart: launchctl kickstart -k gui/$(id -u)/com.roon-bridge"
echo "  Stop:    launchctl bootout gui/$(id -u)/com.roon-bridge"
echo "  Logs:    tail -f ~/Library/Logs/roon-bridge.log"
