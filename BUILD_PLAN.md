# Nox Build Plan — Granular Execution Tasks

**Goal**: Avatar on screen reacting to OpenClaw events, lip sync working, TTS playing, particles responding to state, subtitles showing.

**Current state**: Server scaffolding done (index.ts, eventRouter.ts, config.ts, openclawBridge.ts, chatManager.ts, TTS engines). Client has scene.ts (Three.js + VRM loading working), particles.ts (ambient + thinking modes), wsClient.ts (connects + dispatches events), subtitles.ts (typewriter + speaking display), main.ts (wires events to state). BotBunny VRM loads and renders. Build compiles clean.

**What's missing**: The VRM avatar just sits there — no expressions, no bone animation, no lip sync, no audio playback. Events arrive from WS but only change the fallback sphere color. The `speaking` event has no TTS enrichment server-side (eventRouter just forwards raw events). No audioPlayer, no lipSync, no animator, no terminal overlay.

---

## Task 1: Server-side TTS enrichment for `speaking` events

**Files**: `server/eventRouter.ts`, `server/index.ts`

**What to do**:

1. In `server/eventRouter.ts`:
   - Import `TTSManager` from `./tts/index.js`
   - Import `config` from `./config.js`
   - Import `fs` and `path`
   - Create a singleton `const tts = new TTSManager()` at module level
   - At startup, ensure `config.ttsCacheDir` exists: `fs.mkdirSync(config.ttsCacheDir, { recursive: true })`
   - Change `eventRouter` to be `async function eventRouter(event: NoxEvent)`
   - Inside `eventRouter`, if `event.type === 'speaking'` and `event.payload` has a `text` field:
     - Call `const result = await tts.synthesize(event.payload.text)`
     - Mutate the event payload: `event.payload.audioUrl = result.audioUrl; event.payload.phonemes = result.phonemes; event.payload.duration = result.duration;`
     - Then broadcast the enriched event
   - For all other event types, broadcast immediately as before

2. In `server/index.ts`:
   - Add a static file route to serve TTS audio: `app.use('/audio', express.static(config.ttsCacheDir))` (import `config` if not already). Place this BEFORE the catch-all static route.
   - Import `config` from `./config.js`

**Test**: Send a `speaking` event via WebSocket to `/ws/openclaw`. The server should attempt TTS (will fail gracefully since no TTS engine is running) and broadcast the event with empty audioUrl. No crash.

---

## Task 2: Client audioPlayer module

**Files**: Create `client/js/audioPlayer.ts`

**What to do**:

Create the file with this exact implementation:

```typescript
export class AudioPlayer {
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private endCallbacks: (() => void)[] = [];
  private freqData: Uint8Array | null = null;

  constructor() {
    this.audio = document.createElement('audio');
    this.audio.crossOrigin = 'anonymous';
    this.audio.addEventListener('ended', () => {
      this.endCallbacks.forEach(cb => cb());
    });
  }

  private ensureContext(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.source = this.ctx.createMediaElementSource(this.audio);
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  async play(url: string): Promise<void> {
    this.ensureContext();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    this.audio.src = url;
    return this.audio.play();
  }

  stop(): void {
    this.audio.pause();
    this.audio.currentTime = 0;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  /** Returns 0-1 RMS volume from frequency data */
  getVolume(): number {
    if (!this.analyser || !this.freqData) return 0;
    this.analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i];
    return sum / (this.freqData.length * 255);
  }

  onEnded(cb: () => void): void {
    this.endCallbacks.push(cb);
  }
}
```

---

## Task 3: Client lipSync module (amplitude-based fallback + phoneme-based)

**Files**: Create `client/js/lipSync.ts`

**What to do**:

