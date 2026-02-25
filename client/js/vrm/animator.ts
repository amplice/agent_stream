import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

function safe(vrm: VRM, name: string, value: number) {
  try { vrm.expressionManager?.setValue(name, value); } catch {}
}

export type StateName = 'idle' | 'thinking' | 'typing' | 'speaking' | 'executing';

export class AvatarAnimator {
  private vrm: VRM;
  private state: StateName = 'idle';
  private time = 0;

  // Blink
  private blinkTimer = 1.5 + Math.random() * 2.5;
  private blinkProgress = 0;
  private isBlinking = false;

  // Smooth target rotations — VRoid normalized space
  // T-pose = arms horizontal (identity). Arms down = rotate X forward (~+1.4 rad)
  private headTargetX = 0;
  private headTargetY = 0;
  private headTargetZ = 0;
  private spineTargetX = 0;
  private chestTargetX = 0;
  // Left Z+ = down, Right Z- = down. π/2 ≈ 1.5708 = arms at sides
  private lUpperTargetX = 0; private lUpperTargetZ = 1.57;
  private rUpperTargetX = 0; private rUpperTargetZ = -1.57;
  private lLowerTargetX = 0;
  private rLowerTargetX = 0;

  // Phases
  private swayPhase = Math.random() * Math.PI * 2;
  private typingPhase = 0;
  private fingerPhase = 0;
  private speakPhase = 0;

  // Reaction overlay
  private reactionActive = false;
  private reactionTimer = 0;
  private reactionDuration = 1.5;
  private reactionExpressions: Record<string, number> = {};
  private reactionHeadOffset = { x: 0, y: 0, z: 0 };

  constructor(vrm: VRM) {
    this.vrm = vrm;
    console.log('[animator] BUILD: v8 — quaternion arms, no more euler guessing');
    console.log('[animator] Procedural animator ready');

    // Debug: [ = arms more down, ] = arms more up
    window.addEventListener('keydown', (e) => {
      if (e.key === '[' || e.key === ']') {
        const delta = e.key === '[' ? 0.1 : -0.1; // [ = more positive = more down for left
        this.lUpperTargetZ += delta;
        this.rUpperTargetZ -= delta; // right is opposite sign
        console.log(`[debug] lUpperZ=${this.lUpperTargetZ.toFixed(2)} rUpperZ=${this.rUpperTargetZ.toFixed(2)}`);
      }
    });
  }

  transition(state: StateName): void {
    if (state === this.state) return;
    console.log(`[animator] → ${state}`);
    this.state = state;
    this.typingPhase = 0;
    this.fingerPhase = 0;
    this.speakPhase = 0;
  }

  get currentState(): StateName { return this.state; }

  react(event: 'success' | 'error' | 'surprise' | 'focused' | 'impatient'): void {
    this.reactionActive = true;
    this.reactionTimer = 0;
    this.reactionDuration = 1.5;
    this.reactionHeadOffset = { x: 0, y: 0, z: 0 };

    switch (event) {
      case 'success':
        this.reactionExpressions = { happy: 0.8 };
        break;
      case 'error':
        this.reactionExpressions = { angry: 0.6, sad: 0.2 };
        break;
      case 'surprise':
        this.reactionExpressions = { relaxed: 0.7 };
        this.reactionHeadOffset = { x: 0, y: 0, z: 0.12 };
        break;
      case 'focused':
        this.reactionExpressions = { angry: 0.15 };
        break;
      case 'impatient':
        this.reactionExpressions = { relaxed: 0.3 };
        this.reactionHeadOffset = { x: 0, y: 0.08, z: 0 };
        break;
    }
  }

  private debugLogTimer = 0;

  update(dt: number): void {
    this.time += dt;
    this.swayPhase += dt * 0.5;

    // Update reaction timer
    if (this.reactionActive) {
      this.reactionTimer += dt;
      if (this.reactionTimer >= this.reactionDuration) {
        this.reactionActive = false;
        this.reactionExpressions = {};
        this.reactionHeadOffset = { x: 0, y: 0, z: 0 };
      }
    }

    this.updateTargets(dt);
    this.applyBones();
    this.updateBlink(dt);
    this.updateExpressions();
  }

