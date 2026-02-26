import * as THREE from 'three';
import { scene, camera, renderer, init as initScene, loadAvatar, updateVRM } from './scene';
import { ParticleSystem } from './particles';
import { WSClient } from './wsClient';
import { SubtitleRenderer } from './subtitles';
import { AvatarAnimator } from './vrm/animator';
import { AudioPlayer } from './audioPlayer';
import { LipSync } from './lipSync';
import { Terminal } from './terminal';
import { Screen } from './screen';
import { initStats, incrementMsgCount, setTask } from './stats';
import { ProjectContext } from './projectContext';
import { BuildStatus } from './buildStatus';
import { Chat } from './chat';
import type { VRM } from '@pixiv/three-vrm';

let particleSystem: ParticleSystem;
let subtitleRenderer: SubtitleRenderer;
let animator: AvatarAnimator | null = null;
let audioPlayer: AudioPlayer;
let lipSync: LipSync | null = null;
let lastTime = performance.now();

// Mouse parallax
let mouseX = 0, mouseY = 0;
let targetCamX = 0, targetCamY = 0;
const BASE_CAM_Z = -1.8;
document.addEventListener('mousemove', (e) => {
  mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
  mouseY = -(e.clientY / window.innerHeight - 0.5) * 2;
});

function createSubtitleContainer(): HTMLElement {
  let el = document.getElementById('subtitles');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'subtitles';
  document.body.appendChild(el);
  return el;
}

function setStateUI(state: string): void {
  const indicator = document.getElementById('state-indicator');
  const label = document.getElementById('state-label');
  if (indicator) indicator.className = state;
  if (label) label.textContent = state;
}

function animate(): void {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  // Mouse parallax — camera drifts slightly toward mouse
  targetCamX += (mouseX * 0.12 - targetCamX) * 0.04;
  targetCamY += (mouseY * 0.08 - targetCamY) * 0.04;
  camera.position.x = targetCamX;
  camera.position.y = 1.35 + targetCamY;
  camera.lookAt(0, 1.3, 0);

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
  const terminal = new Terminal();
  const screen = new Screen();

  // Load VRM
  const vrm = await loadAvatar('/models/fem_vroid.vrm');
  if (vrm) {
    animator = new AvatarAnimator(vrm);
    lipSync = new LipSync(vrm);
    if (vrm.expressionManager) {
      console.log('[main] VRM expressions:', 
        Object.keys((vrm.expressionManager as any)._expressionMap || {})
      );
    }
  }

  // Connect WebSocket
  const ws = new WSClient();

  // Init stats (wallet balance etc)
  initStats();

  // New widgets
  const projectContext = new ProjectContext();
  const buildStatus = new BuildStatus();
  const chat = new Chat(ws);

  // Track idle time for impatient reaction
  let lastActivityTime = performance.now();

  ws.on('thinking', (payload: any) => {
    particleSystem.setMode('thinking');
    if (animator) { animator.transition('thinking'); animator.react('focused'); }
    setStateUI('thinking');
    lastActivityTime = performance.now();
    if (payload?.text) { terminal.thinking(payload.text); screen.thinking(payload.text); }
  });

  ws.on('typing', (payload: any) => {
    if (animator) animator.transition('typing');
    if (payload?.fullText) subtitleRenderer.showTyping('', payload.fullText);
    setStateUI('typing');
    if (payload?.done && payload?.fullText) { terminal.output(payload.fullText); screen.typing(payload.fullText); }
  });

  ws.on('speaking', async (payload: any) => {
    if (animator) animator.transition('speaking');
    if (payload?.text) { subtitleRenderer.showSpeaking(payload.text); screen.speaking(payload.text); }
    incrementMsgCount();
    setStateUI('speaking');

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

  ws.on('executing', (payload: any) => {
    if (animator) animator.transition('executing');
    setStateUI('executing');
    lastActivityTime = performance.now();
    if (payload?.command) {
      const label = payload.input ? `${payload.command} ${payload.input}` : payload.command;
      terminal.command(label);
      screen.tool(payload.command);
      // Build detection
      if (payload.command === 'exec' && payload.input && /bun run|npm run|cargo build|make /.test(payload.input)) {
        buildStatus.startBuild(payload.command, payload.input);
      }
    }
    if (payload?.output) terminal.output(payload.output);
  });

  ws.on('tool_result', (payload: any) => {
    lastActivityTime = performance.now();
    if (payload?.output) { terminal.output(payload.output, '#44ffaa'); screen.result(payload.output); }
    if (payload?.error) { terminal.output(payload.error, '#ff4466'); screen.result(payload.error, true); }

    // Reaction based on result
    if (animator) {
      const output = (payload?.output || '') + (payload?.error || '');
      const isError = payload?.exitCode !== undefined && payload.exitCode !== 0
        || /error|Error|failed|FAILED/.test(output);
      animator.react(isError ? 'error' : 'success');
    }

    // Build status
    if (buildStatus.isBuilding) {
      const output = payload?.output || payload?.error || '';
      const success = !payload?.error && (payload?.exitCode === undefined || payload?.exitCode === 0);
      buildStatus.endBuild(success, output);
    }
  });

  ws.on('task', (payload: any) => {
    if (payload?.text) setTask(payload.text);
  });

  // Project context
  ws.on('project', (payload: any) => {
    projectContext.update(payload || {});
  });

  // Chat response from nox
  ws.on('chat_response', (payload: any) => {
    if (payload?.text) chat.addMessage('nox', payload.text);
  });

  // Mood changes
  ws.on('mood', (payload: any) => {
    if (animator && payload?.mood) {
      animator.setMood(payload.mood);
      console.log(`[main] mood → ${payload.mood}`);
    }
  });

  // Narration — fires in any state
  ws.on('narrate', async (payload: any) => {
    if (!payload?.text) return;

    if (animator) animator.transition('speaking');
    subtitleRenderer.showSpeaking(payload.text);
    setStateUI('speaking');

    if (payload?.audioUrl) {
      try {
        await audioPlayer.play(payload.audioUrl);
        if (lipSync) {
          if (payload.phonemes?.length > 0) lipSync.startWithPhonemes(payload.phonemes, audioPlayer);
          else lipSync.startAmplitude(audioPlayer);
        }
      } catch {}
    } else {
      // No audio — check for impatient reaction
      if (animator && (performance.now() - lastActivityTime) > 15000) {
        animator.react('impatient');
      }
      // Show subtitle for 3s then return to idle
      setTimeout(() => {
        subtitleRenderer.clear();
        if (animator) animator.transition('idle');
        setStateUI('idle');
      }, 3500);
    }
  });

  ws.on('idle', () => {
    particleSystem.setMode('ambient');
    if (animator) animator.transition('idle');
    if (lipSync) lipSync.stop();
    subtitleRenderer.clear();
    screen.idle();
    setStateUI('idle');
  });

  ws.on('money_moved', (payload: any) => {
    particleSystem.setMode('money');
    // After 3s, particles auto-return to ambient (handled in particles.ts)
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