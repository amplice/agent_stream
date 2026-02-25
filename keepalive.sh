#!/bin/bash
# Keepalive wrapper — restarts server + bridge if they die
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# OpenClaw gateway token for TTS
export GATEWAY_TOKEN="377b9799e11a9dfa71e24b10f680b270332d9eeb39da9e36"
export GATEWAY_URL="http://127.0.0.1:18789"
# Bridge connects to local server (not Railway) so TTS enrichment works
export NOX_WS="ws://127.0.0.1:3200/ws/openclaw"

restart_bridge() {
  kill "$BRIDGE_PID" 2>/dev/null
  sleep 1
  NOX_WS="$NOX_WS" bun "$SCRIPT_DIR/nox-bridge/run.ts" >> /tmp/nox-bridge.log 2>&1 &
  BRIDGE_PID=$!
  echo "[keepalive] bridge restarted PID=$BRIDGE_PID"
}

BRIDGE_PID=""

while true; do
  echo "[keepalive] starting server..."
  bun "$SCRIPT_DIR/server/bun-server.ts" >> /tmp/nox.log 2>&1 &
  SERVER_PID=$!
  sleep 2

  echo "[keepalive] starting bridge..."
  restart_bridge

  echo "[keepalive] server=$SERVER_PID bridge=$BRIDGE_PID"

  # Monitor both processes — restart bridge if it dies independently
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    sleep 5
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "[keepalive] bridge died, restarting..."
      restart_bridge
    fi
  done

  echo "[keepalive] server died, restarting in 2s..."
  kill "$BRIDGE_PID" 2>/dev/null
  sleep 2
done
