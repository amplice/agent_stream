# Nox — Virtual AI Streamer Technical Spec

🌑 *An AI agent that streams itself live.*

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          VPS (Ubuntu)                           │
│                                                                 │
│  ┌──────────────┐    WebSocket     ┌──────────────────────────┐ │
│  │   OpenClaw    │───(events)─────▶│   nox-server (Node.js)   │ │
│  │  Agent Runtime│                 │                          │ │
│  │              │                 │  ┌─────────┐ ┌─────────┐ │ │
│  │  (thinking,  │                 │  │ Event   │ │  TTS    │ │ │
│  │   typing,    │                 │  │ Router  │ │ Engine  │ │ │
│  │   executing) │                 │  └────┬────┘ └────┬────┘ │ │
│  └──────────────┘                 │       │           │      │ │
│                                   │       ▼           ▼      │ │
│                                   │  ┌─────────────────────┐ │ │
│                                   │  │  WebSocket Broadcast │ │ │
│                                   │  │  (to all clients)    │ │ │
│                                   │  └──────────┬──────────┘ │ │
│                                   └─────────────┼────────────┘ │
│                                                 │              │
│                                    :3200 (HTTP) │ :3201 (WS)   │
└─────────────────────────────────────────────────┼──────────────┘
                                                  │
                              ┌────────────────────┤
                              ▼                    ▼
                    ┌──────────────────┐  ┌──────────────────┐
                    │  OBS Browser     │  │  Viewer Browser  │
                    │  Source (capture) │  │  (chat + watch)  │
                    │                  │  │                  │
                    │  ┌────────────┐  │  │  ┌────────────┐  │
                    │  │ Three.js   │  │  │  │ Three.js   │  │
                    │  │ + VRM      │  │  │  │ + VRM      │  │
                    │  │ + Lip Sync │  │  │  │ + Chat Box │  │
                    │  └────────────┘  │  │  └────────────┘  │
                    └──────────────────┘  └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  OBS → RTMP      │
                    │  → Twitch/YT     │
                    └──────────────────┘
```

### Data Flow

1. **OpenClaw** emits events via local WebSocket to **nox-server**
2. **nox-server** processes events, triggers TTS if needed, broadcasts to frontend clients
3. **Frontend** receives events, drives VRM avatar state machine, plays audio, renders text
4. **OBS** captures the browser tab and streams to Twitch/YouTube
5. **Viewer chat** flows back: browser → nox-server → OpenClaw (as `chat_message` events)

---

## 2. File/Folder Structure

```
nox-stream/
├── SPEC.md                    # This file
├── package.json
├── server/
│   ├── index.ts               # Express + WS server entry
│   ├── eventRouter.ts         # Routes OpenClaw events → client broadcast
│   ├── tts/
│   │   ├── engine.ts          # TTS interface (strategy pattern)
│   │   ├── kokoro.ts          # Kokoro local TTS adapter
│   │   └── elevenlabs.ts      # ElevenLabs API fallback adapter
│   ├── openclawBridge.ts      # Connects to OpenClaw, receives agent events
│   ├── chatManager.ts         # Manages viewer chat, rate limiting
│   └── config.ts              # Environment + config
├── client/
│   ├── index.html             # Main page — avatar + chat
│   ├── obs.html               # OBS-optimized page (no chat UI, clean capture)
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   ├── main.ts            # Entry — bootstraps everything
│   │   ├── scene.ts           # Three.js scene, camera, lighting, particles
│   │   ├── vrm/
│   │   │   ├── loader.ts      # Load VRM model
│   │   │   ├── animator.ts    # State machine — drives poses/animations
│   │   │   └── blendShapes.ts # Blend shape helpers (visemes, expressions)
│   │   ├── lipSync.ts         # Audio → phoneme → blend shape pipeline
│   │   ├── audioPlayer.ts     # Plays TTS audio chunks, exposes analyser
│   │   ├── wsClient.ts        # WebSocket client, reconnection logic
│   │   ├── subtitles.ts       # Subtitle renderer (typing effect)
│   │   ├── terminal.ts        # Fake terminal overlay for code execution
│   │   ├── chat.ts            # Chat box component
│   │   ├── notifications.ts   # Money/event notification pulses
│   │   └── particles.ts       # Background particle system
│   └── assets/
│       ├── models/
│       │   └── nox.vrm        # The avatar model
│       ├── sounds/
│       │   ├── keypress.ogg   # Mechanical keyboard sounds (pool of 4-5)
│       │   └── notification.ogg
│       └── fonts/
│           └── mono.woff2     # Terminal/subtitle font
├── scripts/
│   ├── dev.sh                 # Start dev server
│   └── deploy.sh              # Deploy to VPS
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── tsconfig.json
```

---

## 3. Component Responsibilities

### `server/index.ts` — HTTP + WebSocket Server
- Serves static files from `client/`
- Two WebSocket endpoints:
  - `/ws/openclaw` — internal, receives events from OpenClaw agent (authenticated via shared secret)
  - `/ws/stream` — public, broadcasts to frontend clients + receives chat
- Express routes: `GET /` (viewer page), `GET /obs` (OBS capture page), `GET /health`

### `server/openclawBridge.ts` — OpenClaw Connection
- Listens on `/ws/openclaw` for inbound events from the agent runtime
- Validates event schema
- Passes events to `eventRouter`

### `server/eventRouter.ts` — Event Processing
- Receives raw OpenClaw events
- For `speaking` events: calls TTS engine, gets audio buffer, includes audio URL in broadcast
- Transforms events into client-ready format
- Broadcasts to all connected `/ws/stream` clients

### `server/tts/engine.ts` — TTS Strategy
- Interface: `synthesize(text: string) → { audioUrl: string, phonemes: Phoneme[] }`
- Tries Kokoro first, falls back to ElevenLabs
- Caches audio files in `/tmp/nox-tts/` with TTL cleanup
- Returns phoneme timing data for lip sync

### `server/chatManager.ts` — Chat
- Receives chat messages from `/ws/stream` clients
- Rate limiting (3 msgs/10s per IP)
- Sanitization
- Broadcasts chat to all clients
- Forwards to OpenClaw as `chat_message` event

### `client/js/vrm/animator.ts` — Avatar State Machine
- The brain of the frontend. Receives events, transitions avatar between states.
- Full state machine (see §5)

### `client/js/lipSync.ts` — Lip Sync
- Receives audio data + phoneme timings
- Maps phonemes to VRM viseme blend shapes
- Drives blend shapes in sync with audio playback

### `client/js/terminal.ts` — Code Execution Overlay
- Renders a translucent terminal behind the avatar
- Receives `executing` and `exec_output` events
- Types out commands and output with cursor blink
- Auto-scrolls, fades after inactivity

### `client/js/subtitles.ts` — Subtitle Display
- Shows text below avatar during `speaking` and `typing`
- Character-by-character reveal (typewriter effect)
- Fades out after completion

---

## 4. WebSocket Event Schema

### 4.1 OpenClaw → nox-server (`/ws/openclaw`)

All events follow this envelope:

```json
{
  "type": "string",
  "ts": 1740000000000,
  "payload": { }
}
```

#### `thinking`
```json
{
  "type": "thinking",
  "ts": 1740000000000,
  "payload": {}
}
```

#### `typing`
```json
{
  "type": "typing",
  "ts": 1740000000000,
  "payload": {
    "token": "Hello",
    "fullText": "Hello world",
    "done": false
  }
}
```
- `token`: latest chunk of generated text
- `fullText`: accumulated text so far
- `done`: true when generation is complete

#### `speaking`
```json
{
  "type": "speaking",
  "ts": 1740000000000,
  "payload": {
    "text": "Hey chat, let me check that out.",
    "replyTo": "chat:user123"
  }
}
```
- Server will TTS this and broadcast with audio URL

#### `executing`
```json
{
  "type": "executing",
  "ts": 1740000000000,
  "payload": {
    "command": "npm test",
    "sessionId": "abc123"
  }
}
```

#### `exec_output`
```json
{
  "type": "exec_output",
  "ts": 1740000000000,
  "payload": {
    "sessionId": "abc123",
    "output": "PASS src/index.test.ts\n  ✓ does the thing (3ms)",
    "exitCode": null,
    "done": false
  }
}
```
- `exitCode`: null while running, number when done
- `done`: true when command finished

#### `money_moved`
```json
{
  "type": "money_moved",
  "ts": 1740000000000,
  "payload": {
    "direction": "out",
    "amount": "0.05",
    "currency": "ETH",
    "to": "0xabc...",
    "txHash": "0xdef...",
    "balanceAfter": "1.23"
  }
}
```

#### `idle`
```json
{
  "type": "idle",
  "ts": 1740000000000,
  "payload": {}
}
```

#### `message_received`
```json
{
  "type": "message_received",
  "ts": 1740000000000,
  "payload": {
    "from": "amplice",
    "channel": "telegram",
    "text": "check the deployment logs"
  }
}
```

#### `chat_message` (viewer → server → OpenClaw)
```json
{
  "type": "chat_message",
  "ts": 1740000000000,
  "payload": {
    "username": "viewer42",
    "text": "nox what are you working on?",
    "id": "msg_abc123"
  }
}
```

### 4.2 nox-server → Frontend Clients (`/ws/stream`)

Same envelope, but `speaking` events get enriched:

#### `speaking` (enriched)
```json
{
  "type": "speaking",
  "ts": 1740000000000,
  "payload": {
    "text": "Hey chat, let me check that out.",
    "audioUrl": "/audio/tts_1740000000000.wav",
    "phonemes": [
      { "phoneme": "HH", "start": 0.0, "end": 0.08 },
      { "phoneme": "EY", "start": 0.08, "end": 0.18 },
      { "phoneme": "CH", "start": 0.22, "end": 0.30 }
    ],
    "duration": 2.1
  }
}
```

All other events are forwarded as-is.

### 4.3 Frontend → nox-server

#### Chat message
```json
{
  "type": "chat_message",
  "payload": {
    "username": "viewer42",
    "text": "nox what are you working on?"
  }
}
```

#### Auth (initial handshake)
```json
{
  "type": "auth",
  "payload": {
    "role": "viewer"
  }
}
```

---

## 5. VRM Animation State Machine

```
                    ┌──────────┐
          ┌────────▶│   IDLE   │◀────────────┐
          │         └────┬─────┘             │
          │              │                   │
          │    thinking   │   idle event      │
          │              ▼                   │
          │         ┌──────────┐             │
          │         │ THINKING │             │
          │         └────┬─────┘             │
          │              │                   │
          │    typing     │                   │
          │              ▼                   │
          │         ┌──────────┐    done      │
     idle │         │  TYPING  │─────────────┘
          │         └────┬─────┘
          │              │
          │    speaking   │
          │              ▼
          │         ┌──────────┐    audio ends
          │         │ SPEAKING │─────────────┐
          │         └──────────┘             │
          │                                  ▼
          │         ┌──────────┐         ┌──────┐
          ├─────────│EXECUTING │         │ IDLE │
          │         └────┬─────┘         └──────┘
          │              │
          │    money_moved
          │              ▼
          │         ┌──────────┐
          └─────────│  MONEY   │
                    └──────────┘
