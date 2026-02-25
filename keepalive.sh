#!/bin/bash
# Keepalive wrapper — restarts server + bridge if they die
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while true; do
  echo "[keepalive] starting server..."
  bun "$SCRIPT_DIR/server/bun-server.ts" >> /tmp/nox.log 2>&1 &
  SERVER_PID=$!
  sleep 2

  echo "[keepalive] starting bridge..."
  bun "$SCRIPT_DIR/nox-bridge/run.ts" >> /tmp/nox-bridge.log 2>&1 &
  BRIDGE_PID=$!

  echo "[keepalive] server=$SERVER_PID bridge=$BRIDGE_PID"

  # Wait for server to die
  wait $SERVER_PID
  echo "[keepalive] server died, restarting in 2s..."
  kill $BRIDGE_PID 2>/dev/null
  sleep 2
done
