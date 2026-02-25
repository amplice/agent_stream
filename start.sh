#!/bin/bash
# Start nox-stream server + bridge

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[nox] starting server..."
nohup bun "$SCRIPT_DIR/server/bun-server.ts" > /tmp/nox.log 2>&1 &
SERVER_PID=$!
echo "[nox] server PID: $SERVER_PID"

sleep 2

echo "[nox] starting bridge (real OpenClaw log tailer)..."
nohup bun "$SCRIPT_DIR/nox-bridge/run.ts" > /tmp/nox-bridge.log 2>&1 &
BRIDGE_PID=$!
echo "[nox] bridge PID: $BRIDGE_PID"

echo "[nox] all started. logs:"
echo "  server: tail -f /tmp/nox.log"
echo "  bridge: tail -f /tmp/nox-bridge.log"
echo "  health: curl http://127.0.0.1:3200/health"