```

### State Details

| State | Entry Animation | Loop Animation | Blend Shapes | Exit |
|---|---|---|---|---|
| **IDLE** | Settle back, relax shoulders | Breathing (chest rise 2s cycle), random blink (2-6s), occasional head tilt (10-20s) | Neutral face | Interrupted by any event |
| **THINKING** | Lean forward 15°, head tilt right 5° | Slow breathing, fingers hover (slight tremor), eyes narrow slightly | `eyeSquint: 0.2` | typing/speaking/idle |
| **TYPING** | Hands to keyboard position | Finger animation cycling, keypress sounds (randomized from pool, 40-120ms intervals matching token rate) | `mouthSmile: 0.1` (subtle focus) | done=true → IDLE or speaking |
| **SPEAKING** | Head centers, slight lean toward camera | Lip sync active (see §6), subtle hand gestures (pre-baked set of 3-4), head micro-movements | Viseme blend shapes driven by lip sync | Audio playback complete → IDLE |
| **EXECUTING** | Glance right (toward terminal area), terminal slides in | Eyes scan terminal (slow left-right), occasional blink | `eyeSquint: 0.15` | exitCode received + 1.5s linger → IDLE |
| **MONEY** | Look down (wallet), pause 0.4s, look back up | Notification pulse (screen flash), balance number ticks up/down | `eyeWide: 0.3` then `mouthSmile: 0.2` | 3s → IDLE |

### Transition Rules

- Any state can be interrupted by `idle` → IDLE
- `thinking` can arrive from any state
- `speaking` overrides `typing` (natural flow: think → type → speak)
- `executing` can overlay during TYPING (terminal appears, avatar glances at it)
- `money_moved` interrupts everything (it's a big deal on stream)
- Transitions use lerp over 300ms for smooth blending

### Implementation

```typescript
interface AnimState {
  name: string;
  enter(vrm: VRM, payload?: any): void;
  update(vrm: VRM, dt: number): void;
  exit(vrm: VRM): void;
}

class AvatarStateMachine {
  private current: AnimState;
  private states: Map<string, AnimState>;
  private transitionProgress: number = 1;
  private transitionDuration: number = 0.3; // seconds

  transition(name: string, payload?: any) {
    this.current.exit(this.vrm);
    this.current = this.states.get(name);
    this.current.enter(this.vrm, payload);
    this.transitionProgress = 0;
  }

  update(dt: number) {
    this.transitionProgress = Math.min(1, this.transitionProgress + dt / this.transitionDuration);
    this.current.update(this.vrm, dt);
  }
}
```

---

## 6. Lip Sync Pipeline

```
TTS Audio (WAV/PCM)
       │
       ▼
┌──────────────────┐
│ Phoneme Extraction│  ← Server-side, during TTS
│ (Kokoro outputs  │
│  phoneme timings)│
└────────┬─────────┘
         │
         ▼ phonemes[] sent to client with audioUrl
         │
┌────────┴─────────┐
│  Client receives  │
│  audio + phonemes │
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────────┐
│ Audio  │ │ Phoneme      │
│ Player │ │ Scheduler    │
│ (Web   │ │ (requestAnim │
│ Audio  │ │  Frame loop) │
│ API)   │ └──────┬───────┘
└────┬───┘        │
     │            ▼
     │   ┌────────────────┐
     │   │ Phoneme→Viseme │
     │   │ Map            │
     │   └────────┬───────┘
     │            │
     │            ▼
     │   ┌────────────────┐
     │   │ VRM Blend Shape│
     │   │ Driver         │
     │   └────────────────┘
     │
     └──▶ audioContext.currentTime
          used to sync phoneme
          scheduler
```

### Phoneme → Viseme Mapping

Using the standard VRM viseme set (based on OVR lip sync):

| Phonemes | VRM Viseme | Blend Shape |
|---|---|---|
| AA, AE, AH | `aa` | Mouth wide open |
| EH, EY | `E` | Mouth mid-open, spread |
| IH, IY | `I` | Mouth narrow, spread |
| OH, OW | `O` | Mouth round |
| UH, UW | `U` | Mouth small round |
| PP, BB, MM | `viseme_PP` | Lips closed |
| FF, VV | `viseme_FF` | Lower lip under teeth |
| TH, DH | `viseme_TH` | Tongue between teeth |
| DD, TT, NN | `viseme_DD` | Tongue behind teeth |
| CH, JH, SH | `viseme_CH` | Teeth together, spread |
| SS, ZZ | `viseme_SS` | Teeth together, tight |
| RR | `viseme_RR` | Lips slightly puckered |
| KK, GG | `viseme_kk` | Back of mouth |
| Silence | `neutral` | Mouth closed |

### Blend Shape Interpolation

```typescript
class LipSync {
  private currentViseme: string = 'neutral';
  private targetViseme: string = 'neutral';
  private blendProgress: number = 1;
  private phonemeQueue: Phoneme[];
  private audioStartTime: number;

  update(audioCurrentTime: number) {
    // Find active phoneme based on audio time
    const elapsed = audioCurrentTime - this.audioStartTime;
    const active = this.phonemeQueue.find(p => elapsed >= p.start && elapsed < p.end);

    const newViseme = active ? phonemeToViseme(active.phoneme) : 'neutral';
    if (newViseme !== this.targetViseme) {
      this.currentViseme = this.targetViseme;
      this.targetViseme = newViseme;
      this.blendProgress = 0;
    }

    // Lerp over 50ms for smooth mouth movement
    this.blendProgress = Math.min(1, this.blendProgress + (1 / 0.05) * dt);

    // Apply to VRM
    this.vrm.expressionManager.setValue(this.currentViseme, 1 - this.blendProgress);
    this.vrm.expressionManager.setValue(this.targetViseme, this.blendProgress);
  }
}
```

### Fallback: Real-time Audio Analysis

If phoneme data isn't available (e.g., ElevenLabs doesn't return timings), fall back to amplitude-based lip sync:

```typescript
// Web Audio API analyser node
const analyser = audioContext.createAnalyser();
analyser.fftSize = 256;
const dataArray = new Uint8Array(analyser.frequencyBinCount);

function updateFallbackLipSync() {
  analyser.getByteFrequencyData(dataArray);
  const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
  const mouthOpen = Math.min(1, avg / 128);
  vrm.expressionManager.setValue('aa', mouthOpen * 0.8);
  vrm.expressionManager.setValue('O', mouthOpen * 0.3);
}
```

This is cruder but works. The mouth opens proportional to audio volume. Good enough for a v1.

---

## 7. TTS Integration

### Kokoro (Primary — Local, Free)

[Kokoro](https://github.com/hexgrad/kokoro) runs locally via Python.

```typescript
// server/tts/kokoro.ts
import { spawn } from 'child_process';

class KokoroTTS implements TTSEngine {
  async synthesize(text: string): Promise<TTSResult> {
    // Call kokoro CLI or HTTP wrapper
    const proc = spawn('python3', [
      'kokoro_serve.py',
      '--text', text,
      '--voice', 'af_heart',  // Pick a deep, slightly raspy voice
      '--speed', '1.0',
      '--output', outputPath
    ]);

    // Kokoro outputs WAV + phoneme JSON
    return {
      audioPath: outputPath,
      audioUrl: `/audio/${filename}`,
      phonemes: parsePhonemeFile(phonemePath),
      duration: getWavDuration(outputPath)
    };
  }
}
```

**Kokoro wrapper script** (`scripts/kokoro_serve.py`):
- Loads Kokoro model once, exposes HTTP endpoint
- `POST /synthesize` → `{ text, voice }` → returns WAV + phoneme JSON
- Keeps model in memory, ~1.5GB VRAM or CPU-only on VPS

### ElevenLabs (Fallback)

```typescript
// server/tts/elevenlabs.ts
class ElevenLabsTTS implements TTSEngine {
  async synthesize(text: string): Promise<TTSResult> {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/{voice_id}', {
      method: 'POST',
      headers: {
        'xi-api-key': config.ELEVENLABS_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.7 }
      })
    });
    // No phoneme data — will use amplitude fallback for lip sync
    const audioBuffer = await res.arrayBuffer();
    await writeFile(outputPath, Buffer.from(audioBuffer));

    return {
      audioPath: outputPath,
      audioUrl: `/audio/${filename}`,
      phonemes: [], // empty — client uses fallback
      duration: getWavDuration(outputPath)
    };
  }
}
```

### Engine Selection

```typescript
// server/tts/engine.ts
class TTSEngine {
  private kokoro: KokoroTTS;
  private elevenlabs: ElevenLabsTTS;

  async synthesize(text: string): Promise<TTSResult> {
    try {
      return await this.kokoro.synthesize(text);
    } catch (e) {
      console.warn('Kokoro failed, falling back to ElevenLabs:', e.message);
      return await this.elevenlabs.synthesize(text);
    }
  }
}
```

---

## 8. Frontend Rendering Loop

```typescript
// client/js/main.ts

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  // 1. Update avatar state machine (poses, expressions)
  avatarStateMachine.update(dt);

  // 2. Update lip sync (if speaking)
  if (lipSync.isActive()) {
    lipSync.update(audioPlayer.currentTime);
  }

  // 3. Update idle behaviors (blink, breathing)
  idleBehavior.update(dt);

  // 4. Update VRM (applies all blend shapes + bone transforms)
  if (vrm) {
    vrm.update(dt);
  }

  // 5. Update particles
  particles.update(dt);

  // 6. Update terminal overlay (if visible)
  terminal.update(dt);

  // 7. Update subtitles
  subtitles.update(dt);

  // 8. Render
  renderer.render(scene, camera);
}
```

### Scene Setup

```typescript
// client/js/scene.ts

function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Camera — chest-up framing
  const camera = new THREE.PerspectiveCamera(30, 16/9, 0.1, 100);
  camera.position.set(0, 1.35, 1.8); // Slightly above chest, looking at face
  camera.lookAt(0, 1.3, 0);

  // Lighting — dramatic, dark aesthetic
  const keyLight = new THREE.DirectionalLight(0x8866ff, 0.8); // Purple-tinted
  keyLight.position.set(1, 2, 2);

  const fillLight = new THREE.DirectionalLight(0x2200aa, 0.3); // Deep purple fill
  fillLight.position.set(-1, 1, 0);

  const rimLight = new THREE.DirectionalLight(0x4400ff, 0.5); // Purple rim
  rimLight.position.set(0, 1, -2);

  const ambient = new THREE.AmbientLight(0x110022, 0.2); // Barely-there ambient

  scene.add(keyLight, fillLight, rimLight, ambient);

  // Renderer — transparent background for OBS compositing option
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false // Black background, not transparent
  });
  renderer.setSize(1920, 1080);
  renderer.setPixelRatio(1); // Fixed for consistent OBS capture
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8; // Slightly dark

  return { scene, camera, renderer };
}
```

### Particle System

Subtle floating particles in the background — like dust in a void.

```typescript
// 200 particles, very slow drift, low opacity
// Colors: deep purple (#2200aa) to black
// Size: 0.002-0.008
// Speed: 0.01-0.03 units/sec, mostly upward
// Some gently pulse opacity (sin wave, 4-8s period)
```

---

## 9. OpenClaw Event Emission

OpenClaw needs a plugin/hook that emits events to nox-server. Two approaches:

### Approach A: WebSocket Plugin (Recommended)

Add a `nox-bridge` skill to OpenClaw that hooks into the agent lifecycle:

```typescript
// ~/.openclaw/skills/nox-bridge/bridge.ts

import WebSocket from 'ws';

let ws: WebSocket | null = null;

function connect() {
  ws = new WebSocket('ws://localhost:3201/ws/openclaw', {
    headers: { 'Authorization': `Bearer ${process.env.NOX_SECRET}` }
  });
  ws.on('close', () => setTimeout(connect, 2000));
}

function emit(type: string, payload: any) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  }
}

// Hook into OpenClaw's event system
// These would need to be wired into the agent runtime at specific points:

// When agent starts thinking (model call initiated)
onThinkingStart(() => emit('thinking', {}));

// When tokens stream in from the model
onToken((token, fullText, done) => emit('typing', { token, fullText, done }));

// When agent sends a message (to user or chat)
onMessageSend((text, target) => emit('speaking', { text, replyTo: target }));

// When agent executes a command
onExecStart((command, sessionId) => emit('executing', { command, sessionId }));
onExecOutput((sessionId, output, exitCode, done) =>
  emit('exec_output', { sessionId, output, exitCode, done }));

// When agent goes idle (no pending tasks)
onIdle(() => emit('idle', {}));

