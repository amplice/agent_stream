import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

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

  // Smooth target rotations — init to natural rest (arms down)
  // VRM normalized, no model Y-rotation: left Z- = down, right Z+ = down
  private headTargetX = 0;
  private headTargetY = 0;
  private headTargetZ = 0;
  private spineTargetX = 0;
  private chestTargetX = 0;
  private lUpperTargetX = 0; private lUpperTargetZ = -1.2;
  private rUpperTargetX = 0; private rUpperTargetZ = 1.2;
  private lLowerTargetX = -0.2;
  private rLowerTargetX = -0.2;

  // Phases
  private swayPhase = Math.random() * Math.PI * 2;
  private typingPhase = 0;
  private fingerPhase = 0;
  private speakPhase = 0;

  constructor(vrm: VRM) {
    this.vrm = vrm;
    console.log('[animator] Procedural animator ready');

    // Log default bone rotations so we know where T-pose actually is
    setTimeout(() => {
      const bones = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
      for (const name of bones) {
        const node = vrm.humanoid?.getNormalizedBoneNode(name as any);
        if (node) {
          const r = node.rotation;
          console.log(`[bone-default] ${name}: x=${r.x.toFixed(3)} y=${r.y.toFixed(3)} z=${r.z.toFixed(3)}`);
        }
      }
    }, 2000);

    // Debug: [ and ] to nudge leftUpperArm Z, log current value
    window.addEventListener('keydown', (e) => {
      if (e.key === '[' || e.key === ']') {
        const delta = e.key === '[' ? -0.1 : 0.1;
        this.lUpperTargetZ += delta;
        this.rUpperTargetZ -= delta;
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

  update(dt: number): void {
    this.time += dt;
    this.swayPhase += dt * 0.5;

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
        // Arms hanging at sides. No model Y-rotation: left Z- = down, right Z+ = down
        this.headTargetX = Math.sin(s * 0.7) * 0.04;
        this.headTargetY = Math.sin(s * 0.3) * 0.08;
        this.headTargetZ = Math.sin(s * 0.4) * 0.02;
        this.spineTargetX = Math.sin(s * 0.6) * 0.02;
        this.chestTargetX = Math.sin(s * 0.5) * 0.03;
        this.lUpperTargetX = -0.1 + Math.sin(s * 0.4) * 0.03;
        this.lUpperTargetZ = -1.2 + Math.sin(s * 0.3) * 0.05;
        this.rUpperTargetX = -0.1 + Math.sin(s * 0.4 + 0.5) * 0.03;
        this.rUpperTargetZ = 1.2 + Math.sin(s * 0.3) * 0.05;
        this.lLowerTargetX = -0.3;
        this.rLowerTargetX = -0.3;
        break;
      }
      case 'thinking': {
        // Right arm raised to chin, left arm at side
        this.headTargetX = 0.06;
        this.headTargetY = Math.sin(s * 0.25) * 0.15;
        this.headTargetZ = 0.08;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = -0.1;
        this.lUpperTargetZ = -0.8;
        this.rUpperTargetX = -0.8;
        this.rUpperTargetZ = 0.4;
        this.lLowerTargetX = -0.3;
        this.rLowerTargetX = -1.2;
        break;
      }
      case 'typing': {
        this.typingPhase += dt * 14;
        this.fingerPhase += dt * 18;
        this.headTargetX = 0.07 + Math.sin(this.typingPhase * 0.5) * 0.03;
        this.headTargetY = Math.sin(t * 0.5) * 0.05;
        this.headTargetZ = 0;
        this.spineTargetX = 0.06;
        this.chestTargetX = 0.04;
        // Arms angled forward/down for keyboard
        this.lUpperTargetX = -0.5 + Math.sin(this.typingPhase) * 0.06;
        this.lUpperTargetZ = -0.7;
        this.rUpperTargetX = -0.5 + Math.sin(this.typingPhase + Math.PI) * 0.06;
        this.rUpperTargetZ = 0.7;
        this.lLowerTargetX = -1.0 + Math.sin(this.typingPhase) * 0.08;
        this.rLowerTargetX = -1.0 + Math.sin(this.typingPhase + Math.PI) * 0.08;
        break;
      }
      case 'speaking': {
        this.speakPhase += dt * 2.2;
        this.headTargetX = Math.sin(this.speakPhase * 0.6) * 0.1;
        this.headTargetY = Math.sin(this.speakPhase * 0.4) * 0.15;
        this.headTargetZ = Math.sin(this.speakPhase * 0.3) * 0.05;
        this.spineTargetX = Math.sin(this.speakPhase * 0.5) * 0.04;
        this.chestTargetX = 0.02;
        // Expressive gestures
        this.lUpperTargetX = -0.3 + Math.sin(this.speakPhase * 0.7) * 0.15;
        this.lUpperTargetZ = -0.7 - Math.sin(this.speakPhase * 0.5) * 0.2;
        this.rUpperTargetX = -0.3 + Math.sin(this.speakPhase * 0.7 + 0.8) * 0.15;
        this.rUpperTargetZ = 0.7 + Math.sin(this.speakPhase * 0.5 + 0.8) * 0.2;
        this.lLowerTargetX = -0.6 + Math.sin(this.speakPhase) * 0.2;
        this.rLowerTargetX = -0.6 + Math.sin(this.speakPhase + Math.PI) * 0.2;
        break;
      }
      case 'executing': {
        this.headTargetX = 0;
        this.headTargetY = Math.sin(s * 0.8) * 0.3;
        this.headTargetZ = 0;
        this.spineTargetX = 0.02;
        this.chestTargetX = 0;
        this.lUpperTargetX = -0.2;
        this.lUpperTargetZ = -0.9;
        this.rUpperTargetX = -0.2;
        this.rUpperTargetZ = 0.9;
        this.lLowerTargetX = -0.4;
        this.rLowerTargetX = -0.4;
        break;
      }
    }
  }

  private applyBones(): void {
    const b = (name: string) => {
      const node = this.vrm.humanoid?.getNormalizedBoneNode(name as any);
      return node ?? null;
    };

    const lerp = (current: number, target: number, alpha: number) =>
      current + (target - current) * alpha;

    const speed = 0.08;

    const head = b('head');
    if (head) {
      head.rotation.x = lerp(head.rotation.x, this.headTargetX, speed);
      head.rotation.y = lerp(head.rotation.y, this.headTargetY, speed);
      head.rotation.z = lerp(head.rotation.z, this.headTargetZ, speed);
    }

    const spine = b('spine');
    if (spine) spine.rotation.x = lerp(spine.rotation.x, this.spineTargetX, speed * 0.5);

    const chest = b('chest');
    if (chest) chest.rotation.x = lerp(chest.rotation.x, this.chestTargetX, speed * 0.5);

    const lu = b('leftUpperArm');
    if (lu) {
      lu.rotation.x = lerp(lu.rotation.x, this.lUpperTargetX, speed);
      lu.rotation.z = lerp(lu.rotation.z, this.lUpperTargetZ, speed);
    }
    const ru = b('rightUpperArm');
    if (ru) {
      ru.rotation.x = lerp(ru.rotation.x, this.rUpperTargetX, speed);
      ru.rotation.z = lerp(ru.rotation.z, this.rUpperTargetZ, speed);
    }
    const ll = b('leftLowerArm');
    if (ll) ll.rotation.x = lerp(ll.rotation.x, this.lLowerTargetX, speed);
    const rl = b('rightLowerArm');
    if (rl) rl.rotation.x = lerp(rl.rotation.x, this.rLowerTargetX, speed);
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
    switch (this.state) {
      case 'idle':
        safe(this.vrm, 'relaxed', 0.15 + Math.sin(t * 0.3) * 0.05);
        safe(this.vrm, 'happy', 0.05);
        safe(this.vrm, 'angry', 0);
        safe(this.vrm, 'sad', 0);
        break;
      case 'thinking':
        safe(this.vrm, 'relaxed', 0.4);
        safe(this.vrm, 'happy', 0);
        safe(this.vrm, 'neutral', 0.1);
        break;
      case 'typing':
        safe(this.vrm, 'happy', 0.15 + Math.sin(t * 2.5) * 0.08);
        safe(this.vrm, 'relaxed', 0);
        break;
      case 'speaking':
        safe(this.vrm, 'happy', 0.25 + Math.sin(t * 1.2) * 0.1);
        safe(this.vrm, 'relaxed', 0);
        break;
      case 'executing':
        safe(this.vrm, 'relaxed', 0.05);
        safe(this.vrm, 'happy', 0.05);
        break;
    }
  }
}