```typescript
import type { VRM } from '@pixiv/three-vrm';
import type { AudioPlayer } from './audioPlayer';

interface Phoneme {
  phoneme: string;
  start: number;
  end: number;
}

const PHONEME_TO_VISEME: Record<string, string> = {
  'AA': 'aa', 'AE': 'aa', 'AH': 'aa', 'AY': 'aa',
  'EH': 'ee', 'EY': 'ee', 'ER': 'ee',
  'IH': 'ih', 'IY': 'ih',
  'OH': 'oh', 'OW': 'oh', 'OY': 'oh',
  'UH': 'ou', 'UW': 'ou', 'AW': 'ou',
  'PP': 'aa', 'BB': 'aa', 'MM': 'aa',
  'FF': 'ih', 'VV': 'ih',
  'TH': 'oh', 'DH': 'oh',
  'DD': 'aa', 'TT': 'aa', 'NN': 'aa', 'LL': 'aa',
  'CH': 'ee', 'JH': 'ee', 'SH': 'ee', 'ZH': 'ee',
  'SS': 'ih', 'ZZ': 'ih',
  'RR': 'oh',
  'KK': 'aa', 'GG': 'aa', 'NG': 'aa',
  'SIL': 'neutral', 'SP': 'neutral',
};

// VRM 0.x expression names (BotBunny uses VRM 0.x via @pixiv/three-vrm@1.x)
const VISEME_EXPRESSIONS = ['aa', 'ee', 'ih', 'oh', 'ou'];

export class LipSync {
  private vrm: VRM;
  private player: AudioPlayer | null = null;
  private phonemes: Phoneme[] = [];
  private active = false;
  private mode: 'phoneme' | 'amplitude' = 'amplitude';
  private currentViseme = 'neutral';
  private targetViseme = 'neutral';
  private blend = 1;

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  startWithPhonemes(phonemes: Phoneme[], player: AudioPlayer): void {
    this.phonemes = phonemes;
    this.player = player;
    this.mode = 'phoneme';
    this.active = true;
  }

  startAmplitude(player: AudioPlayer): void {
    this.player = player;
    this.mode = 'amplitude';
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.clearVisemes();
  }

  get isActive(): boolean {
    return this.active;
  }

  update(dt: number): void {
    if (!this.active || !this.vrm.expressionManager) return;

    if (this.mode === 'phoneme' && this.player) {
      const t = this.player.currentTime;
      const active = this.phonemes.find(p => t >= p.start && t < p.end);
      const newV = active ? (PHONEME_TO_VISEME[active.phoneme] ?? 'neutral') : 'neutral';

      if (newV !== this.targetViseme) {
        this.currentViseme = this.targetViseme;
        this.targetViseme = newV;
        this.blend = 0;
      }

      this.blend = Math.min(1, this.blend + dt / 0.045);
      this.clearVisemes();

      if (this.currentViseme !== 'neutral') {
        this.vrm.expressionManager.setValue(this.currentViseme, 1 - this.blend);
      }
      if (this.targetViseme !== 'neutral') {
        this.vrm.expressionManager.setValue(this.targetViseme, this.blend);
      }
    } else if (this.mode === 'amplitude' && this.player) {
      const vol = this.player.getVolume();
      this.clearVisemes();
      // Map volume to mouth open — aa for wide, oh for round
      this.vrm.expressionManager.setValue('aa', vol * 0.85);
      this.vrm.expressionManager.setValue('oh', vol * 0.25);
    }
  }

  private clearVisemes(): void {
    if (!this.vrm.expressionManager) return;
    for (const v of VISEME_EXPRESSIONS) {
      this.vrm.expressionManager.setValue(v, 0);
    }
  }
}
```