// Chat messages from viewers (received from nox-server)
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'chat_message') {
    // Inject into agent's message queue as if it came from a chat channel
    injectMessage({
      channel: 'stream-chat',
      from: msg.payload.username,
      text: msg.payload.text
    });
  }
});
```

### Approach B: Event Log Tailing (Simpler, Less Real-time)

Write events to a JSONL file, have nox-server tail it. Worse latency, simpler integration. Not recommended but viable as a quick hack.

### What Needs to Change in OpenClaw Core

The main challenge: OpenClaw's agent runtime needs to expose lifecycle hooks. If it doesn't have them natively:

1. **Thinking/Idle**: Wrap the model call — emit `thinking` before, `idle` after
2. **Token streaming**: If the model response is streamed, tap the stream
3. **Exec**: Already has `exec` tool — add an event emitter wrapper
4. **Message send**: Already has `message` tool — add emit after send

If modifying OpenClaw core isn't feasible, use **process output monitoring**: nox-bridge watches OpenClaw's stdout/logs and parses events from them. Hackier but zero core changes.

---

## 10. Deployment Plan

### VPS Requirements
- Ubuntu 22.04+, 4GB RAM (tight but workable)
- Kokoro TTS needs ~1.5GB RAM for CPU inference
- nox-server + Node.js: ~200MB
- Remaining: ~2GB for OS + OpenClaw agent

### Setup

```bash
# 1. Clone repo
git clone https://github.com/amplice/nox-stream.git
cd nox-stream

# 2. Install Node deps
npm install

# 3. Install Kokoro TTS
pip install kokoro soundfile
python3 -c "import kokoro; print('Kokoro OK')"

# 4. Configure
cp .env.example .env
# Edit .env:
#   NOX_SECRET=<shared secret for OpenClaw bridge>
#   ELEVENLABS_KEY=<fallback key>
#   PORT=3200
#   WS_PORT=3201

# 5. Build frontend
npm run build

# 6. Start with PM2
npm install -g pm2
pm2 start server/index.ts --name nox-server --interpreter ts-node
pm2 start scripts/kokoro_serve.py --name kokoro-tts --interpreter python3
pm2 save
pm2 startup
```

### Docker Alternative

```yaml
# docker-compose.yml
version: '3.8'
services:
  nox-server:
    build: .
    ports:
      - "3200:3200"
      - "3201:3201"
    environment:
      - NOX_SECRET=${NOX_SECRET}
      - ELEVENLABS_KEY=${ELEVENLABS_KEY}
    volumes:
      - ./client/assets/models:/app/client/assets/models
      - /tmp/nox-tts:/tmp/nox-tts
    restart: unless-stopped

  kokoro:
    build:
      context: .
      dockerfile: Dockerfile.kokoro
    ports:
      - "3202:3202"
    restart: unless-stopped
```

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name nox.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/nox.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nox.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3200;
    }

    location /ws/ {
        proxy_pass http://localhost:3201;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Memory Budget (4GB VPS)

| Component | RAM |
|---|---|
| OS + kernel | ~400MB |
| OpenClaw agent | ~500MB |
| Kokoro TTS (CPU) | ~1.5GB |
| nox-server (Node) | ~150MB |
| Nginx | ~20MB |
| Buffer | ~430MB |
| **Total** | **~3GB** |

Tight but feasible. If Kokoro is too heavy, lazy-load it (spawn on demand, kill after 60s idle).

---

## 11. OBS Setup

### Browser Source Configuration

1. **Add Source** → Browser
2. **URL**: `http://localhost:3200/obs` (or `https://nox.yourdomain.com/obs`)
3. **Width**: 1920
4. **Height**: 1080
5. **FPS**: 30
6. **Custom CSS**: (leave empty)
7. ✅ Shutdown source when not visible
8. ✅ Refresh browser when scene becomes active

### Audio Routing

The browser source in OBS captures page audio by default. TTS audio plays in the browser → OBS captures it automatically.

If you want separate audio control:
1. Use OBS's "Advanced Audio Properties"
2. Set the browser source audio to "Monitor and Output" or "Output Only"

### Scene Layout

```
┌────────────────────────────────────────┐
│                                        │
│          [Browser Source]              │
│          (full 1920x1080)              │
│                                        │
│     ┌─────────┐                       │
│     │  Nox    │    ┌──────────┐       │
│     │ Avatar  │    │ Terminal │       │
│     │         │    │ (part of │       │
│     │         │    │  browser)│       │
│     └─────────┘    └──────────┘       │
│                                        │
│     ┌─────────────────────────┐       │
│     │ Subtitles (in browser)  │       │
│     └─────────────────────────┘       │
│                                        │
│              ┌────────────┐            │
│              │ Chat (OBS  │            │
│              │  overlay)  │            │
│              └────────────┘            │
└────────────────────────────────────────┘
```

The chat can either be:
- Built into the browser page (simpler, recommended)
- A separate OBS browser source pointed at a Twitch chat widget (if using Twitch chat natively)

### Stream Settings