  private updateTargets(dt: number): void {
    const t = this.time;
    const s = this.swayPhase;

    switch (this.state) {
      case 'idle': {
        this.headTargetX = Math.sin(s * 0.7) * 0.04;
        this.headTargetY = Math.sin(s * 0.3) * 0.08;
        this.headTargetZ = Math.sin(s * 0.4) * 0.02;
        this.spineTargetX = Math.sin(s * 0.6) * 0.02;
        this.chestTargetX = Math.sin(s * 0.5) * 0.03;
        this.lUpperTargetX = 0;
        this.lUpperTargetZ = 1.57;
        this.rUpperTargetX = 0;
        this.rUpperTargetZ = -1.57;
        this.lLowerTargetX = 0;
        this.rLowerTargetX = 0;
        break;
      }
      case 'thinking': {
        // Right hand raised to chin, left arm relaxed
        this.headTargetX = 0.08;
        this.headTargetY = Math.sin(s * 0.25) * 0.12;
        this.headTargetZ = 0.06;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = 0.15;
        this.lUpperTargetZ = 1.3;   // left arm at side
        this.rUpperTargetX = -0.6;
        this.rUpperTargetZ = -0.5;  // right arm raised
        this.lLowerTargetX = -0.3;
        this.rLowerTargetX = -1.4;  // right elbow bent toward chin
        break;
      }
      case 'typing': {
        this.typingPhase += dt * 14;
        this.fingerPhase += dt * 18;
        this.headTargetX = 0.1 + Math.sin(this.typingPhase * 0.5) * 0.02;
        this.headTargetY = Math.sin(t * 0.5) * 0.04;
        this.headTargetZ = 0;
        this.spineTargetX = 0.06;
        this.chestTargetX = 0.04;
        // Arms forward for keyboard
        this.lUpperTargetX = 0.5 + Math.sin(this.typingPhase) * 0.05;
        this.lUpperTargetZ = 0.7;
        this.rUpperTargetX = 0.5 + Math.sin(this.typingPhase + Math.PI) * 0.05;
        this.rUpperTargetZ = -0.7;
        this.lLowerTargetX = -1.2 + Math.sin(this.typingPhase) * 0.06;
        this.rLowerTargetX = -1.2 + Math.sin(this.typingPhase + Math.PI) * 0.06;
        break;
      }
      case 'speaking': {
        this.speakPhase += dt * 2.2;
        this.headTargetX = Math.sin(this.speakPhase * 0.6) * 0.08;
        this.headTargetY = Math.sin(this.speakPhase * 0.4) * 0.12;
        this.headTargetZ = Math.sin(this.speakPhase * 0.3) * 0.04;
        this.spineTargetX = Math.sin(this.speakPhase * 0.5) * 0.03;
        this.chestTargetX = 0.02;
        // Subtle gestures while talking — arms mostly at sides with movement
        this.lUpperTargetX = 0.1 + Math.sin(this.speakPhase * 0.7) * 0.12;
        this.lUpperTargetZ = 1.0 + Math.sin(this.speakPhase * 0.5) * 0.15;
        this.rUpperTargetX = 0.1 + Math.sin(this.speakPhase * 0.7 + 0.8) * 0.12;
        this.rUpperTargetZ = -1.0 - Math.sin(this.speakPhase * 0.5 + 0.8) * 0.15;
        this.lLowerTargetX = -0.5 + Math.sin(this.speakPhase) * 0.15;
        this.rLowerTargetX = -0.5 + Math.sin(this.speakPhase + Math.PI) * 0.15;
        break;
      }
      case 'executing': {
        // Focused — arms in front, working on something
        this.headTargetX = 0.06;
        this.headTargetY = Math.sin(s * 0.8) * 0.15;
        this.headTargetZ = 0;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = 0.4;
        this.lUpperTargetZ = 0.9;
        this.rUpperTargetX = 0.4;
        this.rUpperTargetZ = -0.9;
        this.lLowerTargetX = -0.8;
        this.rLowerTargetX = -0.8;
        break;
      }
    }
  }