**Note on VRM expression names**: BotBunny is a VRoid model exported as VRM 0.x. VRoid Studio exports with expression names `aa`, `ee`, `ih`, `oh`, `ou` for visemes and `blink`, `happy`, `angry`, `sad`, `relaxed`, `surprised` for expressions. The `@pixiv/three-vrm@1.x` package (which is what's installed) handles these. If expression names don't match at runtime, the `setValue` calls are no-ops (safe).

---

## Task 4: VRM animator state machine — idle + thinking + typing states

**Files**: Create `client/js/vrm/animator.ts`

**What to do**:

```typescript
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

export type StateName = 'idle' | 'thinking' | 'typing' | 'speaking' | 'executing';

export class AvatarAnimator {
  private vrm: VRM;
  private state: StateName = 'idle';
  private time = 0;
  private breathPhase = Math.random() * Math.PI * 2;
  private blinkTimer = 2 + Math.random() * 3;
  private blinkProgress = 0;
  private isBlinking = false;
  private headSwayPhase = Math.random() * Math.PI * 2;
  private typingPhase = 0;

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  transition(state: StateName): void {
    this.state = state;
    this.typingPhase = 0;
  }

  get currentState(): StateName {
    return this.state;
  }

  update(dt: number): void {
    this.time += dt;
    this.updateBreathing(dt);
    this.updateBlink(dt);
    this.headSwayPhase += dt * 0.3;

    switch (this.state) {
      case 'idle': this.applyIdle(dt); break;
      case 'thinking': this.applyThinking(dt); break;
      case 'typing': this.applyTyping(dt); break;
      case 'speaking': this.applySpeaking(dt); break;
      case 'executing': this.applyExecuting(dt); break;
    }
  }

  private updateBreathing(dt: number): void {
    const speed = this.state === 'thinking' ? 0.6 : 1.0;
    this.breathPhase += dt * speed;
    const chest = this.getBone('chest');
    if (chest) {
      const breathAmt = Math.sin(this.breathPhase * Math.PI) * 0.012;
      chest.rotation.x = breathAmt;
    }
  }

  private updateBlink(dt: number): void {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && !this.isBlinking) {
      this.isBlinking = true;
      this.blinkProgress = 0;
      this.blinkTimer = 2 + Math.random() * 4;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 8;
      if (this.blinkProgress >= 1) {
        this.isBlinking = false;
        this.blinkProgress = 0;
      }
    }
    const blinkVal = this.isBlinking ? Math.sin(this.blinkProgress * Math.PI) : 0;
    this.vrm.expressionManager?.setValue('blink', blinkVal);
  }

  private applyIdle(_dt: number): void {
    const head = this.getBone('head');
    if (head) {
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, Math.sin(this.headSwayPhase) * 0.012, 0.05);
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, Math.sin(this.headSwayPhase * 0.7) * 0.008, 0.05);
      head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0, 0.05);
    }
    this.vrm.expressionManager?.setValue('happy', 0);
    this.vrm.expressionManager?.setValue('surprised', 0);
  }

  private applyThinking(_dt: number): void {
    const head = this.getBone('head');
    if (head) {
      // Tilt head right slightly, lean forward
      head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0.1, 0.03);
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0.05, 0.03);
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, Math.sin(this.headSwayPhase * 0.7) * 0.005, 0.03);
    }
    const spine = this.getBone('spine');
    if (spine) {
      spine.rotation.x = THREE.MathUtils.lerp(spine.rotation.x, 0.06, 0.02);
    }
    // Narrow eyes slightly — use "relaxed" expression as proxy for squint
    // (VRoid models have: happy, angry, sad, relaxed, surprised)
    this.vrm.expressionManager?.setValue('relaxed', 0.3);
  }

  private applyTyping(dt: number): void {
    this.typingPhase += dt * 12;
    const head = this.getBone('head');
    if (head) {
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0.04, 0.05);
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, 0, 0.05);
      head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0, 0.05);
    }
    // Subtle forearm movement for typing feel
    const leftForearm = this.getBone('leftLowerArm');
    const rightForearm = this.getBone('rightLowerArm');
    if (leftForearm) {
      leftForearm.rotation.x = THREE.MathUtils.lerp(
        leftForearm.rotation.x,
        -0.35 + Math.sin(this.typingPhase) * 0.025,
        0.1
      );
    }
    if (rightForearm) {
      rightForearm.rotation.x = THREE.MathUtils.lerp(
        rightForearm.rotation.x,
        -0.35 + Math.sin(this.typingPhase + Math.PI) * 0.025,
        0.1
      );
    }
    this.vrm.expressionManager?.setValue('happy', 0.08);
  }

  private applySpeaking(_dt: number): void {
    const head = this.getBone('head');
    if (head) {
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, Math.sin(this.headSwayPhase) * 0.015, 0.05);
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, Math.sin(this.headSwayPhase * 0.7) * 0.01, 0.05);
      head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, 0, 0.05);
    }
    this.vrm.expressionManager?.setValue('relaxed', 0);
  }

  private applyExecuting(_dt: number): void {
    const head = this.getBone('head');
    if (head) {
      // Glance right toward terminal area
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, 0.25, 0.03);
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, 0.02, 0.03);
    }
    this.vrm.expressionManager?.setValue('relaxed', 0.15);
  }

  private getBone(name: string): THREE.Object3D | null {
    return this.vrm.humanoid?.getNormalizedBoneNode(name as any) ?? null;
  }
}
```

---

## Task 5: Wire animator + audioPlayer + lipSync into main.ts render loop

**Files**: Modify `client/js/main.ts`, modify `client/js/scene.ts`

**What to do in `scene.ts`**:

1. Export `getVRM` function — it already exists, good.
2. Remove the `setAvatarState` function (it only changes fallback sphere; the animator replaces it).
3. Keep `loadAvatar` returning a Promise but also resolve the VRM. Change it to `export async function loadAvatar(url: string): Promise<VRM | null>` — return `vrm` on success, `null` on fallback.

Specifically, change `loadAvatar`:
```typescript
export async function loadAvatar(url: string): Promise<VRM | null> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  try {
    const gltf = await loader.loadAsync(url);
    vrm = gltf.userData.vrm as VRM;
    if (!vrm) throw new Error('No VRM in file');
    VRMUtils.removeUnnecessaryJoints(vrm.scene);
    vrm.scene.rotation.y = Math.PI;
    scene.add(vrm.scene);
    console.log('[scene] VRM loaded:', url);
    return vrm;
  } catch (e) {
    console.warn('[scene] VRM load failed, using fallback sphere:', e);
    showFallback();
    return null;
  }
}
```

Remove the `setAvatarState` export entirely (delete the function).

**What to do in `main.ts`** — full rewrite:

```typescript
import * as THREE from 'three';
import { scene, camera, renderer, init as initScene, loadAvatar, updateVRM } from './scene';
import { ParticleSystem } from './particles';
import { WSClient } from './wsClient';
import { SubtitleRenderer } from './subtitles';
import { AvatarAnimator } from './vrm/animator';
import { AudioPlayer } from './audioPlayer';
import { LipSync } from './lipSync';
import type { VRM } from '@pixiv/three-vrm';

let particleSystem: ParticleSystem;
let subtitleRenderer: SubtitleRenderer;
let animator: AvatarAnimator | null = null;
let audioPlayer: AudioPlayer;
let lipSync: LipSync | null = null;
let lastTime = performance.now();

function createSubtitleContainer(): HTMLElement {
  let el = document.getElementById('subtitles');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'subtitles';
  document.body.appendChild(el);
  return el;
}

function animate(): void {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  // Update avatar state machine (bones + expressions)
  if (animator) animator.update(dt);

  // Update lip sync (visemes on top of animator expressions)
  if (lipSync && lipSync.isActive) lipSync.update(dt);

  // Update VRM internal (spring bones etc)
  updateVRM(dt);

  // Particles
  particleSystem.update(dt);

  // Render
  renderer.render(scene, camera);
}

async function bootstrap(): Promise<void> {
  initScene();

  const subtitleEl = createSubtitleContainer();
  subtitleRenderer = new SubtitleRenderer(subtitleEl);
  audioPlayer = new AudioPlayer();
  particleSystem = new ParticleSystem(scene);

  // Load VRM
  const vrm = await loadAvatar('/assets/models/botbunny.vrm');
  if (vrm) {
    animator = new AvatarAnimator(vrm);
    lipSync = new LipSync(vrm);
  }

  // Connect WebSocket
  const ws = new WSClient();

  ws.on('thinking', () => {
    particleSystem.setMode('thinking');
    if (animator) animator.transition('thinking');
  });

  ws.on('typing', (payload: any) => {
    if (animator) animator.transition('typing');
    if (payload?.fullText) subtitleRenderer.showTyping('', payload.fullText);
  });

  ws.on('speaking', async (payload: any) => {
    if (animator) animator.transition('speaking');
    if (payload?.text) subtitleRenderer.showSpeaking(payload.text);

    // Play TTS audio if available
    if (payload?.audioUrl) {
      try {
        await audioPlayer.play(payload.audioUrl);
        // Start lip sync
        if (lipSync) {
          if (payload.phonemes && payload.phonemes.length > 0) {
            lipSync.startWithPhonemes(payload.phonemes, audioPlayer);
          } else {
            lipSync.startAmplitude(audioPlayer);
          }
        }
      } catch (e) {
        console.warn('[main] Audio play failed:', e);
      }
    }
  });

  ws.on('executing', () => {
    if (animator) animator.transition('executing');
  });

  ws.on('idle', () => {
    particleSystem.setMode('ambient');
    if (animator) animator.transition('idle');
    if (lipSync) lipSync.stop();
    subtitleRenderer.clear();
  });

  // When audio ends, return to idle
  audioPlayer.onEnded(() => {
    if (lipSync) lipSync.stop();
    if (animator && animator.currentState === 'speaking') {
      animator.transition('idle');
      particleSystem.setMode('ambient');
    }
  });

  ws.connect();
  animate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
```

---

## Task 6: Serve TTS cache directory and add missing audio static route

**Files**: Modify `server/index.ts`

**What to do**:

1. After `import { config } from './config.js';` add `import fs from 'fs';`
2. After `const app = express();` add:
   ```typescript
   // Ensure TTS cache dir exists
   fs.mkdirSync(config.ttsCacheDir, { recursive: true });
   // Serve TTS audio files
   app.use('/audio', express.static(config.ttsCacheDir));
   ```
3. Add a health endpoint: `app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));`

---

## Task 7: Test end-to-end with a mock event sender script

**Files**: Create `scripts/test-events.ts`

**What to do**:

Create a script that sends test events to the server via WebSocket:

```typescript
import WebSocket from 'ws';

const secret = process.env.NOX_SECRET || '';
const url = `ws://localhost:3200/ws/openclaw`;

const ws = new WebSocket(url, {
  headers: secret ? { 'Authorization': `Bearer ${secret}` } : {}
});

ws.on('open', async () => {
  console.log('Connected to nox-server');

  const send = (event: any) => {
    console.log('Sending:', event.type);
    ws.send(JSON.stringify(event));
  };

  // Simulate: thinking → typing → speaking → idle
  send({ type: 'thinking', ts: Date.now(), payload: {} });

  await sleep(2000);
  send({ type: 'typing', ts: Date.now(), payload: { token: 'Hello', fullText: 'Hello', done: false } });

  await sleep(500);
  send({ type: 'typing', ts: Date.now(), payload: { token: ' world', fullText: 'Hello world', done: false } });

  await sleep(500);
  send({ type: 'typing', ts: Date.now(), payload: { token: '!', fullText: 'Hello world!', done: true } });

  await sleep(1000);
  send({ type: 'speaking', ts: Date.now(), payload: { text: 'Hello world! How is everyone doing today?' } });

  await sleep(4000);
  send({ type: 'idle', ts: Date.now(), payload: {} });

  await sleep(1000);
  send({ type: 'executing', ts: Date.now(), payload: { command: 'npm test', sessionId: 'test1' } });

  await sleep(2000);
  send({ type: 'idle', ts: Date.now(), payload: {} });

  console.log('Test sequence complete');
  ws.close();
});

ws.on('error', (e) => console.error('WS Error:', e.message));

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

Add to package.json scripts: `"test:events": "npx tsx scripts/test-events.ts"`

---

## Task 8: Add 'money' particle mode to particles.ts

**Files**: Modify `client/js/particles.ts`

**What to do**:

1. Change the `setMode` signature to accept `'ambient' | 'thinking' | 'money'`
2. In the `update()` method, add a `money` branch inside the per-particle loop. When `this.mode === 'money'`:
   - Particles burst outward from center `(0, 1.2, 0)` radially
   - Speed: `0.5 * dt` in the outward direction based on particle angle `(i / this.count) * Math.PI * 2`
   - Color: gold — set `this.colors[i*3] = 1.0; this.colors[i*3+1] = 0.67; this.colors[i*3+2] = 0.0;` (currently particles use a `Particle` object with a `color` field — update the color buffer directly in the loop)
   - If particle distance from center > 3, reset to center
3. After the mode resets after 3 seconds, call `setMode('ambient')`. To handle this: in `setMode`, if mode is `'money'`, store `this.moneyStartedAt = this.time`. In `update`, if `this.mode === 'money' && this.time - this.moneyStartedAt > 3`, call `this.setMode('ambient')`.
4. Also update the colors buffer attribute: add `this.points.geometry.getAttribute('color').needsUpdate = true;` at end of update for money mode, and set color data into the positions buffer. 

Actually, the current particles.ts uses a `Particle[]` with individual `color` fields and a colors float array. The color buffer is set during init but never updated in the loop. For the money mode to show gold:

In the update loop, after updating positions, add a section that updates the colors array for `money` mode:
```typescript
if (this.mode === 'money') {
  this.colors[i * 3] = 1.0;
  this.colors[i * 3 + 1] = 0.67;
  this.colors[i * 3 + 2] = 0.0;
} else {
  this.colors[i * 3] = p.color.r;
  this.colors[i * 3 + 1] = p.color.g;
  this.colors[i * 3 + 2] = p.color.b;
}
```

And at end of `update()`:
```typescript
const colAttr = this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
colAttr.needsUpdate = true;
```

---

## Task 9: Wire money_moved event in main.ts + particles

**Files**: Modify `client/js/main.ts`

**What to do**:

In the `bootstrap()` function, add a handler after the existing `ws.on('idle', ...)`:

```typescript
ws.on('money_moved', (payload: any) => {
  particleSystem.setMode('money');
  // After 3s, particles auto-return to ambient (handled in particles.ts)
});
```

---

## Task 10: VRM expression name discovery and blendShape compatibility fix

**Files**: Modify `client/js/vrm/animator.ts`, modify `client/js/lipSync.ts`

**What to do**:

VRM 0.x models from VRoid may have different expression names than VRM 1.0. The installed `@pixiv/three-vrm@^1.0.0` supports VRM 0.x. Expression names in VRoid VRM 0.x are typically: `Fcl_ALL_Neutral`, `Fcl_ALL_Angry`, `Fcl_ALL_Fun`, `Fcl_ALL_Joy`, `Fcl_ALL_Sorrow`, `Fcl_ALL_Surprised`, `Fcl_MTH_A`, `Fcl_MTH_I`, `Fcl_MTH_U`, `Fcl_MTH_E`, `Fcl_MTH_O`, `Fcl_EYE_Close`, etc. BUT three-vrm@1.x normalizes these to standard preset names: `happy`, `angry`, `sad`, `relaxed`, `surprised`, `blink`, `aa`, `ih`, `ou`, `ee`, `oh`.

To be safe, add a helper at top of `animator.ts`:

```typescript
/** Try setting expression, silently ignore if not found */
function safeSetExpression(vrm: VRM, name: string, value: number): void {
  try {
    vrm.expressionManager?.setValue(name, value);
  } catch {
    // Expression not available on this model
  }
}
```

Replace all `this.vrm.expressionManager?.setValue(...)` calls in animator.ts with `safeSetExpression(this.vrm, ...)`.

Same for lipSync.ts — wrap `setValue` calls with try/catch.

Also add a debug log on VRM load. In `main.ts`, after `const vrm = await loadAvatar(...)`, if `vrm`:
```typescript
if (vrm.expressionManager) {
  console.log('[main] VRM expressions:', 
    Object.keys((vrm.expressionManager as any)._expressionMap || {})
  );
}
```

This will tell us at runtime exactly which expressions the BotBunny model has, so we can adjust names if needed.

---

## Task 11: Subtitle styling improvements — match spec aesthetic

**Files**: Modify `client/css/style.css`

**What to do**:

Replace the `#subtitles` CSS with:

```css
#subtitles {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 18px;
  color: #e0d0ff;
  background: rgba(20, 10, 30, 0.85);
  padding: 12px 24px;
  border-radius: 8px;
  border: 1px solid rgba(136, 102, 255, 0.3);
  box-shadow: 0 4px 20px rgba(136, 102, 255, 0.2);
  text-align: center;
  max-width: 80%;
  pointer-events: none;
  z-index: 1000;
  opacity: 0;
  transition: opacity 0.3s ease;
  text-shadow: 0 0 10px rgba(136, 102, 255, 0.5);
}

#subtitles:not(:empty) {
  opacity: 1;
}
```

Update `SubtitleRenderer.showSpeaking` to not manually set opacity — let CSS `:not(:empty)` handle it. Update `clear()` to set `this.element.textContent = ''` which will trigger the CSS fade.

Modify `client/js/subtitles.ts`:

In `showSpeaking`: remove the line `this.element.style.opacity = '1';` and in the fade timeout, just set `this.element.textContent = ''` instead of changing opacity.

```typescript
showSpeaking(text: string): void {
  this.clear();
  this.element.textContent = text;
  if (this.fadeTimeout) clearTimeout(this.fadeTimeout);
  this.fadeTimeout = setTimeout(() => {
    this.element.textContent = '';
  }, 5000);
}

clear(): void {
  if (this.typewriterTimeout) { clearTimeout(this.typewriterTimeout); this.typewriterTimeout = null; }
  if (this.fadeTimeout) { clearTimeout(this.fadeTimeout); this.fadeTimeout = null; }
  this.element.textContent = '';
}
```

---

## Task 12: Scanline + vignette overlay for void aesthetic

**Files**: Modify `client/css/style.css`, modify `client/index.html`, modify `client/obs.html`

**What to do**:

Add to `style.css`:

```css
#scene-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

/* Vignette */
#scene-overlay::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 80% 80% at 50% 50%,
    transparent 40%,
    rgba(0, 0, 0, 0.6) 100%
  );
}

/* Scanlines */
#scene-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0px,
    transparent 2px,
    rgba(0, 0, 0, 0.06) 2px,
    rgba(0, 0, 0, 0.06) 4px
  );
}
```

In both `index.html` and `obs.html`, add `<div id="scene-overlay"></div>` after the `<canvas>` element.

---

## Task 13: State indicator dot (top-left corner)

**Files**: Modify `client/css/style.css`, modify `client/index.html`, modify `client/obs.html`, modify `client/js/main.ts`

**What to do**:

Add to HTML (both files), after `<div id="scene-overlay">`:

```html
<div id="state-indicator">
  <div id="state-dot"></div>
  <span id="state-label">idle</span>
</div>
```

Add to `style.css`:

```css
#state-indicator {
  position: fixed;
  top: 20px;
  left: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: rgba(136, 102, 255, 0.6);
  z-index: 10;
  text-transform: uppercase;
  letter-spacing: 0.15em;
}

#state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6633cc;
  box-shadow: 0 0 8px #6633cc;
  transition: background 0.3s, box-shadow 0.3s;
}

#state-indicator.thinking #state-dot { background: #9955ff; box-shadow: 0 0 12px #9955ff; }
#state-indicator.typing #state-dot { background: #8866ff; box-shadow: 0 0 10px #8866ff; }
#state-indicator.speaking #state-dot { background: #aa88ff; box-shadow: 0 0 14px #aa88ff; }
#state-indicator.executing #state-dot { background: #00ccff; box-shadow: 0 0 12px #00ccff; }
```

In `main.ts`, add a helper function:

```typescript
function setStateUI(state: string): void {
  const indicator = document.getElementById('state-indicator');
  const label = document.getElementById('state-label');
  if (indicator) indicator.className = state;
  if (label) label.textContent = state;
}
```

Call `setStateUI(state)` in each event handler alongside the animator transition. E.g. in the `thinking` handler: `setStateUI('thinking');` etc.

---

## Summary / Dependency Order

```
Task 1  (server TTS enrichment)     — standalone
Task 2  (audioPlayer)               — standalone
Task 3  (lipSync)                   — depends on Task 2
Task 4  (animator)                  — standalone
Task 5  (wire into main.ts)         — depends on Tasks 2, 3, 4
Task 6  (serve audio route)         — depends on Task 1
Task 7  (test script)               — depends on Tasks 1, 5, 6
Task 8  (money particles)           — standalone
Task 9  (money event wiring)        — depends on Tasks 5, 8
Task 10 (expression compat)         — depends on Tasks 4, 3
Task 11 (subtitle styling)          — standalone
Task 12 (scanline/vignette)         — standalone
Task 13 (state indicator)           — depends on Task 5
```

**Parallelizable**: Tasks 1+2+4+8+11+12 can all run simultaneously. Then 3+6, then 5, then 7+9+10+13.

**Critical path**: 1 → 6 → 5 → 7 (server enrichment → audio serving → full wiring → test)