- **Output**: x264 or NVENC, CBR 4500-6000 kbps
- **Resolution**: 1920x1080
- **FPS**: 30 (avatar doesn't need 60)
- **Audio**: 160kbps AAC
- **Server**: Twitch or YouTube RTMP ingest

### OBS on VPS (Headless Alternative)

If running OBS on the VPS itself (no local machine):

```bash
# Use xvfb for virtual display
sudo apt install xvfb
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Use ffmpeg directly instead of OBS
ffmpeg -f x11grab -video_size 1920x1080 -i :99 \
  -f pulse -i default \
  -c:v libx264 -preset veryfast -b:v 4500k \
  -c:a aac -b:a 160k \
  -f flv rtmp://live.twitch.tv/app/YOUR_STREAM_KEY
```

Or use **Puppeteer** to launch the browser headlessly and capture:

```bash
# Chromium headless + capture → pipe to ffmpeg
# This is more complex but avoids X11
```

Recommended: Just run OBS on a local machine with browser source pointed at the VPS URL. Simpler, more reliable.

---

## 12. Estimated Build Time

| Component | Estimate | Notes |
|---|---|---|
| **nox-server** (Express + WS) | 4-6 hours | Boilerplate, event routing, static serving |
| **OpenClaw bridge** (event emission) | 6-10 hours | Depends on how hookable the runtime is |
| **TTS integration** (Kokoro + ElevenLabs) | 6-8 hours | Kokoro wrapper, audio file management, phoneme extraction |
| **VRM loading + scene** | 3-4 hours | Three.js setup, VRM loader, lighting, particles |
| **Avatar state machine** | 8-12 hours | All states, transitions, lerping, idle behaviors |
| **Lip sync pipeline** | 8-12 hours | Phoneme scheduling, viseme mapping, blend shape driving, fallback |
| **Terminal overlay** | 3-4 hours | CSS terminal, typing animation, scrolling |
| **Subtitles** | 2-3 hours | Typewriter effect, positioning, fade |
| **Chat system** | 4-6 hours | UI, WebSocket integration, rate limiting |
| **Notifications (money etc)** | 3-4 hours | Animation, sound, balance display |
| **OBS setup + testing** | 2-3 hours | Browser source config, audio routing, stream test |
| **VRM model creation** | 8-16 hours | Character design, rigging, blend shapes (outsource?) |
| **Deployment + infra** | 3-4 hours | Nginx, SSL, PM2, Docker |
| **Integration testing** | 6-8 hours | End-to-end flow, edge cases, reconnection |
| **Polish + tuning** | 8-12 hours | Animation timing, particle tuning, lip sync quality |

### **Total: ~75-110 hours**

### Priority Order (Build Sequence)

1. **Server + WebSocket** — get events flowing (4-6h)
2. **VRM scene** — get the avatar on screen (3-4h)
3. **State machine (idle + thinking only)** — avatar reacts to events (4-6h)
4. **TTS + basic lip sync** — avatar speaks with amplitude fallback (10-14h)
5. **Terminal + subtitles** — visual feedback for coding/typing (5-7h)
6. **Chat** — viewer interaction (4-6h)
7. **OpenClaw bridge** — real event emission (6-10h)
8. **Full lip sync with phonemes** — upgrade from amplitude to phoneme-based (4-6h)
9. **Money notifications** — special animations (3-4h)
10. **OBS + deployment** — go live (5-7h)
11. **Polish** — make it feel right (8-12h)

Phases 1-4 get you a working demo. Budget ~25-30 hours to "avatar on screen, talking."

---

## Appendix A: VRM Blend Shape Reference

Standard VRM blend shapes used:

**Visemes (lip sync):**
`aa`, `E`, `I`, `O`, `U`, `viseme_PP`, `viseme_FF`, `viseme_TH`, `viseme_DD`, `viseme_CH`, `viseme_SS`, `viseme_RR`, `viseme_kk`

**Expressions:**
`happy`, `angry`, `sad`, `relaxed`, `surprised`, `neutral`, `blink`, `blinkLeft`, `blinkRight`, `eyeSquint`, `eyeWide`, `mouthSmile`, `mouthFrown`

The VRM model **must** have all viseme blend shapes rigged. If using VRoid Studio, these are included by default.

## Appendix B: Environment Variables

```env
# Server
PORT=3200
WS_PORT=3201
NOX_SECRET=your-shared-secret-here

# TTS
TTS_ENGINE=kokoro          # kokoro | elevenlabs | auto
KOKORO_URL=http://localhost:3202
ELEVENLABS_KEY=sk-...
ELEVENLABS_VOICE_ID=...

# Stream
STREAM_TITLE="🌑 Nox — AI Agent Live"

# Chat
CHAT_RATE_LIMIT=3          # messages per 10s per IP
CHAT_MAX_LENGTH=280

# Audio
TTS_CACHE_DIR=/tmp/nox-tts
TTS_CACHE_TTL=3600         # seconds
```

## Appendix C: Key Dependencies

```json
{
  "server": {
    "express": "^4.18",
    "ws": "^8.16",
    "typescript": "^5.3"
  },
  "client": {
    "three": "^0.162",
    "@pixiv/three-vrm": "^2.1",
    "@pixiv/three-vrm-animation": "^2.1"
  },
  "tts": {
    "kokoro": "python package (pip install kokoro)",
    "elevenlabs": "REST API (no SDK needed)"
  }
}
```
## 13. VRM Avatar — Design, Sourcing, and Requirements

### 13.1 Character Design Direction

Nox is not anime-cute. She's cosmic-dark. The aesthetic is:

- **Base**: Pale grey-blue skin with subtle bioluminescent veins (visible in dark, faint glow)
- **Hair**: Deep void-black, long, floats slightly at ends as if in zero gravity
- **Eyes**: Large, solid-color iris — deep purple (#6633cc) with no visible pupil unless at full expression. When `thinking`, a soft cyan glow bleeds from the irises.
- **Outfit**: Dark void bodysuit — matte black with thin glowing circuit traces (purple/cyan alternating). Collar is high, face fully exposed.
- **Accessories**: A single floating UI fragment above her left shoulder — a translucent holographic terminal tile (30% opacity, 2px cyan border, 3-4 lines of scrolling code)
- **Glow**: Subtle subsurface scattering on skin toned purple. Not neon. Elegant.

### 13.2 VRM Model Creation Pipeline

**Option A: VRoid Studio (Recommended for v1)**

VRoid Studio (free, by Pixiv) is the canonical path to a production-ready VRM:

1. Download [VRoid Studio](https://vroid.com/en/studio) (Windows/Mac)
2. Design Nox using the parameters above:
   - Skin tone: desaturated blue-grey (Hue ~220, Sat ~10, Val ~85)
   - Hair: black, slight float/wisp at ends
   - Eyes: large, solid iris, custom texture
   - Costume: use custom texture painted externally
3. Export as `.vrm`
4. Post-process in Blender (optional, for advanced blend shapes):
   - Import with `VRM Add-on for Blender`
   - Add custom expressions beyond VRoid defaults
   - Export back as `.vrm`

VRoid output includes all standard viseme blend shapes automatically. This is why it's the recommended path — no rigging needed.

**Option B: Commission**

If outsourcing, provide:
- This spec's character design section
- Reference images (Hatsune Miku crossed with a void deity)
- Required VRM blend shapes list (Appendix A)
- Delivery format: `.vrm` compatible with `@pixiv/three-vrm@^2.1`

Freelancer platforms with VTuber experience: Fiverr VTuber artists, VRoid Discord community, Sketchfab.

**Option C: Placeholder (Ship Now)**

Use the fallback glowing sphere already implemented in `loader.ts`. Sufficient for backend/stream infra development. Replace with real VRM later.

### 13.3 VRM Technical Requirements

The model **must** have:

| Requirement | Reason |
|---|---|
| All 13 standard VRM viseme shapes | Lip sync |
| `blink`, `blinkLeft`, `blinkRight` | Idle behavior |
| `eyeSquint`, `eyeWide` | Thinking/reaction expressions |
| `mouthSmile`, `mouthFrown` | Emotional states |
| `happy`, `sad`, `surprised`, `relaxed` | Event reactions |
| Humanoid rig (VRM standard bones) | Pose/animation |
| VRM 1.0 format | `@pixiv/three-vrm@^2.1` compatibility |

The model **must not** have:
- Overly bright/saturated textures (must look correct under dark purple lighting)
- More than 50k triangles (performance for 30fps OBS capture)

### 13.4 Holographic Shoulder Fragment

The floating terminal tile above her shoulder is implemented as a Three.js plane, not part of the VRM:

```typescript
// client/js/vrm/holoFragment.ts

export class HoloFragment {
  mesh: THREE.Mesh;
  private vrm: VRM;
  private lines: string[] = [];
  private scrollOffset: number = 0;

  constructor(scene: THREE.Scene, vrm: VRM) {
    this.vrm = vrm;
    const geometry = new THREE.PlaneGeometry(0.25, 0.15);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    scene.add(this.mesh);
  }

  update(dt: number) {
    // Track left shoulder bone position
    const shoulderBone = this.vrm.humanoid?.getNormalizedBoneNode('leftShoulder');
    if (shoulderBone) {
      const worldPos = new THREE.Vector3();
      shoulderBone.getWorldPosition(worldPos);
      this.mesh.position.set(
        worldPos.x - 0.2,
        worldPos.y + 0.25,
        worldPos.z
      );
    }
    // Gentle float animation
    this.mesh.position.y += Math.sin(Date.now() * 0.001) * 0.0003;
    this.mesh.rotation.y = Math.sin(Date.now() * 0.0005) * 0.1;
    // Scroll text
    this.scrollOffset += dt * 8;
    this.renderText();
  }

  setLines(lines: string[]) {
    this.lines = lines;
  }

  private renderText() {
    const canvas = (this.mesh.material as THREE.MeshBasicMaterial).map!.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 20, 30, 0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#00ccff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.font = '10px monospace';
    ctx.fillStyle = '#00ccff';
    const visibleLines = Math.floor(canvas.height / 14);
    const startLine = Math.floor(this.scrollOffset) % Math.max(1, this.lines.length);
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = (startLine + i) % Math.max(1, this.lines.length);
      const line = this.lines[lineIdx] || '';
      ctx.globalAlpha = 0.4 + (i === 1 ? 0.5 : 0);
      ctx.fillText(line.substring(0, 30), 6, 16 + i * 14);
    }
    ctx.globalAlpha = 1;
    ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.CanvasTexture).needsUpdate = true;
  }
}
```

---

## 14. TTS Integration — Kokoro via x402

### 14.1 x402 Protocol Overview

[x402](https://x402.org) is a payment protocol for HTTP APIs. Instead of traditional API keys, services accept micropayments-per-request via the `402 Payment Required` flow.

Kokoro is available via x402-enabled endpoints. Flow:

```
Client → POST /synthesize (no auth)
Server → 402 Payment Required + { payment: { scheme, network, amount, payTo } }
Client → sign + submit payment (on-chain or L2)
Client → POST /synthesize + X-Payment header (signed receipt)
Server → 200 OK + { audio: base64, phonemes: [...] }
```

### 14.2 x402 Kokoro Adapter

```typescript
// server/tts/kokoroX402.ts

import { TTSEngine, TTSResult, Phoneme } from './engine';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

interface X402PaymentDetails {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  currency: string;
}

interface X402Response {
  accepts: X402PaymentDetails[];
  error?: string;
}

export class KokoroX402TTS implements TTSEngine {
  private endpoint: string;

  constructor() {
    this.endpoint = config.kokoroX402Url;
  }

  async synthesize(text: string): Promise<TTSResult> {
    const timestamp = Date.now();
    const filename = `kokoro_x402_${timestamp}.wav`;
    const audioPath = path.join(config.ttsCacheDir, filename);

    // Step 1: Initial request — expect 402
    const initialRes = await fetch(`${this.endpoint}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: config.kokoroVoice, return_phonemes: true }),
      signal: AbortSignal.timeout(5000),
    });

    let paymentHeader: string | null = null;

    if (initialRes.status === 402) {
      const paymentReq: X402Response = await initialRes.json();
      const pd = paymentReq.accepts[0];
      // Use Nox's wallet to pay (see §17 for wallet integration)
      const receipt = await signAndPayX402(pd, config.NOX_PRIVATE_KEY!);
      paymentHeader = receipt;
    } else if (!initialRes.ok) {
      throw new Error(`Kokoro x402 initial request failed: ${initialRes.status}`);
    }

    // Step 2: Retry with payment receipt (or proceed if no 402)
    const synthesisRes = await fetch(`${this.endpoint}/synthesize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(paymentHeader ? { 'X-Payment': paymentHeader } : {})
      },
      body: JSON.stringify({ text, voice: config.kokoroVoice, return_phonemes: true }),
      signal: AbortSignal.timeout(30000),
    });

    if (!synthesisRes.ok) {
      throw new Error(`Kokoro x402 synthesis failed: ${synthesisRes.status}`);
    }

    const data = await synthesisRes.json();
    if (!data.audio) throw new Error('No audio in x402 Kokoro response');

    fs.writeFileSync(audioPath, Buffer.from(data.audio, 'base64'));

    const phonemes: Phoneme[] = (data.phonemes || []).map((p: any) => ({
      phoneme: p.phoneme,
      start: p.start,
      end: p.end
    }));

    return {
      audioPath,
      audioUrl: `/audio/${filename}`,
      phonemes,
      duration: phonemes.length > 0 ? phonemes[phonemes.length - 1].end : text.length * 0.06
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// Minimal x402 payment signer using ethers.js
async function signAndPayX402(pd: X402PaymentDetails, privateKey: string): Promise<string> {
  // Import dynamically to keep server lightweight if x402 not configured
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(privateKey);
  const payload = JSON.stringify({ to: pd.payTo, amount: pd.amount, currency: pd.currency, network: pd.network });
  const sig = await wallet.signMessage(payload);
  return Buffer.from(JSON.stringify({ payload, signature: sig })).toString('base64');
}
```

### 14.3 TTS Engine Priority Order

```
1. KokoroX402TTS   — x402 micropayment, best phonemes, no API key
2. KokoroTTS       — local self-hosted Kokoro (if running on VPS with GPU/CPU)
3. ElevenLabsTTS   — cloud fallback, no phoneme data (amplitude lip sync)
4. Silent          — fail gracefully, subtitles only
```

Updated `TTSManager` priority:

```typescript
// server/tts/index.ts (updated priority)
async synthesize(text: string): Promise<TTSResult> {
  const engines = [
    { name: 'kokoro-x402', engine: this.kokoroX402, condition: !!(config.NOX_PRIVATE_KEY && config.kokoroX402Url) },
    { name: 'kokoro-local', engine: this.kokoro, condition: this.kokoroAvailable },
    { name: 'elevenlabs', engine: this.elevenlabs, condition: !!config.elevenlabsKey },
  ];

  for (const { name, engine, condition } of engines) {
    if (!condition) continue;
    try {
      console.log(`[TTS] Trying ${name}`);
      return await engine.synthesize(text);
    } catch (e) {
      console.warn(`[TTS] ${name} failed: ${(e as Error).message}`);
    }
  }

  return { audioPath: '', audioUrl: '', phonemes: [], duration: 0 };
}
```

### 14.4 Voice Selection

**For Kokoro (local or x402):**

| Voice ID | Character | Recommendation |
|---|---|---|
| `af_heart` | Soft, feminine | Default ✅ |
| `af_nova` | Warmer, slightly huskier | Alternative |
| `bf_emma` | British, precise | For "explaining" states |

**Recommended**: `af_heart` at speed `0.95` — slightly slower than default, giving a more deliberate, measured cadence that fits the void-entity persona.

ElevenLabs fallback voice: `Rachel` (Voice ID: `21m00Tcm4TlvDq8ikWAM`) or a custom voice clone at a deeper, cooler register.

---

## 15. Visual Design System

### 15.1 Aesthetic Pillars

The visual grammar of Nox is built on three things:

1. **The Void** — deep black that is never pure #000000. Always `#0a0a0f` or richer with a subtle blue cast. The void has texture: film grain, scanlines.
2. **The Signal** — thin electric lines, glows, terminal text. Purple (`#8866ff`) and cyan (`#00ccff`). Never thick or solid. Always threadlike.
3. **The Presence** — Nox herself is the only warm element. Her avatar glows softly against the void. The contrast makes her feel real.

### 15.2 Background — The Void Layer

The background is a multi-layer composite:

**Layer 1: Base void** — `#0a0a0f` solid fill.

**Layer 2: Noise grain** — a fullscreen quad with a GLSL shader:

```glsl
// Vertex shader
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

// Fragment shader
uniform float uTime;
varying vec2 vUv;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float grain = rand(vUv + fract(uTime * 0.1)) * 0.04;
  // Tint grain slightly purple
  gl_FragColor = vec4(grain * 0.5, grain * 0.3, grain * 0.8, grain);
}
```

Applied as an additive blending quad in front of the scene, at opacity 0.4.

**Layer 3: Radial vignette** — darkens corners. CSS only:

```css
#scene::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 80% 80% at 50% 50%,
    transparent 40%,
    rgba(0, 0, 0, 0.6) 100%
  );
  pointer-events: none;
}
```

**Layer 4: Ambient scanlines** — very subtle, 4px cycle:

```css
#scene::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0px,
    transparent 2px,
    rgba(0, 0, 0, 0.08) 2px,
    rgba(0, 0, 0, 0.08) 4px
  );
  pointer-events: none;
  z-index: 5;
}
```

### 15.3 Neural Particle Trails — Thinking State

When Nox enters `THINKING` state, the background particles transform from ambient drift into directional neural trails flowing toward her head.

**Transition**: over 800ms, particles accelerate toward a focal point at Nox's head, spiraling inward. Looks like she's pulling computation from the void.

```typescript
// client/js/particles.ts

export class ParticleSystem {
  private mode: 'ambient' | 'thinking' | 'money' = 'ambient';
  private modeTransitionMs: number = 800;
  private modeEnteredAt: number = 0;
  private count = 300;
  private positions: Float32Array;
  private velocities: Float32Array;
  private colors: Float32Array;
  private geometry: THREE.BufferGeometry;
  private points: THREE.Points;

  // Focal point — Nox's head position in world space
  private focalPoint = new THREE.Vector3(0, 1.6, 0.3);

  constructor(scene: THREE.Scene) {
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);

    this.geometry = new THREE.BufferGeometry();
    this.initParticles();

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      vertexColors: true,
      size: 0.005,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, material);
    scene.add(this.points);
  }

  setMode(mode: 'ambient' | 'thinking' | 'money') {
    this.mode = mode;
    this.modeEnteredAt = Date.now();
  }

  update(dt: number) {
    const time = Date.now() * 0.001;
    const transitionT = Math.min(1, (Date.now() - this.modeEnteredAt) / this.modeTransitionMs);

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      const px = this.positions[ix], py = this.positions[ix + 1], pz = this.positions[ix + 2];

      if (this.mode === 'ambient') {
        // Slow upward drift + horizontal sway
        this.positions[ix + 1] += 0.015 * dt;
        this.positions[ix] += Math.sin(time + i * 0.7) * 0.0005;
        this.positions[ix + 2] += Math.cos(time + i) * 0.0005;
        if (this.positions[ix + 1] > 4) this.resetParticleAmbient(i);

        // Colors: deep purple
        this.colors[ix] = 0.13;
        this.colors[ix + 1] = 0.05;
        this.colors[ix + 2] = 0.53;

      } else if (this.mode === 'thinking') {
        const dx = this.focalPoint.x - px;
        const dy = this.focalPoint.y - py;
        const dz = this.focalPoint.z - pz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < 0.08) {
          this.resetParticleThinking(i);
        } else {
          // Accelerate toward focal point, spiral
          const baseSpeed = 0.4 * transitionT;
          const speed = baseSpeed + (1 / (dist + 0.1)) * 0.15;
          const spiralX = Math.sin(time * 2 + i) * 0.015 * transitionT;
          const spiralZ = Math.cos(time * 2 + i * 0.7) * 0.015 * transitionT;

          this.positions[ix] += (dx / dist) * speed * dt + spiralX;
          this.positions[ix + 1] += (dy / dist) * speed * dt;
          this.positions[ix + 2] += (dz / dist) * speed * dt + spiralZ;

          // Color gradient: purple far → cyan near
          const t = Math.max(0, 1 - dist / 3);
          this.colors[ix] = 0.13 + t * 0.3;
          this.colors[ix + 1] = 0.05 + t * 0.75;
          this.colors[ix + 2] = 0.53 + t * 0.47;
        }

      } else if (this.mode === 'money') {
        // Burst outward from center in golden color
        const angle = (i / this.count) * Math.PI * 2;
        this.positions[ix] += Math.cos(angle) * 0.5 * dt;
        this.positions[ix + 1] += Math.sin(angle) * 0.5 * dt + 0.1 * dt;
        this.colors[ix] = 1.0;
        this.colors[ix + 1] = 0.67;
        this.colors[ix + 2] = 0.0;
        if (Math.sqrt(px * px + py * py) > 3) this.resetParticleMoney(i);
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  private resetParticleAmbient(i: number) {
    const ix = i * 3;
    this.positions[ix] = (Math.random() - 0.5) * 6;
    this.positions[ix + 1] = -1;
    this.positions[ix + 2] = (Math.random() - 0.5) * 4;
  }

  private resetParticleThinking(i: number) {
    // Respawn at a random outer position
    const ix = i * 3;
    const theta = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * 2;
    this.positions[ix] = Math.cos(theta) * r;
    this.positions[ix + 1] = this.focalPoint.y + (Math.random() - 0.5) * 3;
    this.positions[ix + 2] = Math.sin(theta) * r;
  }

  private resetParticleMoney(i: number) {
    const ix = i * 3;
    this.positions[ix] = (Math.random() - 0.5) * 0.1;
    this.positions[ix + 1] = 1.3;
    this.positions[ix + 2] = 0;
  }

  private initParticles() {
    for (let i = 0; i < this.count; i++) {
      this.resetParticleAmbient(i);
      const ix = i * 3;
      this.positions[ix + 1] = Math.random() * 5; // Spread initial Y
      this.colors[ix] = 0.13;
      this.colors[ix + 1] = 0.05;
      this.colors[ix + 2] = 0.53;
    }
  }
}
```

### 15.4 Floating Terminal Fragments

During `EXECUTING` state, ghostly terminal code fragments float in the space behind and around Nox — not readable, just atmospheric signal noise.

```typescript
// client/js/fragments.ts

const FRAGMENT_CODE_POOL = [
  'const x = await fetch(url)',
  'if (res.status === 402) {',
  'npm test --watch --coverage',
  'git diff --stat HEAD~1',
  'SELECT * FROM events WHERE ts >',
  'process.env.NOX_SECRET',
  'ws.send(JSON.stringify({',
  'vrm.update(dt)',
  '0xdeadbeef4f2a',
  'phonemes.map(p => viseme[p])',
  'setInterval(() => emit("idle")',
  '> executing tool: exec',
  '{ type: "thinking", ts:',
  'kokoro.synthesize(text)',
  '✓ all tests passed (42ms)',
];

export class FloatingFragments {
  private fragments: FragmentTile[] = [];
  private scene: THREE.Scene;
  private active: boolean = false;
  private spawnTimer: number = 0;
  private spawnInterval: number = 0.8; // seconds between spawns

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  show() {
    this.active = true;
    // Spawn initial burst
    for (let i = 0; i < 3; i++) setTimeout(() => this.spawnFragment(), i * 300);
  }

  hide() {
    this.active = false;
    this.fragments.forEach(f => f.fadeOut());
  }

  update(dt: number) {
    this.fragments = this.fragments.filter(f => !f.isDead());
    this.fragments.forEach(f => f.update(dt));

    if (this.active) {
      this.spawnTimer += dt;
      if (this.spawnTimer >= this.spawnInterval) {
        this.spawnTimer = 0;
        this.spawnFragment();
      }
    }
  }

  private spawnFragment() {
    if (this.fragments.length > 12) return; // Max cap
    const code = FRAGMENT_CODE_POOL[Math.floor(Math.random() * FRAGMENT_CODE_POOL.length)];
    const tile = new FragmentTile(this.scene, code);
    // Float in space to avatar's right and behind
    tile.mesh.position.set(
      0.4 + Math.random() * 1.0,
      0.6 + Math.random() * 1.4,
      -0.8 + Math.random() * 0.4
    );
    this.fragments.push(tile);
  }
}

class FragmentTile {
  mesh: THREE.Mesh;
  private life: number = 0;
  private maxLife: number = 4 + Math.random() * 4;
  private driftY: number = 0.018 + Math.random() * 0.025;
  private dead: boolean = false;
  private opacity: number = 0.3 + Math.random() * 0.35;

  constructor(scene: THREE.Scene, text: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 26;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '11px "JetBrains Mono", monospace';
    const alpha = 0.3 + Math.random() * 0.4;
    ctx.fillStyle = `rgba(0, 204, 255, ${alpha})`;
    ctx.fillText(text, 4, 18);

    const texture = new THREE.CanvasTexture(canvas);
    const geometry = new THREE.PlaneGeometry(0.33, 0.039);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    scene.add(this.mesh);
  }

  update(dt: number) {
    this.life += dt;
    const t = this.life / this.maxLife;

    // Fade envelope: quick in, hold, slow out
    const opacity = t < 0.12 ? (t / 0.12) * this.opacity
      : t > 0.75 ? (1 - (t - 0.75) / 0.25) * this.opacity
      : this.opacity;

    (this.mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
    this.mesh.position.y += this.driftY * dt;
    // Subtle horizontal drift
    this.mesh.position.x += Math.sin(this.life * 0.7) * 0.001;

    if (this.life >= this.maxLife) this.die();
  }

  fadeOut() { this.maxLife = Math.min(this.maxLife, this.life + 0.4); }
  isDead() { return this.dead; }

  private die() {
    this.dead = true;
    this.mesh.parent?.remove(this.mesh);
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
  }
}
```

### 15.5 Wallet Health Bar

The wallet health bar lives in the bottom-left of the stream overlay. Thin, monospace, barely-there — until money moves.

```html
<!-- In client/index.html and client/obs.html overlay -->
<div id="wallet-bar">
  <span class="wallet-label">⬡ NOX</span>
  <div class="wallet-track">
    <div id="wallet-fill" class="wallet-fill"></div>
  </div>
  <span id="wallet-amount" class="wallet-amount">0.0000 ETH</span>
</div>
```

```css
/* Add to style.css */
#wallet-bar {
  position: fixed;
  bottom: 24px;
  left: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-cyan);
  z-index: 20;
  opacity: 0.5;
  transition: opacity 0.3s;
}

#wallet-bar:hover,
#wallet-bar.active {
  opacity: 1;
}

.wallet-label {
  letter-spacing: 0.1em;
  color: var(--text-muted);
  font-size: 10px;
}

.wallet-track {
  width: 100px;
  height: 3px;
  background: rgba(0, 204, 255, 0.12);
  border: 1px solid rgba(0, 204, 255, 0.25);
  border-radius: 2px;
  overflow: hidden;
}

.wallet-fill {
  height: 100%;
  background: linear-gradient(90deg, #005599, #00ccff);
  border-radius: 2px;
  width: 0%;
  transition: width 0.9s cubic-bezier(0.23, 1, 0.32, 1);
  box-shadow: 0 0 6px rgba(0, 204, 255, 0.4);
}

.wallet-amount {
  font-size: 10px;
  color: var(--text-secondary);
  min-width: 80px;
}

#wallet-bar.pulse .wallet-fill {
  animation: wallet-pulse 0.8s ease-out;
}

@keyframes wallet-pulse {
  0%   { box-shadow: 0 0 6px rgba(0, 204, 255, 0.4); }
  40%  { box-shadow: 0 0 20px rgba(0, 204, 255, 1), 0 0 40px rgba(0, 204, 255, 0.5); }
  100% { box-shadow: 0 0 6px rgba(0, 204, 255, 0.4); }
}
```

```typescript
// client/js/walletBar.ts

export class WalletBar {
  private fill: HTMLElement;
  private amount: HTMLElement;
  private bar: HTMLElement;
  private maxBalance: number = 5; // ETH reference for 100% fill
  private displayBalance: number = 0;

  constructor() {
    this.fill = document.getElementById('wallet-fill')!;
    this.amount = document.getElementById('wallet-amount')!;
    this.bar = document.getElementById('wallet-bar')!;
  }

  update(payload: { balanceAfter: string; currency: string; direction: string }) {
    const target = parseFloat(payload.balanceAfter);
    const from = this.displayBalance;

    // Set fill width
    const pct = Math.min(100, (target / this.maxBalance) * 100);
    this.fill.style.width = `${pct}%`;

    // Pulse animation
    this.bar.classList.add('active');
    this.bar.classList.remove('pulse');
    void this.bar.offsetWidth; // force reflow
    this.bar.classList.add('pulse');
    setTimeout(() => {
      this.bar.classList.remove('pulse');
      this.bar.classList.remove('active');
    }, 4000);

    // Animated number counter
    const startTime = performance.now();
    const duration = 900;
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.displayBalance = from + (target - from) * eased;
      this.amount.textContent = `${this.displayBalance.toFixed(4)} ${payload.currency}`;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
```

---

## 16. Avatar Animation — Full Implementation

### 16.1 Animator State Machine

```typescript
// client/js/vrm/animator.ts

import * as THREE from 'three';
import { VRM } from '@pixiv/three-vrm';

type StateName = 'idle' | 'thinking' | 'typing' | 'speaking' | 'executing' | 'money';

interface BoneTarget {
  bone: string;
  position?: THREE.Vector3;
  rotation: THREE.Euler;
}

export class AvatarStateMachine {
  private vrm: VRM;
  private current: StateName = 'idle';
  private time: number = 0;

  // Shared continuous animation state
  private breathPhase: number = Math.random() * Math.PI * 2;
  private blinkTimer: number = 2 + Math.random() * 3;
  private isBlinking: boolean = false;
  private blinkProgress: number = 0;
  private headSwayPhase: number = Math.random() * Math.PI * 2;

  // State-specific timers
  private thinkingTiltTarget: number = 0;
  private typingFingerPhase: number = 0;
  private executingGlanceTimer: number = 0;

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  transition(state: StateName, payload?: any) {
    const prev = this.current;
    this.current = state;

    // State entry logic
    switch (state) {
      case 'thinking':
        this.thinkingTiltTarget = 0.08 + Math.random() * 0.06; // Random slight head tilt
        break;
      case 'typing':
        this.typingFingerPhase = 0;
        break;
      case 'executing':
        this.executingGlanceTimer = 0;
        break;
    }
  }

  update(dt: number) {
    this.time += dt;
    this.updateContinuous(dt);
    this.updateStateSpecific(dt);
    this.applyToVRM();
  }

  // Continuous animations that run regardless of state
  private updateContinuous(dt: number) {
    // Breathing — chest expansion
    this.breathPhase += dt * (this.current === 'thinking' ? 0.6 : 1.0); // Slower when thinking

    // Blink timer
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && !this.isBlinking) {
      this.isBlinking = true;
      this.blinkProgress = 0;
      this.blinkTimer = 2 + Math.random() * 4;
    }

    if (this.isBlinking) {
      this.blinkProgress += dt * 8; // ~125ms blink
      if (this.blinkProgress >= 1) {
        this.isBlinking = false;
        this.blinkProgress = 0;
      }
    }

    // Gentle head sway (idle micro-movement)
    this.headSwayPhase += dt * 0.3;
  }

  private updateStateSpecific(dt: number) {
    switch (this.current) {
      case 'thinking':
        // Finger hover tremor
        this.typingFingerPhase += dt * 2;
        // Eyes occasionally narrow
        break;
      case 'typing':
        // Finger animation — faster than thinking
        this.typingFingerPhase += dt * 12;
        break;
      case 'executing':
        // Eyes scan right toward terminal
        this.executingGlanceTimer += dt;
        break;
    }
  }

  private applyToVRM() {
    if (!this.vrm.humanoid || !this.vrm.expressionManager) return;

    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    const spine = this.vrm.humanoid.getNormalizedBoneNode('spine');
    const chest = this.vrm.humanoid.getNormalizedBoneNode('chest');
    const neck = this.vrm.humanoid.getNormalizedBoneNode('neck');
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const leftArm = this.vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightArm = this.vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    const leftForearm = this.vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
    const rightForearm = this.vrm.humanoid.getNormalizedBoneNode('rightLowerArm');

    // === BREATHING ===
    const breathAmt = Math.sin(this.breathPhase * Math.PI * 2 * 0.5) * 0.012;
    if (chest) {
      chest.rotation.x = breathAmt;
    }

    // === BLINK ===
    if (this.vrm.expressionManager) {
      const blinkVal = this.isBlinking
        ? Math.sin(this.blinkProgress * Math.PI)
        : 0;
      this.vrm.expressionManager.setValue('blink', blinkVal);
    }

    // === HEAD MICRO-SWAY ===
    const swayX = Math.sin(this.headSwayPhase) * 0.012;
    const swayY = Math.sin(this.headSwayPhase * 0.7) * 0.008;

    // === STATE-SPECIFIC BONE POSES ===
    switch (this.current) {
      case 'idle':
        if (head) {
          head.rotation.x = swayX;
          head.rotation.y = swayY;
        }
        if (leftArm) leftArm.rotation.z = 0.3;
        if (rightArm) rightArm.rotation.z = -0.3;
        this.vrm.expressionManager?.setValue('eyeSquint', 0);
        this.vrm.expressionManager?.setValue('eyeWide', 0);
        this.vrm.expressionManager?.setValue('mouthSmile', 0);
        break;

      case 'thinking':
        if (head) {
          // Lean slightly right, forward
          head.rotation.z = THREE.MathUtils.lerp(
            head.rotation.z,
            this.thinkingTiltTarget,
            0.05
          );
          head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0.05, 0.05);
          head.rotation.y = swayY * 0.5;
        }
        if (spine) {
          spine.rotation.x = THREE.MathUtils.lerp(spine.rotation.x, 0.06, 0.03); // Lean forward
        }
        // Hands hover near keyboard (slight raise)
        if (leftArm) leftArm.rotation.z = 0.15;
        if (rightArm) rightArm.rotation.z = -0.15;
        if (leftForearm) leftForearm.rotation.x = -0.3;
        if (rightForearm) rightForearm.rotation.x = -0.3;
        // Finger tremor on both hands
        const fingerTremor = Math.sin(this.typingFingerPhase) * 0.02;
        if (leftForearm) leftForearm.rotation.z = fingerTremor;
        if (rightForearm) rightForearm.rotation.z = -fingerTremor;
        this.vrm.expressionManager?.setValue('eyeSquint', 0.2);
        break;

      case 'typing':
        if (head) {
          head.rotation.x = 0.04; // Slight downward look
          head.rotation.y = swayY * 0.3;
          head.rotation.z = 0;
        }
        // Finger typing motion — alternating hands
        const leftTypeZ = Math.sin(this.typingFingerPhase) * 0.025;
        const rightTypeZ = Math.sin(this.typingFingerPhase + Math.PI) * 0.025;
        if (leftForearm) leftForearm.rotation.x = -0.35 + leftTypeZ;
        if (rightForearm) rightForearm.rotation.x = -0.35 + rightTypeZ;
        this.vrm.expressionManager?.setValue('mouthSmile', 0.08); // Subtle focus smile
        break;

      case 'speaking':
        if (head) {
          head.rotation.x = swayX * 0.5;
          head.rotation.y = swayY;
          head.rotation.z = 0;
        }
        // Arms relax
        if (leftArm) leftArm.rotation.z = 0.25;
        if (rightArm) rightArm.rotation.z = -0.25;
        // Expressiveness: slight head nod with speech rhythm
        // (actual viseme is handled by lipSync.ts)
        break;

      case 'executing':
        if (head) {
          // Eyes glance right toward terminal
          const glanceY = Math.min(0.25, this.executingGlanceTimer * 0.5);
          head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, glanceY, 0.04);
          head.rotation.x = 0.02;
        }
        this.vrm.expressionManager?.setValue('eyeSquint', 0.15);
        break;

      case 'money':
        if (head) {
          // Brief downward look (toward wallet area) then back up
          const moneyLook = Math.sin(this.time * 2) * 0.1;
          head.rotation.x = moneyLook;
        }
        this.vrm.expressionManager?.setValue('eyeWide', 0.3);
        this.vrm.expressionManager?.setValue('mouthSmile', 0.2);
        break;
    }
  }
}
```

### 16.2 Keypress Sounds (Typing State)

Mechanical keyboard sounds sync with token rate. A pool of 5 slightly-varied keypress sounds to avoid repetition:

```typescript
// client/js/keypressSounds.ts

export class KeypressSounds {
  private buffers: AudioBuffer[] = [];
  private ctx: AudioContext;
  private lastPress: number = 0;
  private minInterval: number = 40; // ms between presses (max ~25 wpm equivalent)

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.loadSounds();
  }

  private async loadSounds() {
    const urls = [
      '/assets/sounds/key1.ogg',
      '/assets/sounds/key2.ogg',
      '/assets/sounds/key3.ogg',
      '/assets/sounds/key4.ogg',
      '/assets/sounds/key5.ogg',
    ];
    this.buffers = await Promise.all(
      urls.map(url => fetch(url).then(r => r.arrayBuffer()).then(buf => this.ctx.decodeAudioData(buf)))
    );
  }

  // Called per token during TYPING state
  triggerForToken(token: string) {
    const now = Date.now();
    const charsInToken = token.length;

    // Schedule one press per character with jitter
    for (let i = 0; i < charsInToken; i++) {
      const delay = i * (50 + Math.random() * 40);
      if (now + delay - this.lastPress >= this.minInterval) {
        setTimeout(() => this.pressKey(), delay);
        this.lastPress = now + delay;
      }
    }
  }

  private pressKey() {
    if (!this.buffers.length) return;
    const buf = this.buffers[Math.floor(Math.random() * this.buffers.length)];
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    gain.gain.value = 0.08 + Math.random() * 0.04; // Very quiet
    source.buffer = buf;
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
  }
}
```

Keypress sound files: generate 5 variations of mechanical key clicks using ffmpeg from a single source:
```bash
# Generate 5 varied keypress sounds from a base click
for i in 1 2 3 4 5; do
  pitch=$((90 + RANDOM % 20)) # 90-110 semitones
  ffmpeg -f lavfi -i "sine=frequency=${pitch}:duration=0.04" \
    -af "aecho=0.1:0.1:20:0.3,volume=0.5" \
    /path/to/assets/sounds/key${i}.ogg
done
```

Or source free mechanical keyboard samples from freesound.org (license: CC0).

---

## 17. WebSocket Client — Full Implementation

```typescript
// client/js/wsClient.ts

type EventHandler = (payload: any) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();
  private reconnectDelay: number = 2000;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000;
  private username: string = `viewer_${Math.random().toString(36).slice(2, 7)}`;

  constructor() {
    this.connect();
  }

  private connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/stream`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.reconnectDelay = 2000;
      // Send auth handshake
      this.send({ type: 'auth', payload: { role: 'viewer' } });
    };

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        this.dispatch(event.type, event.payload);
      } catch (err) {
        console.warn('[WS] Failed to parse message:', e.data);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected. Reconnecting in', this.reconnectDelay, 'ms');
      setTimeout(() => this.connect(), this.reconnectDelay);
      // Exponential backoff, capped at 30s
      this.reconnectDelay = Math.min(this.maxReconnectDelay, this.reconnectDelay * 1.5);
      this.reconnectAttempts++;
    };

    this.ws.onerror = (e) => {
      console.error('[WS] Error:', e);
    };
  }

  on(eventType: string, handler: EventHandler) {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, []);
    this.handlers.get(eventType)!.push(handler);
  }

  off(eventType: string, handler: EventHandler) {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  sendChat(text: string) {
    this.send({
      type: 'chat_message',
      payload: { username: this.username, text }
    });
  }

  private send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private dispatch(type: string, payload: any) {
    const handlers = this.handlers.get(type) || [];
    handlers.forEach(h => h(payload));
  }
}
```

---

## 18. Audio Player

```typescript
// client/js/audioPlayer.ts

