#!/bin/bash
set -euo pipefail

# Install roon-bridge and (optionally) Roon Server as system-level LaunchDaemons.
# These run at boot before any user logs in, as the 'monty' user.
#
# Requires sudo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Installing LaunchDaemons ==="
echo "This will install system services that start at boot."
echo "Requires sudo."
echo ""

# --- roon-bridge ---

echo "--- roon-bridge ---"

# Remove old LaunchAgent if present
if [ -f "$HOME/Library/LaunchAgents/com.roon-bridge.plist" ]; then
    echo "Removing old LaunchAgent..."
    launchctl bootout "gui/$(id -u)/com.roon-bridge" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/com.roon-bridge.plist"
fi

# Build first
echo "Building roon-bridge..."
cd "$SCRIPT_DIR"
npm install --silent
npm run build --silent

# Install LaunchDaemon
echo "Installing LaunchDaemon..."
sudo cp "$SCRIPT_DIR/launchd/com.roon-bridge.plist" /Library/LaunchDaemons/com.roon-bridge.plist
sudo chown root:wheel /Library/LaunchDaemons/com.roon-bridge.plist
sudo chmod 644 /Library/LaunchDaemons/com.roon-bridge.plist

# Load the daemon
sudo launchctl bootout system/com.roon-bridge 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/com.roon-bridge.plist

echo "roon-bridge daemon installed and started."
echo ""

# --- Roon Server (optional) ---

read -p "Also install Roon Server as a LaunchDaemon? [y/N]: " INSTALL_ROON
if [[ "$INSTALL_ROON" =~ ^[Yy]$ ]]; then
    echo ""
    echo "--- Roon Server ---"

    # Check that Roon Server binary exists
    ROON_BIN="/Applications/Roon.app/Contents/RoonServer.app/Contents/MacOS/RoonServer"
    if [ ! -x "$ROON_BIN" ]; then
        echo "ERROR: Roon Server binary not found at $ROON_BIN"
        echo "Install Roon.app from https://roon.app first."
        exit 1
    fi

    # Quit any running Roon instances first
    echo "Stopping any running Roon instances..."
    osascript -e 'quit app "Roon"' 2>/dev/null || true
    osascript -e 'quit app "RoonServer"' 2>/dev/null || true
    sleep 2

    # Disable Roon's built-in "Launch at startup" to avoid conflicts
    echo "NOTE: Disable 'Launch at startup' in the Roon menu bar icon"
    echo "      to avoid running two copies."
    echo ""

    # Install LaunchDaemon
    sudo cp "$SCRIPT_DIR/launchd/com.roonserver.plist" /Library/LaunchDaemons/com.roonserver.plist
    sudo chown root:wheel /Library/LaunchDaemons/com.roonserver.plist
    sudo chmod 644 /Library/LaunchDaemons/com.roonserver.plist

    sudo launchctl bootout system/com.roonserver 2>/dev/null || true
    sudo launchctl bootstrap system /Library/LaunchDaemons/com.roonserver.plist

    echo "Roon Server daemon installed and started."
fi

# --- Log rotation ---

echo ""
echo "--- Log rotation ---"
sudo cp "$SCRIPT_DIR/launchd/roon-bridge.newsyslog.conf" /etc/newsyslog.d/roon-bridge.conf
sudo chown root:wheel /etc/newsyslog.d/roon-bridge.conf
echo "Log rotation configured (5 files, 1MB each, compressed)."

echo ""
echo "=== Done ==="
echo ""
echo "Both services will now start automatically at boot, before login."
echo ""
echo "Manage with:"
echo "  sudo launchctl kickstart -k system/com.roon-bridge    # restart bridge"
echo "  sudo launchctl kickstart -k system/com.roonserver     # restart Roon Server"
echo "  sudo launchctl bootout system/com.roon-bridge         # stop bridge"
echo "  sudo launchctl bootout system/com.roonserver          # stop Roon Server"
echo ""
echo "Logs:"
echo "  tail -f ~/Library/Logs/roon-bridge.log"
echo "  tail -f ~/Library/Logs/roonserver-launchd.log"
echo ""
echo "Health check:"
echo "  curl http://localhost:3100/health"
