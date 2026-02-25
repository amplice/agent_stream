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
  const vrm = await loadAvatar('/models/botbunny.vrm');
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

  ws.on('thinking', (payload: any) => {
    particleSystem.setMode('thinking');
    if (animator) animator.transition('thinking');
    setStateUI('thinking');
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
    if (payload?.command) { terminal.command(payload.command); screen.tool(payload.command); }
    if (payload?.output) terminal.output(payload.output);
  });

  ws.on('tool_result', (payload: any) => {
    if (payload?.output) { terminal.output(payload.output, '#44ffaa'); screen.result(payload.output); }
    if (payload?.error) { terminal.output(payload.error, '#ff4466'); screen.result(payload.error, true); }
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