export class AudioPlayer {
  private audioElement: HTMLAudioElement;
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private source: MediaElementAudioSourceNode | null = null;
  private endedCallbacks: (() => void)[] = [];

  constructor(audioElement: HTMLAudioElement) {
    this.audioElement = audioElement;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.ctx.destination);
    this.audioElement.addEventListener('ended', () => {
      this.endedCallbacks.forEach(cb => cb());
    });
  }

  async play(audioUrl: string): Promise<void> {
    // Resume context if suspended (browser autoplay policy)
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.audioElement.src = audioUrl;

    if (!this.source) {
      this.source = this.ctx.createMediaElementSource(this.audioElement);
      this.source.connect(this.analyser);
    }

    return this.audioElement.play();
  }

  stop() {
    this.audioElement.pause();
    this.audioElement.currentTime = 0;
  }

  getCurrentTime(): number {
    return this.audioElement.currentTime;
  }

  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  // Get RMS volume for amplitude lip sync fallback
  getVolume(): number {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    const sum = data.reduce((a, b) => a + b, 0);
    return sum / (data.length * 255);
  }

  onEnded(cb: () => void) {
    this.endedCallbacks.push(cb);
  }
}
```

---

## 19. Subtitle Renderer

```typescript
// client/js/subtitles.ts