  private applyBones(): void {
    const b = (name: string) => {
      return this.vrm.humanoid?.getNormalizedBoneNode(name as any) ?? null;
    };

    const speed = 0.08;

    // Head — simple euler is fine for small rotations
    const head = b('head');
    if (head) {
      head.quaternion.slerp(
        _q.setFromEuler(new THREE.Euler(
          this.headTargetX + this.reactionHeadOffset.x,
          this.headTargetY + this.reactionHeadOffset.y,
          this.headTargetZ + this.reactionHeadOffset.z
        )),
        speed
      );
    }

    const spine = b('spine');
    if (spine) {
      spine.quaternion.slerp(_q.setFromEuler(new THREE.Euler(this.spineTargetX, 0, 0)), speed * 0.5);
    }

    const chest = b('chest');
    if (chest) {
      chest.quaternion.slerp(_q.setFromEuler(new THREE.Euler(this.chestTargetX, 0, 0)), speed * 0.5);
    }

    // Arms — use quaternion multiply: first rotate Z (down from T-pose), then X (forward/back)
    const lu = b('leftUpperArm');
    if (lu) {
      const target = new THREE.Quaternion()
        .setFromAxisAngle(_axis.set(0, 0, 1), this.lUpperTargetZ)
        .multiply(_q.setFromAxisAngle(_axis.set(1, 0, 0), this.lUpperTargetX));
      lu.quaternion.slerp(target, speed);
    }

    const ru = b('rightUpperArm');
    if (ru) {
      const target = new THREE.Quaternion()
        .setFromAxisAngle(_axis.set(0, 0, 1), this.rUpperTargetZ)
        .multiply(_q.setFromAxisAngle(_axis.set(1, 0, 0), this.rUpperTargetX));
      ru.quaternion.slerp(target, speed);
    }

    const ll = b('leftLowerArm');
    if (ll) {
      ll.quaternion.slerp(_q.setFromAxisAngle(_axis.set(1, 0, 0), this.lLowerTargetX), speed);
    }

    const rl = b('rightLowerArm');
    if (rl) {
      rl.quaternion.slerp(_q.setFromAxisAngle(_axis.set(1, 0, 0), this.rLowerTargetX), speed);
    }
  }

  private updateBlink(dt: number) {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && !this.isBlinking) {
      this.isBlinking = true;
      this.blinkProgress = 0;
      this.blinkTimer = 2 + Math.random() * 4;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 12;
      if (this.blinkProgress >= 1) {
        this.isBlinking = false;
        this.blinkProgress = 0;
      }
      safe(this.vrm, 'blink', Math.sin(this.blinkProgress * Math.PI));
    } else {
      safe(this.vrm, 'blink', 0);
    }
  }

  private updateExpressions() {
    const t = this.time;

    // Base expressions from state
    const base: Record<string, number> = {};
    switch (this.state) {
      case 'idle':
        base.relaxed = 0.15 + Math.sin(t * 0.3) * 0.05;
        base.happy = 0.05;
        base.angry = 0;
        base.sad = 0;
        break;
      case 'thinking':
        base.relaxed = 0.4;
        base.happy = 0;
        base.neutral = 0.1;
        break;
      case 'typing':
        base.happy = 0.15 + Math.sin(t * 2.5) * 0.08;
        base.relaxed = 0;
        break;
      case 'speaking':
        base.happy = 0.25 + Math.sin(t * 1.2) * 0.1;
        base.relaxed = 0;
        break;
      case 'executing':
        base.relaxed = 0.05;
        base.happy = 0.05;
        break;
    }

    // Blend reaction on top (fade out in last 0.3s)
    if (this.reactionActive) {
      const fadeStart = this.reactionDuration - 0.3;
      const fade = this.reactionTimer > fadeStart
        ? 1 - (this.reactionTimer - fadeStart) / 0.3
        : 1;
      for (const [expr, val] of Object.entries(this.reactionExpressions)) {
        base[expr] = (base[expr] ?? 0) * (1 - fade) + val * fade;
      }
    }

    for (const [expr, val] of Object.entries(base)) {
      safe(this.vrm, expr, val);
    }
  }
}
