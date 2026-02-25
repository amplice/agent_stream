# nox-bridge

OpenClaw skill that bridges the agent to the Nox Virtual Streamer server, emitting events for real-time visual feedback.

## What It Does

This skill connects to the Nox Virtual Streamer WebSocket server and emits events during the agent's lifecycle:
- **thinking** — Agent starts a model call
- **typing** — Per-token output during streaming
- **speaking** — Message sent to user
- **executing** — Exec tool is called
- **idle** — Agent is done processing

## Configuration

Set these environment variables:

```bash
# In your .env or environment
NOX_SERVER_URL=ws://localhost:3201
NOX_BRIDGE_TOKEN=your-secret-token
```

Or configure in your skill settings:

```json
{
  "serverUrl": "ws://localhost:3201",
  "token": "your-secret-token"
}
```

## Installation

1. Place this skill in `~/.openclaw/skills/nox-bridge/` or install via ClawHub:
   ```bash
   clawhub install nox-bridge
   ```

2. Set `NOX_SERVER_URL` and `NOX_BRIDGE_TOKEN` environment variables.

3. Make sure the Nox server is running on port 3201 (default).

## Usage

### Direct Import

```typescript
import { NoxBridge } from './skills/nox-bridge/bridge';

const bridge = new NoxBridge({
  serverUrl: 'ws://localhost:3201/ws/openclaw',
  token: process.env.NOX_BRIDGE_TOKEN
});

await bridge.connect();

// Emit events manually
await bridge.emit('thinking', { model: 'claude-sonnet-4-20250514' });
await bridge.emit('typing', { text: 'Hello' });
await bridge.emit('speaking', { messageId: 'msg_123' });
await bridge.emit('executing', { tool: 'exec', command: 'ls -la' });
await bridge.emit('idle', { duration: 1500 });
```

### Heartbeat Integration

To wire into OpenClaw's heartbeat for automatic event emission, create a heartbeat handler:

**Option 1: Custom Heartbeat File**

Create `~/.openclaw/heartbeat/nox-bridge.ts`:

```typescript
import { NoxBridge } from '../skills/nox-bridge/bridge';

let bridge: NoxBridge | null = null;

export async function onHeartbeat(heartbeat: {
  phase: 'start' | 'thinking' | 'executing' | 'streaming' | 'done';
  details?: {
    model?: string;
    tool?: string;
    command?: string;
    token?: string;
    messageId?: string;
    duration?: number;
  };
}) {
  // Initialize bridge on first heartbeat
  if (!bridge) {
    bridge = new NoxBridge({
      serverUrl: process.env.NOX_SERVER_URL || 'ws://localhost:3201/ws/openclaw',
      token: process.env.NOX_BRIDGE_TOKEN || ''
    });
    await bridge.connect();
  }

  // Emit based on heartbeat phase
  switch (heartbeat.phase) {
    case 'start':
      await bridge.emit('thinking', { model: heartbeat.details?.model });
      break;
    case 'streaming':
      if (heartbeat.details?.token) {
        await bridge.emit('typing', { text: heartbeat.details.token });
      }
      break;
    case 'executing':
      await bridge.emit('executing', {
        tool: heartbeat.details?.tool,
        command: heartbeat.details?.command
      });
      break;
    case 'done':
      await bridge.emit('speaking', { messageId: heartbeat.details?.messageId });
      await bridge.emit('idle', { duration: heartbeat.details?.duration || 0 });
      break;
  }
}
```

**Option 2: Hook into Existing Heartbeat**

If you have an existing heartbeat handler, add the nox-bridge emit calls:

```typescript
// In your heartbeat handler
import { noxBridge } from './skills/nox-bridge/singleton';

// On agent start
await noxBridge.emit('thinking', { model: 'claude-sonnet-4-20250514' });

// On tool execution
await noxBridge.emit('executing', { tool: 'exec', command: 'ls' });

// On token streaming
await noxBridge.emit('typing', { text: 'Hello, ' });

// On message complete
await noxBridge.emit('speaking', { messageId: 'msg_123' });

// On done
await noxBridge.emit('idle', { duration: 1500 });
```

**Option 3: Middleware/Wrapper**

Wrap your agent calls to automatically emit events:

```typescript
import { createNoxBridgeMiddleware } from './skills/nox-bridge/middleware';

const noxMiddleware = createNoxBridgeMiddleware({
  serverUrl: 'ws://localhost:3201/ws/openclaw',
  token: 'your-token'
});

// Wrap your agent call
await noxMiddleware(agent, async (agent) => {
  return await agent.complete(userMessage);
});
```

## Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `thinking` | `{ model: string }` | Agent started reasoning |
| `typing` | `{ text: string }` | Token received (per-token) |
| `speaking` | `{ messageId: string }` | Message sent to user |
| `executing` | `{ tool: string, command: string }` | Tool being executed |
| `idle` | `{ duration: number }` | Agent finished, idle for N ms |

## WebSocket Protocol

The bridge uses this message format:

```json
{
  "type": "thinking|typing|speaking|executing|idle",
  "ts": 1700000000000,
  "payload": { ... }
}
```

The Nox server listens on `ws://localhost:3201/ws/openclaw` and expects a Bearer token in:
- Query string: `?token=YOUR_SECRET`
- Header: `Authorization: Bearer YOUR_SECRET`

## Error Handling

The bridge handles connection drops gracefully:

- Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- Queue events during disconnection, flush on reconnect
- Emit `disconnected` and `reconnected` events for UI feedback

```typescript
bridge.on('disconnected', () => {
  console.log('Nox bridge disconnected, reconnecting...');
});

bridge.on('reconnected', () => {
  console.log('Nox bridge reconnected');
});
```

## Testing

```bash
# Start a local Nox server (if you have one)
cd nox-stream && bun run server/index.ts

# Run the bridge test
bun run skills/nox-bridge/test.ts
```

## Files

- `bridge.ts` — Main NoxBridge class
- `singleton.ts` — Pre-configured singleton instance
- `middleware.ts` — Middleware for automatic event emission
- `hooks.ts` — React/Preact hooks for UI integration
- `test.ts` — Basic connection test