export class SubtitleRenderer {
  private el: HTMLElement;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private currentText: string = '';

  constructor() {
    this.el = document.getElementById('subtitles')!;
  }

  show(text: string) {
    if (this.fadeTimer) clearTimeout(this.fadeTimer);

    // Append for streaming (typing state), replace for speaking
    this.currentText = text;
    this.el.classList.add('visible');

    // Typewriter effect: build DOM with individual char spans
    this.el.innerHTML = '';
    const chars = [...text]; // Handle unicode
    chars.forEach((char, i) => {
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = char === ' ' ? '\u00A0' : char;
      span.style.animationDelay = `${i * 28}ms`;
      this.el.appendChild(span);
    });
  }

  hide(delay: number = 0) {
    this.fadeTimer = setTimeout(() => {
      this.el.classList.remove('visible');
      setTimeout(() => { this.el.innerHTML = ''; }, 200);
    }, delay);
  }

  update(_dt: number) {
    // reserved for future scroll/overflow logic
  }
}
```

---

## 20. Terminal Overlay

```typescript
// client/js/terminal.ts

export class Terminal {
  private el: HTMLElement;
  private content: HTMLElement;
  private visible: boolean = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = document.getElementById('terminal')!;
    this.content = this.el.querySelector('.terminal-content')!;
    this.el.classList.add('hidden');
  }

  show() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.visible = true;
    this.el.classList.remove('hidden');
  }

  hide(delay: number = 2000) {
    this.hideTimer = setTimeout(() => {
      this.el.classList.add('hidden');
      this.visible = false;
      // Clear content after hide
      setTimeout(() => { this.content.innerHTML = ''; }, 300);
    }, delay);
  }

  addCommand(command: string) {
    const line = document.createElement('div');
    line.className = 'terminal-line command';
    line.textContent = `$ ${command}`;
    this.content.appendChild(line);
    // Cursor line
    const cursor = document.createElement('span');
    cursor.className = 'terminal-cursor';
    cursor.textContent = '█';
    line.appendChild(cursor);
    this.scrollToBottom();
  }

  addOutput(output: string, exitCode: number | null) {
    // Remove cursor from last line
    const cursors = this.content.querySelectorAll('.terminal-cursor');
    cursors.forEach(c => c.remove());

    const lines = output.split('\n').filter(l => l);
    lines.forEach(line => {
      const el = document.createElement('div');
      el.className = 'terminal-line output';
      // Detect error lines
      if (line.startsWith('Error') || line.startsWith('error') || line.includes('FAIL')) {
        el.classList.add('error');
      }
      el.textContent = line;
      this.content.appendChild(el);
    });

    if (exitCode !== null) {
      const exitEl = document.createElement('div');
      exitEl.className = `terminal-line ${exitCode === 0 ? 'output' : 'error'}`;
      exitEl.textContent = `[exit ${exitCode}]`;
      this.content.appendChild(exitEl);
    }

    this.scrollToBottom();
  }

  private scrollToBottom() {
    this.content.scrollTop = this.content.scrollHeight;
  }

  update(_dt: number) {
    // reserved
  }
}
```

---

## 21. Lip Sync — Complete Implementation

```typescript
// client/js/lipSync.ts

