import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _euler = new THREE.Euler();

function safe(vrm: VRM, name: string, value: number) {
  try { vrm.expressionManager?.setValue(name, value); } catch {}
}

/** Peseudo-random deterministic hash for variety */
function hash(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth noise from multiple sine waves */
function smoothNoise(t: number, seed: number): number {
  return Math.sin(t * 1.1 + seed) * 0.3
    + Math.sin(t * 2.3 + seed * 1.7) * 0.2
    + Math.sin(t * 0.7 + seed * 3.1) * 0.3
    + Math.sin(t * 3.7 + seed * 0.3) * 0.2;
}

export type StateName = 'idle' | 'thinking' | 'typing' | 'speaking' | 'executing';
export type MoodName = 'lonely' | 'chill' | 'tsundere' | 'flustered' | 'rage' | 'smug' | 'hype';

// Speaking gesture library - each is a function of phase returning arm targets
interface GestureFrame {
  lZ: number; lY: number; lLower: number;
  rZ: number; rY: number; rLower: number;
}

const GESTURES: ((phase: number) => GestureFrame)[] = [
  // Open palm emphasis - both arms lift outward
  (p) => ({
    lZ: 0.8 + Math.sin(p) * 0.3, lY: -0.3 + Math.sin(p * 0.7) * 0.15, lLower: -0.5 + Math.sin(p) * 0.15,
    rZ: -0.8 - Math.sin(p + 0.5) * 0.3, rY: 0.3 + Math.sin(p * 0.7 + 0.5) * 0.15, rLower: -0.5 + Math.sin(p + 0.5) * 0.15,
  }),
  // Right hand point, left relaxed
  (p) => ({
    lZ: 1.2, lY: 0, lLower: -0.3,
    rZ: -0.4 + Math.sin(p * 1.5) * 0.15, rY: 0.6 + Math.sin(p) * 0.1, rLower: -0.3 + Math.sin(p * 1.5) * 0.1,
  }),
  // Both hands up - excited explanation
  (p) => ({
    lZ: 0.5 + Math.sin(p * 1.2) * 0.25, lY: -0.4 + Math.sin(p * 0.8) * 0.2, lLower: -0.8 + Math.sin(p * 1.2) * 0.2,
    rZ: -0.5 - Math.sin(p * 1.2 + 1) * 0.25, rY: 0.4 + Math.sin(p * 0.8 + 1) * 0.2, rLower: -0.8 + Math.sin(p * 1.2 + 1) * 0.2,
  }),
  // Left hand forward, right resting
  (p) => ({
    lZ: 0.6 + Math.sin(p * 1.3) * 0.2, lY: -0.5 + Math.sin(p) * 0.15, lLower: -0.6 + Math.sin(p * 1.3) * 0.15,
    rZ: -1.2, rY: 0, rLower: -0.3,
  }),
  // Symmetrical emphasis - both hands move in sync
  (p) => ({
    lZ: 0.7 + Math.sin(p) * 0.35, lY: -0.3, lLower: -0.6 + Math.sin(p) * 0.2,
    rZ: -0.7 - Math.sin(p) * 0.35, rY: 0.3, rLower: -0.6 + Math.sin(p) * 0.2,
  }),
  // Counting/listing - right hand ticks, left holds
  (p) => ({
    lZ: 0.9, lY: -0.2, lLower: -0.5,
    rZ: -0.5 + Math.sin(p * 2.5) * 0.2, rY: 0.4 + Math.sin(p * 2.5) * 0.1, rLower: -0.7 + Math.sin(p * 2.5) * 0.15,
  }),
];

// Idle sub-poses
interface IdleSubPose {
  duration: number;
  headX: number; headY: number; headZ: number;
  spineX: number;
  lZ: number; lY: number; lLower: number;
  rZ: number; rY: number; rLower: number;
  hipZ: number;
}

const IDLE_SUB_POSES: IdleSubPose[] = [
  // Shift weight left
  { duration: 4, headX: 0, headY: 0.06, headZ: 0.03, spineX: 0, lZ: 1.4, lY: 0, lLower: -0.3, rZ: -1.4, rY: 0, rLower: -0.3, hipZ: 0.04 },
  // Shift weight right
  { duration: 4, headX: 0, headY: -0.06, headZ: -0.03, spineX: 0, lZ: 1.4, lY: 0, lLower: -0.3, rZ: -1.4, rY: 0, rLower: -0.3, hipZ: -0.04 },
  // Look around left
  { duration: 3, headX: -0.05, headY: 0.25, headZ: 0.02, spineX: 0, lZ: 1.4, lY: 0, lLower: -0.3, rZ: -1.4, rY: 0, rLower: -0.3, hipZ: 0 },
  // Look around right
  { duration: 3, headX: -0.05, headY: -0.25, headZ: -0.02, spineX: 0, lZ: 1.4, lY: 0, lLower: -0.3, rZ: -1.4, rY: 0, rLower: -0.3, hipZ: 0 },
  // Touch hair (right hand up)
  { duration: 3.5, headX: 0.04, headY: 0.08, headZ: 0.06, spineX: 0, lZ: 1.4, lY: 0, lLower: -0.3, rZ: -0.3, rY: 0.3, rLower: -1.8, hipZ: 0 },
  // Brief arm cross
  { duration: 3, headX: 0.02, headY: 0, headZ: 0, spineX: 0.02, lZ: 0.9, lY: -0.4, lLower: -1.5, rZ: -0.9, rY: 0.4, rLower: -1.5, hipZ: 0 },
  // Look up
  { duration: 2.5, headX: -0.15, headY: 0.05, headZ: 0, spineX: -0.02, lZ: 1.4, lY: 0, lLower: -0.3, rZ: -1.4, rY: 0, rLower: -0.3, hipZ: 0 },
];

export class AvatarAnimator {
  private vrm: VRM;
  private state: StateName = 'idle';
  private mood: MoodName = 'chill';
  private time = 0;

  // Blink
  private blinkTimer = 1.5 + Math.random() * 2.5;
  private blinkProgress = 0;
  private isBlinking = false;
  private doubleBlinkPending = false;

  // Smooth bone targets
  private headTargetX = 0; private headTargetY = 0; private headTargetZ = 0;
  private spineTargetX = 0; private spineTargetZ = 0;
  private chestTargetX = 0;
  private upperChestTargetX = 0;
  private hipTargetX = 0; private hipTargetZ = 0;
  private lShoulderTargetZ = 0; private rShoulderTargetZ = 0;
  private lUpperTargetX = 0; private lUpperTargetY = 0; private lUpperTargetZ = 1.4;
  private rUpperTargetX = 0; private rUpperTargetY = 0; private rUpperTargetZ = -1.4;
  private lLowerTargetX = 0; private rLowerTargetX = 0;
  private lHandTargetX = 0; private rHandTargetX = 0;
  private lHandTargetZ = 0; private rHandTargetZ = 0;

  // Current smoothed quaternions
  private luCurrent = new THREE.Quaternion();
  private ruCurrent = new THREE.Quaternion();
  private headCurrent = new THREE.Quaternion();
  private spineCurrent = new THREE.Quaternion();
  private chestCurrent = new THREE.Quaternion();
  private upperChestCurrent = new THREE.Quaternion();
  private hipCurrent = new THREE.Quaternion();
  private lShoulderCurrent = new THREE.Quaternion();
  private rShoulderCurrent = new THREE.Quaternion();
  private llCurrent = new THREE.Quaternion();
  private rlCurrent = new THREE.Quaternion();
  private lHandCurrent = new THREE.Quaternion();
  private rHandCurrent = new THREE.Quaternion();

  // Phases
  private swayPhase = Math.random() * Math.PI * 2;
  private typingPhase = 0;
  private speakPhase = 0;
  private breathPhase = Math.random() * Math.PI * 2;

  // Breathing
  private breathRate = 4.0; // seconds per cycle

  // Slerp speeds per transition type
  private slerpSpeed = 0.08;

  // Speaking gesture system
  private currentGesture = 0;
  private gestureTimer = 0;
  private gestureInterval = 2.5;
  private nextGesture = 1;

  // Idle sub-pose system
  private idleSubPoseTimer = 8 + Math.random() * 7;
  private activeSubPose: IdleSubPose | null = null;
  private subPoseProgress = 0;
  private subPoseDuration = 0;
  private lastSubPoseIdx = -1;

  // Head nod during speaking
  private nodTimer = 0;
  private nodActive = false;
  private nodProgress = 0;

  // Reaction overlay
  private reactionActive = false;
  private reactionTimer = 0;
  private reactionDuration = 1.5;
  private reactionExpressions: Record<string, number> = {};
  private reactionHeadOffset = { x: 0, y: 0, z: 0 };

  // Micro-movement seeds (randomized per instance)
  private microSeeds = Array.from({ length: 12 }, () => Math.random() * 100);

  constructor(vrm: VRM) {
    this.vrm = vrm;
    console.log('[animator] v20 — expressive vtuber-quality animation system');
  }

  transition(state: StateName): void {
    if (state === this.state) return;
    console.log(`[animator] → ${state}`);

    // Set slerp speed based on transition type
    const prev = this.state;
    this.state = state;

    if (state === 'speaking' || state === 'executing') {
      this.slerpSpeed = 0.15; // fast for active states
    } else if (prev === 'idle' && state === 'thinking') {
      this.slerpSpeed = 0.06; // slow, contemplative
    } else if (state === 'idle') {
      this.slerpSpeed = 0.05; // gentle return to idle
    } else {
      this.slerpSpeed = 0.10;
    }

    this.typingPhase = 0;
    this.speakPhase = 0;
    this.gestureTimer = 0;
    this.currentGesture = Math.floor(Math.random() * GESTURES.length);
    this.nextGesture = (this.currentGesture + 1 + Math.floor(Math.random() * (GESTURES.length - 1))) % GESTURES.length;
    this.gestureInterval = 2 + Math.random() * 2;
    this.activeSubPose = null;
    this.idleSubPoseTimer = 8 + Math.random() * 7;
    this.nodTimer = 1 + Math.random() * 2;
    this.nodActive = false;
  }

  get currentState(): StateName { return this.state; }

  react(event: 'success' | 'error' | 'surprise' | 'focused' | 'impatient'): void {
    this.reactionActive = true;
    this.reactionTimer = 0;
    this.reactionDuration = 1.8;
    this.reactionHeadOffset = { x: 0, y: 0, z: 0 };

    // Fast slerp for reactions
    this.slerpSpeed = 0.2;

    switch (event) {
      case 'success':
        this.reactionExpressions = { happy: 0.85 };
        this.reactionHeadOffset = { x: -0.05, y: 0, z: 0 }; // slight look up
        break;
      case 'error':
        this.reactionExpressions = { angry: 0.5, sad: 0.3 };
        this.reactionHeadOffset = { x: 0.06, y: 0, z: 0 };
        break;
      case 'surprise':
        this.reactionExpressions = { surprised: 0.7 };
        this.reactionHeadOffset = { x: -0.08, y: 0, z: 0.1 };
        this.reactionDuration = 1.2;
        break;
      case 'focused':
        this.reactionExpressions = { angry: 0.15 };
        break;
      case 'impatient':
        this.reactionExpressions = { angry: 0.2, relaxed: 0.2 };
        this.reactionHeadOffset = { x: 0, y: 0.1, z: 0.05 };
        break;
    }
  }

  setMood(mood: MoodName): void {
    if (mood === this.mood) return;
    console.log(`[animator] mood → ${mood}`);
    this.mood = mood;
  }

  get currentMood(): MoodName { return this.mood; }

  update(dt: number): void {
    // Cap dt to avoid huge jumps
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.swayPhase += dt * 0.5;
    this.breathPhase += dt * (Math.PI * 2 / this.breathRate);

    // Reaction timer
    if (this.reactionActive) {
      this.reactionTimer += dt;
      if (this.reactionTimer >= this.reactionDuration) {
        this.reactionActive = false;
        this.reactionExpressions = {};
        this.reactionHeadOffset = { x: 0, y: 0, z: 0 };
      }
    }

    this.updateTargets(dt);
    this.applyBreathing();
    this.applyMicroMovements();
    this.applyBones(dt);
    this.updateBlink(dt);
    this.updateExpressions();
  }

  private updateTargets(dt: number): void {
    const t = this.time;
    const s = this.swayPhase;

    // Default finger curl (slightly curled, natural)
    this.lHandTargetX = -0.3;
    this.rHandTargetX = -0.3;
    this.lHandTargetZ = 0;
    this.rHandTargetZ = 0;

    // Default shoulders
    this.lShoulderTargetZ = 0;
    this.rShoulderTargetZ = 0;

    // Default hips / upper chest
    this.hipTargetX = 0;
    this.hipTargetZ = 0;
    this.upperChestTargetX = 0;

    switch (this.state) {
      case 'idle':
        this.updateIdle(dt, t, s);
        break;
      case 'thinking':
        this.updateThinking(dt, t, s);
        break;
      case 'typing':
        this.updateTyping(dt, t, s);
        break;
      case 'speaking':
        this.updateSpeaking(dt, t, s);
        break;
      case 'executing':
        this.updateExecuting(dt, t, s);
        break;
    }
  }

  private updateIdle(_dt: number, t: number, s: number): void {
    // Weight shifting
    this.hipTargetZ = Math.sin(s * 0.25) * 0.03;
    this.spineTargetZ = Math.sin(s * 0.25) * -0.015; // counter-sway

    // Base idle pose
    let headX = Math.sin(s * 0.7) * 0.04;
    let headY = Math.sin(s * 0.3) * 0.08;
    let headZ = Math.sin(s * 0.4) * 0.02;
    this.spineTargetX = -0.01; // slight lean back
    this.chestTargetX = Math.sin(s * 0.5) * 0.02;
    this.upperChestTargetX = -0.01;

    let lZ = 1.4 + Math.sin(s * 0.3) * 0.03;
    let lY = 0;
    let rZ = -1.4 - Math.sin(s * 0.3) * 0.03;
    let rY = 0;
    let lLower = -0.3;
    let rLower = -0.3;
    let hipZ = this.hipTargetZ;

    // Idle sub-pose system
    this.idleSubPoseTimer -= _dt;
    if (this.idleSubPoseTimer <= 0 && !this.activeSubPose) {
      // Pick a random sub-pose (different from last)
      let idx = Math.floor(Math.random() * IDLE_SUB_POSES.length);
      if (idx === this.lastSubPoseIdx) idx = (idx + 1) % IDLE_SUB_POSES.length;
      this.lastSubPoseIdx = idx;
      this.activeSubPose = IDLE_SUB_POSES[idx];
      this.subPoseProgress = 0;
      this.subPoseDuration = this.activeSubPose.duration;
    }

    if (this.activeSubPose) {
      this.subPoseProgress += _dt;
      const sp = this.activeSubPose;
      // Smooth in/out envelope
      const halfDur = this.subPoseDuration / 2;
      let blend: number;
      if (this.subPoseProgress < 0.6) {
        blend = this.subPoseProgress / 0.6; // ease in
      } else if (this.subPoseProgress > this.subPoseDuration - 0.6) {
        blend = (this.subPoseDuration - this.subPoseProgress) / 0.6; // ease out
      } else {
        blend = 1;
      }
      blend = Math.max(0, Math.min(1, blend));
      // Smooth step
      blend = blend * blend * (3 - 2 * blend);

      headX += sp.headX * blend;
      headY += sp.headY * blend;
      headZ += sp.headZ * blend;
      this.spineTargetX += sp.spineX * blend;
      lZ = lZ * (1 - blend) + sp.lZ * blend;
      lY = lY * (1 - blend) + sp.lY * blend;
      rZ = rZ * (1 - blend) + sp.rZ * blend;
      rY = rY * (1 - blend) + sp.rY * blend;
      lLower = lLower * (1 - blend) + sp.lLower * blend;
      rLower = rLower * (1 - blend) + sp.rLower * blend;
      hipZ += sp.hipZ * blend;

      if (this.subPoseProgress >= this.subPoseDuration) {
        this.activeSubPose = null;
        this.idleSubPoseTimer = 8 + Math.random() * 7;
      }
    }

    this.headTargetX = headX;
    this.headTargetY = headY;
    this.headTargetZ = headZ;
    this.lUpperTargetZ = lZ;
    this.lUpperTargetY = lY;
    this.rUpperTargetZ = rZ;
    this.rUpperTargetY = rY;
    this.lLowerTargetX = lLower;
    this.rLowerTargetX = rLower;
    this.hipTargetZ = hipZ;

    // Relaxed finger curl
    this.lHandTargetX = -0.25;
    this.rHandTargetX = -0.25;
  }

  private updateThinking(_dt: number, t: number, s: number): void {
    // Head: tilt and slow wander, occasional look-away
    this.headTargetX = 0.06 + Math.sin(t * 0.4) * 0.04;
    this.headTargetY = Math.sin(s * 0.25) * 0.15 + Math.sin(t * 0.7) * 0.05;
    this.headTargetZ = 0.08 + Math.sin(t * 0.3) * 0.03;

    // Body: slight lean forward
    this.spineTargetX = 0.04;
    this.chestTargetX = 0.02;
    this.upperChestTargetX = 0.02;

    // Subtle weight shift
    this.hipTargetZ = Math.sin(s * 0.2) * 0.015;

    // Left arm relaxed at side
    this.lUpperTargetZ = 1.3;
    this.lUpperTargetY = 0;
    this.lLowerTargetX = -0.3;

    // Right arm: chin-touch thinking pose
    this.rUpperTargetZ = -0.5 + Math.sin(t * 0.5) * 0.05;
    this.rUpperTargetY = 0.5 + Math.sin(t * 0.3) * 0.05;
    this.rLowerTargetX = -1.4 + Math.sin(t * 0.4) * 0.05;

    // Tighter finger curl on thinking hand
    this.rHandTargetX = -0.5;
    this.lHandTargetX = -0.25;
  }

  private updateTyping(_dt: number, t: number, _s: number): void {
    this.typingPhase += _dt * 14;

    // Head: looking down at keyboard with small movements
    this.headTargetX = 0.12 + Math.sin(this.typingPhase * 0.5) * 0.02;
    this.headTargetY = Math.sin(t * 0.5) * 0.04;
    this.headTargetZ = 0;

    // Body: lean forward
    this.spineTargetX = 0.07;
    this.chestTargetX = 0.05;
    this.upperChestTargetX = 0.03;

    // Subtle hip
    this.hipTargetZ = Math.sin(t * 0.3) * 0.01;

    // Arms forward for keyboard
    this.lUpperTargetY = -0.5 + Math.sin(this.typingPhase) * 0.05;
    this.lUpperTargetZ = 0.8;
    this.rUpperTargetY = 0.5 + Math.sin(this.typingPhase + Math.PI) * 0.05;
    this.rUpperTargetZ = -0.8;

    // Fingers active
    this.lLowerTargetX = -1.2 + Math.sin(this.typingPhase) * 0.06;
    this.rLowerTargetX = -1.2 + Math.sin(this.typingPhase + Math.PI) * 0.06;

    // Fingers more curled (typing)
    this.lHandTargetX = -0.4 + Math.sin(this.typingPhase * 2) * 0.1;
    this.rHandTargetX = -0.4 + Math.sin(this.typingPhase * 2 + Math.PI) * 0.1;

    // Shoulders slightly raised
    this.lShoulderTargetZ = 0.03;
    this.rShoulderTargetZ = -0.03;
  }

  private updateSpeaking(dt: number, t: number, s: number): void {
    this.speakPhase += dt * 2.2;

    // Gesture transitions
    this.gestureTimer += dt;
    if (this.gestureTimer >= this.gestureInterval) {
      this.gestureTimer = 0;
      this.currentGesture = this.nextGesture;
      this.nextGesture = (this.currentGesture + 1 + Math.floor(Math.random() * (GESTURES.length - 1))) % GESTURES.length;
      this.gestureInterval = 2 + Math.random() * 2.5;
    }

    // Blend between current and next gesture
    const blendT = Math.min(this.gestureTimer / 0.6, 1); // 0.6s transition
    const smoothBlend = blendT * blendT * (3 - 2 * blendT);
    const gCurrent = GESTURES[this.currentGesture](this.speakPhase);
    const gNext = GESTURES[this.nextGesture](this.speakPhase);

    // If we just switched (blendT < 1 at very start), cross-fade from previous
    // For simplicity, just use current gesture directly
    const g = gCurrent;

    // Head: dynamic with nodding
    this.nodTimer -= dt;
    if (this.nodTimer <= 0 && !this.nodActive) {
      this.nodActive = true;
      this.nodProgress = 0;
      this.nodTimer = 1.5 + Math.random() * 3;
    }
    let nodOffset = 0;
    if (this.nodActive) {
      this.nodProgress += dt * 5;
      nodOffset = Math.sin(this.nodProgress * Math.PI) * 0.08;
      if (this.nodProgress >= 1) {
        this.nodActive = false;
      }
    }

    this.headTargetX = Math.sin(this.speakPhase * 0.6) * 0.06 + nodOffset;
    this.headTargetY = Math.sin(this.speakPhase * 0.4) * 0.1;
    this.headTargetZ = Math.sin(this.speakPhase * 0.3) * 0.04;

    // Body: lean forward, dynamic
    this.spineTargetX = 0.03 + Math.sin(this.speakPhase * 0.5) * 0.02;
    this.chestTargetX = 0.03;
    this.upperChestTargetX = 0.02;

    // Weight shift
    this.hipTargetZ = Math.sin(s * 0.3) * 0.02;

    // Apply gesture
    this.lUpperTargetZ = g.lZ;
    this.lUpperTargetY = g.lY;
    this.rUpperTargetZ = g.rZ;
    this.rUpperTargetY = g.rY;
    this.lLowerTargetX = g.lLower;
    this.rLowerTargetX = g.rLower;

    // Open hands for gesturing
    this.lHandTargetX = -0.15;
    this.rHandTargetX = -0.15;
    this.lHandTargetZ = 0.1; // slight spread
    this.rHandTargetZ = -0.1;
  }

  private updateExecuting(_dt: number, t: number, s: number): void {
    // Focused monitoring pose
    this.headTargetX = 0.05 + Math.sin(t * 0.8) * 0.03;
    this.headTargetY = Math.sin(s * 0.8) * 0.12;
    this.headTargetZ = 0;

    this.spineTargetX = 0.04;
    this.chestTargetX = 0.02;
    this.upperChestTargetX = 0.02;

    this.hipTargetZ = Math.sin(s * 0.2) * 0.01;

    // Arms slightly forward (monitoring)
    this.lUpperTargetY = -0.4;
    this.lUpperTargetZ = 0.9;
    this.rUpperTargetY = 0.4;
    this.rUpperTargetZ = -0.9;

    this.lLowerTargetX = -0.8 + Math.sin(t * 0.5) * 0.05;
    this.rLowerTargetX = -0.8 + Math.sin(t * 0.5 + 1) * 0.05;

    // Slightly curled
    this.lHandTargetX = -0.35;
    this.rHandTargetX = -0.35;
  }

  private applyBreathing(): void {
    const breath = Math.sin(this.breathPhase);
    const breathAbs = (breath + 1) * 0.5; // 0-1

    // Expand chest/shoulders on inhale
    this.chestTargetX += breath * 0.015;
    this.upperChestTargetX += breath * 0.02;
    this.lShoulderTargetZ += breathAbs * 0.015;
    this.rShoulderTargetZ -= breathAbs * 0.015;

    // Subtle spine extension on inhale
    this.spineTargetX -= breath * 0.008;
  }

  private applyMicroMovements(): void {
    const t = this.time;
    const m = this.microSeeds;
    const intensity = this.state === 'idle' ? 1.0 : 0.5;

    this.headTargetX += smoothNoise(t * 0.8, m[0]) * 0.008 * intensity;
    this.headTargetY += smoothNoise(t * 0.6, m[1]) * 0.01 * intensity;
    this.headTargetZ += smoothNoise(t * 0.5, m[2]) * 0.005 * intensity;
    this.spineTargetX += smoothNoise(t * 0.3, m[3]) * 0.004 * intensity;
    this.lUpperTargetZ += smoothNoise(t * 0.4, m[4]) * 0.01 * intensity;
    this.rUpperTargetZ += smoothNoise(t * 0.4, m[5]) * -0.01 * intensity;
    this.lUpperTargetY += smoothNoise(t * 0.35, m[6]) * 0.008 * intensity;
    this.rUpperTargetY += smoothNoise(t * 0.35, m[7]) * 0.008 * intensity;
    this.hipTargetZ += smoothNoise(t * 0.2, m[8]) * 0.003 * intensity;
  }

  private applyBones(dt: number): void {
    const speed = this.slerpSpeed;
    // Gradually return slerp to normal
    this.slerpSpeed += (0.08 - this.slerpSpeed) * 0.01;

    // Head
    const hx = this.headTargetX + (this.reactionActive ? this.reactionHeadOffset.x * this.reactionFade() : 0);
    const hy = this.headTargetY + (this.reactionActive ? this.reactionHeadOffset.y * this.reactionFade() : 0);
    const hz = this.headTargetZ + (this.reactionActive ? this.reactionHeadOffset.z * this.reactionFade() : 0);
    _q.setFromEuler(_euler.set(hx, hy, hz));
    this.headCurrent.slerp(_q, speed);

    // Spine
    _q.setFromEuler(_euler.set(this.spineTargetX, 0, this.spineTargetZ ?? 0));
    this.spineCurrent.slerp(_q, speed);

    // Chest
    _q.setFromEuler(_euler.set(this.chestTargetX, 0, 0));
    this.chestCurrent.slerp(_q, speed);

    // Upper chest
    _q.setFromEuler(_euler.set(this.upperChestTargetX, 0, 0));
    this.upperChestCurrent.slerp(_q, speed);

    // Hips
    _q.setFromEuler(_euler.set(this.hipTargetX, 0, this.hipTargetZ));
    this.hipCurrent.slerp(_q, speed);

    // Shoulders
    _q.setFromEuler(_euler.set(0, 0, this.lShoulderTargetZ));
    this.lShoulderCurrent.slerp(_q, speed);
    _q.setFromEuler(_euler.set(0, 0, this.rShoulderTargetZ));
    this.rShoulderCurrent.slerp(_q, speed);

    // Upper arms: Z + Y combined quaternion
    const luTarget = new THREE.Quaternion()
      .setFromAxisAngle(_axis.set(0, 0, 1), this.lUpperTargetZ)
      .premultiply(_q.setFromAxisAngle(_axis.set(0, 1, 0), this.lUpperTargetY));
    const ruTarget = new THREE.Quaternion()
      .setFromAxisAngle(_axis.set(0, 0, 1), this.rUpperTargetZ)
      .premultiply(_q.setFromAxisAngle(_axis.set(0, 1, 0), this.rUpperTargetY));

    this.luCurrent.slerp(luTarget, speed);
    this.ruCurrent.slerp(ruTarget, speed);

    // Lower arms
    _q.setFromAxisAngle(_axis.set(1, 0, 0), this.lLowerTargetX);
    this.llCurrent.slerp(_q, speed);
    _q.setFromAxisAngle(_axis.set(1, 0, 0), this.rLowerTargetX);
    this.rlCurrent.slerp(_q, speed);

    // Hands
    _q.setFromEuler(_euler.set(this.lHandTargetX, 0, this.lHandTargetZ));
    this.lHandCurrent.slerp(_q, speed);
    _q.setFromEuler(_euler.set(this.rHandTargetX, 0, this.rHandTargetZ));
    this.rHandCurrent.slerp(_q, speed);

    const qToArr = (q: THREE.Quaternion): [number, number, number, number] => [q.x, q.y, q.z, q.w];

    this.vrm.humanoid.setNormalizedPose({
      hips: { rotation: qToArr(this.hipCurrent) },
      spine: { rotation: qToArr(this.spineCurrent) },
      chest: { rotation: qToArr(this.chestCurrent) },
      upperChest: { rotation: qToArr(this.upperChestCurrent) },
      head: { rotation: qToArr(this.headCurrent) },
      leftShoulder: { rotation: qToArr(this.lShoulderCurrent) },
      rightShoulder: { rotation: qToArr(this.rShoulderCurrent) },
      leftUpperArm: { rotation: qToArr(this.luCurrent) },
      rightUpperArm: { rotation: qToArr(this.ruCurrent) },
      leftLowerArm: { rotation: qToArr(this.llCurrent) },
      rightLowerArm: { rotation: qToArr(this.rlCurrent) },
      leftHand: { rotation: qToArr(this.lHandCurrent) },
      rightHand: { rotation: qToArr(this.rHandCurrent) },
    });
  }

  private reactionFade(): number {
    if (!this.reactionActive) return 0;
    const fadeStart = this.reactionDuration - 0.4;
    if (this.reactionTimer > fadeStart) {
      return 1 - (this.reactionTimer - fadeStart) / 0.4;
    }
    // Ease in
    if (this.reactionTimer < 0.15) return this.reactionTimer / 0.15;
    return 1;
  }

  private updateBlink(dt: number) {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && !this.isBlinking) {
      this.isBlinking = true;
      this.blinkProgress = 0;
      // Occasional double blink
      this.doubleBlinkPending = Math.random() < 0.25;
      this.blinkTimer = 2 + Math.random() * 4;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 12;
      if (this.blinkProgress >= 1) {
        if (this.doubleBlinkPending) {
          this.doubleBlinkPending = false;
          this.blinkProgress = 0; // restart for double blink
        } else {
          this.isBlinking = false;
          this.blinkProgress = 0;
        }
      }
      safe(this.vrm, 'blink', Math.sin(this.blinkProgress * Math.PI));
    } else {
      // State-based eye narrowing (via blink partial)
      let baseBlink = 0;
      if (this.state === 'thinking' || this.state === 'executing') {
        baseBlink = 0.12 + Math.sin(this.time * 0.5) * 0.05; // slightly narrowed, focused
      } else if (this.state === 'idle') {
        baseBlink = 0.05 + Math.sin(this.time * 0.2) * 0.03; // relaxed half-close
      }
      safe(this.vrm, 'blink', baseBlink);
    }
  }

  private updateExpressions() {
    const t = this.time;
    const base: Record<string, number> = {};

    switch (this.state) {
      case 'idle':
        base.relaxed = 0.2 + Math.sin(t * 0.3) * 0.08;
        base.happy = 0.08 + Math.sin(t * 0.15) * 0.04;
        break;
      case 'thinking':
        base.relaxed = 0.35 + Math.sin(t * 0.4) * 0.05;
        base.angry = 0.05; // slight furrow
        break;
      case 'typing':
        base.happy = 0.18 + Math.sin(t * 2.5) * 0.08;
        base.relaxed = 0.05;
        break;
      case 'speaking':
        base.happy = 0.3 + Math.sin(t * 1.2) * 0.12;
        // Mouth movement for speech
        base.aa = 0.15 + Math.sin(t * 8) * 0.1 + Math.sin(t * 12.7) * 0.05;
        base.oh = Math.max(0, Math.sin(t * 6.3) * 0.08);
        break;
      case 'executing':
        base.relaxed = 0.1;
        base.happy = 0.05;
        base.angry = 0.08; // focused
        break;
    }

    // Blend mood into base expressions
    const moodBlend: Record<string, Record<string, number>> = {
      lonely:    { sad: 0.25, relaxed: 0.15 },
      chill:     { relaxed: 0.15, happy: 0.05 },
      tsundere:  { angry: 0.15, happy: 0.08 },
      flustered: { surprised: 0.2, happy: 0.25 },
      rage:      { angry: 0.4 },
      smug:      { happy: 0.3, relaxed: 0.2 },
      hype:      { happy: 0.4, surprised: 0.1 },
    };
    const moodExprs = moodBlend[this.mood] || {};
    for (const [expr, val] of Object.entries(moodExprs)) {
      base[expr] = Math.min(1, (base[expr] ?? 0) + val);
    }

    // Blend reaction
    if (this.reactionActive) {
      const fade = this.reactionFade();
      for (const [expr, val] of Object.entries(this.reactionExpressions)) {
        base[expr] = (base[expr] ?? 0) * (1 - fade) + val * fade;
      }
    }

    for (const [expr, val] of Object.entries(base)) {
      safe(this.vrm, expr, val);
    }
  }
}