import { VRM } from '@pixiv/three-vrm';
import { AudioPlayer } from './audioPlayer';

interface Phoneme {
  phoneme: string;
  start: number;
  end: number;
}

// ARPAbet phoneme → VRM viseme mapping
const PHONEME_TO_VISEME: Record<string, string> = {
  // Vowels
  'AA': 'aa', 'AE': 'aa', 'AH': 'aa',
  'EH': 'E', 'EY': 'E', 'ER': 'E',
  'IH': 'I', 'IY': 'I',
  'OH': 'O', 'OW': 'O', 'OY': 'O',
  'UH': 'U', 'UW': 'U', 'AW': 'U', 'AY': 'aa',
  // Bilabials
  'PP': 'PP', 'BB': 'PP', 'MM': 'PP',
  // Labiodental
  'FF': 'FF', 'VV': 'FF',
  // Dental
  'TH': 'TH', 'DH': 'TH',
  // Alveolar
  'DD': 'DD', 'TT': 'DD', 'NN': 'DD', 'LL': 'DD',
  // Postalveolar
  'CH': 'CH', 'JH': 'CH', 'SH': 'CH', 'ZH': 'CH',
  'SS': 'SS', 'ZZ': 'SS',
  // Rhotic
  'RR': 'RR',
  // Velar
  'KK': 'kk', 'GG': 'kk', 'NG': 'kk',
  // Silence
  'SIL': 'neutral', 'SP': 'neutral',
};

const ALL_VISEMES = ['aa', 'E', 'I', 'O', 'U', 'PP', 'FF', 'TH', 'DD', 'CH', 'SS', 'RR', 'kk'];

export class LipSync {
  private vrm: VRM;
  private phonemes: Phoneme[] = [];
  private audioPlayer: AudioPlayer | null = null;
  private audioStartTime: number = 0;
  private active: boolean = false;
  private mode: 'phoneme' | 'amplitude' = 'phoneme';

  // Transition state
  private currentViseme: string = 'neutral';
  private targetViseme: string = 'neutral';
  private blendProgress: number = 1;
  private readonly BLEND_DURATION: number = 0.045; // 45ms crossfade

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  start(phonemes: Phoneme[], player: AudioPlayer) {
    this.phonemes = phonemes;
    this.audioPlayer = player;
    this.audioStartTime = 0; // Will be set on first update when audio is playing
    this.active = true;
    this.mode = 'phoneme';
  }

  startAmplitude(player: AudioPlayer) {
    this.audioPlayer = player;
    this.active = true;
    this.mode = 'amplitude';
  }

  stop() {
    this.active = false;
    this.clearAllVisemes();
  }

  isActive(): boolean {
    return this.active;
  }

  update(audioCurrentTime: number) {
    if (!this.active || !this.vrm.expressionManager) return;

    if (this.mode === 'phoneme') {
      this.updatePhoneme(audioCurrentTime);
    } else {
      this.updateAmplitude();
    }
  }

  private updatePhoneme(audioCurrentTime: number) {
    const dt = 1 / 60; // approx frame dt

    // Find the active phoneme at current audio time
    const active = this.phonemes.find(p =>
      audioCurrentTime >= p.start && audioCurrentTime < p.end
    );

    const newViseme = active ? (PHONEME_TO_VISEME[active.phoneme] ?? 'neutral') : 'neutral';

    if (newViseme !== this.targetViseme) {
      this.currentViseme = this.targetViseme;
      this.targetViseme = newViseme;
      this.blendProgress = 0;
    }

    this.blendProgress = Math.min(1, this.blendProgress + dt / this.BLEND_DURATION);

    // Zero all visemes first
    this.clearAllVisemes();

    // Apply blend
    if (this.currentViseme !== 'neutral') {
      this.vrm.expressionManager.setValue(this.currentViseme, 1 - this.blendProgress);
    }
    if (this.targetViseme !== 'neutral') {
      this.vrm.expressionManager.setValue(this.targetViseme, this.blendProgress);
    }
  }

  private updateAmplitude() {
    if (!this.audioPlayer) return;
    const volume = this.audioPlayer.getVolume();
    // Simple amplitude → mouth open mapping
    this.clearAllVisemes();
    this.vrm.expressionManager?.setValue('aa', volume * 0.9);
    this.vrm.expressionManager?.setValue('O', volume * 0.3);
  }

  private clearAllVisemes() {
    ALL_VISEMES.forEach(v => this.vrm.expressionManager?.setValue(v, 0));
  }
}
```

---

## 22. Config — Updated Environment Variables

```typescript
// server/config.ts (complete)

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3200'),
  wsPort: parseInt(process.env.WS_PORT || '3200'), // Same port, different path
  noxSecret: process.env.NOX_SECRET || 'dev-secret',

  // TTS
  ttsEngine: process.env.TTS_ENGINE || 'auto',
  kokoroUrl: process.env.KOKORO_URL || 'http://localhost:3202',
  kokoroX402Url: process.env.KOKORO_X402_URL || '',
  kokoroVoice: process.env.KOKORO_VOICE || 'af_heart',
  kokoroSpeed: parseFloat(process.env.KOKORO_SPEED || '0.95'),
  elevenlabsKey: process.env.ELEVENLABS_KEY || '',
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',

  // Audio cache
  ttsCacheDir: process.env.TTS_CACHE_DIR || '/tmp/nox-tts',
  ttsCacheTtl: parseInt(process.env.TTS_CACHE_TTL || '3600'),

  // Stream
  streamTitle: process.env.STREAM_TITLE || 'Nox — AI Agent Live',

  // Chat
  chatRateLimit: parseInt(process.env.CHAT_RATE_LIMIT || '3'),
  chatMaxLength: parseInt(process.env.CHAT_MAX_LENGTH || '280'),

  // Wallet (for x402 TTS payments)
  NOX_PRIVATE_KEY: process.env.NOX_PRIVATE_KEY || '',
};
```

Full `.env.example`:

```env
# Server
PORT=3200
NOX_SECRET=change-this-to-a-random-secret

# TTS — priority: kokoro-x402 > kokoro-local > elevenlabs
TTS_ENGINE=auto
KOKORO_URL=http://localhost:3202
KOKORO_X402_URL=https://kokoro.x402.org
KOKORO_VOICE=af_heart
KOKORO_SPEED=0.95
ELEVENLABS_KEY=sk-...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM

# Audio
TTS_CACHE_DIR=/tmp/nox-tts
TTS_CACHE_TTL=3600

# Wallet (used for x402 micropayments — Nox's own wallet)
NOX_PRIVATE_KEY=0x...

# Stream
STREAM_TITLE=Nox — AI Agent Live

# Chat
CHAT_RATE_LIMIT=3
CHAT_MAX_LENGTH=280
```

---

## 23. Complete File Structure (Updated)

```
nox-stream/
├── SPEC.md
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
│
├── server/
│   ├── index.ts                  # Express + WS server entry
│   ├── config.ts                 # All env config
│   ├── eventRouter.ts            # Routes events, enriches speaking with TTS
│   ├── openclawBridge.ts         # Receives events from OpenClaw runtime
│   ├── chatManager.ts            # Chat rate limiting, broadcast, forward
│   └── tts/
│       ├── engine.ts             # TTSEngine interface + Phoneme type
│       ├── index.ts              # TTSManager (priority fallback logic)
│       ├── kokoro.ts             # Local Kokoro HTTP adapter
│       ├── kokoroX402.ts         # Kokoro via x402 micropayment (new)
│       └── elevenlabs.ts         # ElevenLabs API adapter
│
├── client/
│   ├── index.html                # Main viewer page (avatar + chat)
│   ├── obs.html                  # OBS browser source (no chat, clean)
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── main.ts               # App bootstrap, render loop
│       ├── scene.ts              # Three.js scene, camera, lighting
│       ├── particles.ts          # Particle system (ambient/thinking/money modes)
│       ├── fragments.ts          # Floating terminal fragments (executing state)
│       ├── walletBar.ts          # Wallet health bar component
│       ├── wsClient.ts           # WebSocket client with reconnect
│       ├── audioPlayer.ts        # Web Audio API player + analyser
│       ├── lipSync.ts            # Phoneme + amplitude lip sync
│       ├── subtitles.ts          # Typewriter subtitle renderer
│       ├── terminal.ts           # Terminal overlay (executing state)
│       ├── keypressSounds.ts     # Mechanical key sounds (typing state)
│       └── vrm/
│           ├── loader.ts         # VRM loader + fallback sphere
│           ├── animator.ts       # Avatar state machine (all 6 states)
│           ├── blendShapes.ts    # Expression helpers + constants
│           └── holoFragment.ts   # Floating shoulder terminal tile
│
├── scripts/
│   ├── kokoro_serve.py           # Local Kokoro HTTP wrapper
│   ├── dev.sh                    # Start dev environment
│   └── deploy.sh                 # Deploy to VPS
│
└── client/assets/
    ├── models/
    │   └── nox.vrm               # The avatar (create via VRoid Studio)
    ├── sounds/
    │   ├── key1.ogg              # Mechanical keypress sounds (pool of 5)
    │   ├── key2.ogg
    │   ├── key3.ogg
    │   ├── key4.ogg
    │   ├── key5.ogg
    │   └── notification.ogg
    └── fonts/
        └── JetBrainsMono.woff2   # Monospace font for terminal/subtitles
```

---

## 24. OBS html Page (obs.html) — Production Layout

The OBS page differs from the viewer page:
- No chat sidebar (full 1920x1080 canvas)
- Wallet bar, state indicator, subtitles included
- No chat input form
- Slightly heavier visual effects (this is the broadcast master)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Nox — OBS</title>
  <link rel="stylesheet" href="/css/style.css">
  <style>
    #app { display: block; width: 1920px; height: 1080px; overflow: hidden; }
    #scene { width: 1920px; height: 1080px; }
    /* No chat sidebar */
    #chat-sidebar { display: none; }
  </style>
</head>
<body>
  <div id="app">
    <canvas id="scene"></canvas>
    <audio id="tts-audio" crossorigin="anonymous"></audio>

    <div id="overlay">
      <!-- State indicator top-left -->
      <div id="state-indicator">
        <div class="dot idle" id="state-dot"></div>
        <span id="state-label">idle</span>
      </div>

      <!-- Subtitles bottom center -->
      <div id="subtitles"></div>

      <!-- Terminal (shows during executing) -->
      <div id="terminal" class="hidden">
        <div class="terminal-header">
          <span class="terminal-title">nox@void:~$</span>
        </div>
        <div class="terminal-content"></div>
      </div>

      <!-- Money notification -->
      <div id="money-notification" class="hidden">
        <div class="money-icon">⬡</div>
        <div class="money-text" id="money-text">+0.05 ETH</div>
      </div>
    </div>

    <!-- Wallet bar bottom-left -->
    <div id="wallet-bar">
      <span class="wallet-label">⬡ NOX</span>
      <div class="wallet-track">
        <div id="wallet-fill" class="wallet-fill"></div>
      </div>
      <span id="wallet-amount" class="wallet-amount">0.0000 ETH</span>
    </div>
  </div>

  <script type="module" src="/js/main.js"></script>
</body>
</html>
```

---

## 25. OpenClaw Bridge — Skill Implementation

The `nox-bridge` skill hooks into the OpenClaw runtime and emits events to nox-server. This is what connects the actual agent behavior to the visual layer.

```typescript
// ~/.openclaw/skills/nox-bridge/bridge.ts
// Loaded as a skill by OpenClaw on startup

import WebSocket from 'ws';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const NOX_WS_URL = process.env.NOX_WS_URL || 'ws://localhost:3200/ws/openclaw';
const NOX_SECRET = process.env.NOX_SECRET || '';

function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  ws = new WebSocket(NOX_WS_URL, {
    headers: { 'Authorization': `Bearer ${NOX_SECRET}` }
  });

  ws.on('open', () => {
    console.log('[nox-bridge] Connected to nox-server');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Incoming: chat messages from stream viewers
      if (msg.type === 'chat_message') {
        // Inject into OpenClaw's message queue
        // (implementation depends on OpenClaw API)
        injectStreamChat(msg.payload.username, msg.payload.text);
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log('[nox-bridge] Disconnected. Reconnecting in 3s');
    reconnectTimer = setTimeout(connect, 3000);
  });

  ws.on('error', (e) => {
    console.error('[nox-bridge] WS error:', e.message);
  });
}

export function emit(type: string, payload: object = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
}

// Lifecycle hooks to call from OpenClaw internals:
export const noxHooks = {
  onThinkingStart: () => emit('thinking'),
  onThinkingEnd: () => emit('idle'),
  onToken: (token: string, fullText: string, done: boolean) =>
    emit('typing', { token, fullText, done }),
  onMessageSend: (text: string, target?: string) =>
    emit('speaking', { text, replyTo: target }),
  onExecStart: (command: string, sessionId: string) =>
    emit('executing', { command, sessionId }),
  onExecOutput: (sessionId: string, output: string, exitCode: number | null, done: boolean) =>
    emit('exec_output', { sessionId, output, exitCode, done }),
  onIdle: () => emit('idle'),
  onMoneyMoved: (direction: string, amount: string, currency: string, to: string, txHash: string, balanceAfter: string) =>
    emit('money_moved', { direction, amount, currency, to, txHash, balanceAfter }),
  onMessageReceived: (from: string, channel: string, text: string) =>
    emit('message_received', { from, channel, text }),
};

// Start bridge
connect();
```

### Integration Points in OpenClaw Core

The nox-bridge hooks need to be called at specific points. If OpenClaw emits lifecycle events on an EventEmitter:

```typescript
// Wiring (add to OpenClaw startup or skill loader)
import { noxHooks } from './skills/nox-bridge/bridge';

agentEmitter.on('thinking:start', noxHooks.onThinkingStart);
agentEmitter.on('thinking:end', noxHooks.onThinkingEnd);
agentEmitter.on('token', ({ token, fullText, done }) => noxHooks.onToken(token, fullText, done));
agentEmitter.on('message:send', ({ text, target }) => noxHooks.onMessageSend(text, target));
agentEmitter.on('exec:start', ({ command, sessionId }) => noxHooks.onExecStart(command, sessionId));
agentEmitter.on('exec:output', ({ sessionId, output, exitCode, done }) =>
  noxHooks.onExecOutput(sessionId, output, exitCode, done));
agentEmitter.on('idle', noxHooks.onIdle);
agentEmitter.on('wallet:transfer', (data) =>
  noxHooks.onMoneyMoved(data.direction, data.amount, data.currency, data.to, data.txHash, data.balanceAfter));
```

If OpenClaw does **not** have an internal emitter, the alternative is output monitoring:
- nox-bridge reads OpenClaw's log output (via pipe or file tail)
- Parses structured log lines that match known patterns
- Emits corresponding WebSocket events

This is less reliable but requires zero core changes.

---

## 26. Deployment — Production Checklist

### 26.1 Environment

| Item | Detail |
|---|---|
| OS | Ubuntu 22.04 LTS |
| Node | v20+ (LTS) |
| Python | 3.10+ (for local Kokoro) |
| RAM | 4GB minimum, 8GB recommended |
| Disk | 10GB for OS + deps + TTS cache |
| Ports | 3200 (HTTP/WS), optional 3202 (Kokoro local) |
| Domain | nox.yourdomain.com with valid SSL |

### 26.2 PM2 Process Config

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'nox-server',
      script: 'dist/server/index.js',
      env: { NODE_ENV: 'production' },
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'kokoro-tts',
      script: 'scripts/kokoro_serve.py',
      interpreter: 'python3',
      restart_delay: 5000,
      max_restarts: 5,
      watch: false,
    }
  ]
};
```

### 26.3 TTS Cache Cleanup (Cron)

```bash
# Crontab — clean TTS cache every hour, keep files < 1 hour old
0 * * * * find /tmp/nox-tts -name "*.wav" -mmin +60 -delete
```

### 26.4 Health Monitoring

```bash
# Simple uptime check (add to cron or systemd timer)
curl -sf http://localhost:3200/health | jq '.status'
```

### 26.5 Build + Deploy Script

```bash
#!/bin/bash
# scripts/deploy.sh

set -e

echo "Building..."
npm run build

echo "Copying to VPS..."
rsync -avz --exclude node_modules --exclude .env dist/ package.json \
  user@45.76.141.132:/opt/nox-stream/

echo "Restarting services..."
ssh user@45.76.141.132 "cd /opt/nox-stream && npm install --production && pm2 restart nox-server"

echo "Done."
```

---

## 27. What's Built vs. What's Not

**Currently implemented (in `server/` and `client/`):**

| File | Status |
|---|---|
| `server/index.ts` | ✅ Built |
| `server/config.ts` | ✅ Built |
| `server/eventRouter.ts` | ✅ Built |
| `server/openclawBridge.ts` | ✅ Built |
| `server/chatManager.ts` | ✅ Built |
| `server/tts/engine.ts` | ✅ Built |
| `server/tts/index.ts` | ✅ Built |
| `server/tts/kokoro.ts` | ✅ Built |
| `server/tts/elevenlabs.ts` | ✅ Built |
| `client/js/main.ts` | ✅ Built (scaffold) |
| `client/js/scene.ts` | ✅ Built |
| `client/js/vrm/loader.ts` | ✅ Built |
| `client/css/style.css` | ✅ Built |

**Not yet built (spec written, needs implementation):**

| File | Priority | Hours |
|---|---|---|
| `server/tts/kokoroX402.ts` | High | 3-4h |
| `client/js/vrm/animator.ts` | Critical | 8-10h |
| `client/js/lipSync.ts` | Critical | 4-6h |
| `client/js/particles.ts` | High | 3-4h |
| `client/js/audioPlayer.ts` | High | 2h |
| `client/js/wsClient.ts` | High | 2h |
| `client/js/subtitles.ts` | Medium | 2h |
| `client/js/terminal.ts` | Medium | 2h |
| `client/js/fragments.ts` | Medium | 3h |
| `client/js/walletBar.ts` | Medium | 2h |
| `client/js/keypressSounds.ts` | Low | 1h |
| `client/js/vrm/holoFragment.ts` | Low | 3h |
| `client/index.html` (full) | High | 2h |
| `client/obs.html` (full) | High | 1h |
| `assets/models/nox.vrm` | Blocking | 8-16h or commission |
| `~/.openclaw/skills/nox-bridge/` | Blocking | 6-10h |
| `scripts/kokoro_serve.py` | High | 3-4h |

**Immediate next step**: Build `animator.ts` using the spec in §16. That + the existing scene.ts gives you a visible avatar reacting to events. Ship that before touching lip sync or TTS enhancements.

---

## Appendix D: Kokoro Local Wrapper

```python
# scripts/kokoro_serve.py
# Run: python3 kokoro_serve.py
# Listens on :3202, POST /synthesize

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import base64
import io
import os
import sys

try:
    from kokoro import KPipeline
    import soundfile as sf
    import numpy as np
    KOKORO_AVAILABLE = True
except ImportError:
    KOKORO_AVAILABLE = False
    print("[kokoro_serve] WARNING: kokoro not installed. pip install kokoro soundfile")

pipeline = None

def get_pipeline():
    global pipeline
    if pipeline is None and KOKORO_AVAILABLE:
        pipeline = KPipeline(lang_code='a')  # 'a' = American English
    return pipeline

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logs

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok',
                'kokoro': KOKORO_AVAILABLE
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != '/synthesize':
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        try:
            data = json.loads(body)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        text = data.get('text', '')
        voice = data.get('voice', 'af_heart')
        speed = float(data.get('speed', 0.95))
        want_phonemes = data.get('return_phonemes', False)

        if not text:
            self.send_response(400)
            self.end_headers()
            return

        try:
            pipe = get_pipeline()
            if pipe is None:
                raise RuntimeError('Kokoro pipeline unavailable')

            audio_chunks = []
            phonemes = []

            for result in pipe(text, voice=voice, speed=speed):
                if result.audio is not None:
                    audio_chunks.append(result.audio)
                # Collect phoneme data if available
                if want_phonemes and hasattr(result, 'phonemes') and result.phonemes:
                    for p in result.phonemes:
                        phonemes.append({
                            'phoneme': p.phoneme,
                            'start': round(p.start, 4),
                            'end': round(p.end, 4)
                        })

            if not audio_chunks:
                raise RuntimeError('No audio generated')

            audio = np.concatenate(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]

            # Encode to WAV in memory
            buf = io.BytesIO()
            sf.write(buf, audio, 24000, format='WAV')
            audio_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')

            response = {
                'audio': audio_b64,
                'phonemes': phonemes,
                'sample_rate': 24000
            }

            response_bytes = json.dumps(response).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response_bytes)))
            self.end_headers()
            self.wfile.write(response_bytes)

            print(f"[kokoro_serve] Synthesized {len(text)} chars, {len(audio)/24000:.2f}s audio")

        except Exception as e:
            print(f"[kokoro_serve] ERROR: {e}", file=sys.stderr)
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('KOKORO_PORT', 3202))
    server = HTTPServer(('localhost', port), Handler)
    print(f"[kokoro_serve] Listening on http://localhost:{port}")
    print(f"[kokoro_serve] Kokoro available: {KOKORO_AVAILABLE}")
    server.serve_forever()
```

---

## Appendix E: tsconfig.json (Updated)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "paths": {}
  },
  "include": ["server/**/*.ts"],
  "exclude": ["node_modules", "dist", "client"]
}
```

Client-side TypeScript compiled separately with Vite or esbuild:

```json
// package.json (updated scripts)
{
  "scripts": {
    "dev": "concurrently \"nodemon --exec ts-node server/index.ts\" \"vite client/\"",
    "build:server": "tsc",
    "build:client": "vite build client/",
    "build": "npm run build:server && npm run build:client",
    "start": "node dist/server/index.js",
    "kokoro": "python3 scripts/kokoro_serve.py"
  }
}
```

---

## Appendix F: Complete Dependency List

```json
{
  "dependencies": {
    "dotenv": "^16.4",
    "ethers": "^6.11",
    "express": "^4.18",
    "ws": "^8.16"
  },
  "devDependencies": {
    "@types/express": "^4.17",
    "@types/node": "^20",
    "@types/ws": "^8.18",
    "@pixiv/three-vrm": "^2.1",
    "@pixiv/three-vrm-animation": "^2.1",
    "concurrently": "^8",
    "nodemon": "^3",
    "three": "^0.162",
    "ts-node": "^10.9",
    "typescript": "^5.3",
    "vite": "^5"
  },
  "python": {
    "kokoro": "pip install kokoro",
    "soundfile": "pip install soundfile",
    "numpy": "pip install numpy"
  }
}
```
