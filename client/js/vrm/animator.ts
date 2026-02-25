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

  // Smooth target rotations — VRoid normalized space
  // T-pose = arms horizontal (identity). Arms down = rotate X forward (~+1.4 rad)
  private headTargetX = 0;
  private headTargetY = 0;
  private headTargetZ = 0;
  private spineTargetX = 0;
  private chestTargetX = 0;
  // Testing axis direction — rest was lZ=-0.860 rZ=+0.889
  // -1.4 = arms UP. Try opposite direction.
  private lUpperTargetX = 0; private lUpperTargetZ = 0.5;
  private rUpperTargetX = 0; private rUpperTargetZ = -0.5;
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
        // TEST: opposite Z direction — lZ=+0.5, rZ=-0.5
        this.headTargetX = Math.sin(s * 0.7) * 0.04;
        this.headTargetY = Math.sin(s * 0.3) * 0.08;
        this.headTargetZ = Math.sin(s * 0.4) * 0.02;
        this.spineTargetX = Math.sin(s * 0.6) * 0.02;
        this.chestTargetX = Math.sin(s * 0.5) * 0.03;
        this.lUpperTargetX = 0;
        this.lUpperTargetZ = 0.5;
        this.rUpperTargetX = 0;
        this.rUpperTargetZ = -0.5;
        this.lLowerTargetX = 0;
        this.rLowerTargetX = 0;
        break;
      }
      case 'thinking': {
        // Right hand to chin, left arm relaxed
        this.headTargetX = 0.08;
        this.headTargetY = Math.sin(s * 0.25) * 0.12;
        this.headTargetZ = 0.06;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = -0.15;
        this.lUpperTargetZ = -1.3;
        this.rUpperTargetX = -0.6;
        this.rUpperTargetZ = 0.5;
        this.lLowerTargetX = -0.5;
        this.rLowerTargetX = -1.4;
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
        this.lUpperTargetX = -0.4 + Math.sin(this.typingPhase) * 0.05;
        this.lUpperTargetZ = -0.9;
        this.rUpperTargetX = -0.4 + Math.sin(this.typingPhase + Math.PI) * 0.05;
        this.rUpperTargetZ = 0.9;
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
        // Subtle hand gestures while talking
        this.lUpperTargetX = -0.2 + Math.sin(this.speakPhase * 0.7) * 0.12;
        this.lUpperTargetZ = -1.0 + Math.sin(this.speakPhase * 0.5) * 0.15;
        this.rUpperTargetX = -0.2 + Math.sin(this.speakPhase * 0.7 + 0.8) * 0.12;
        this.rUpperTargetZ = 1.0 - Math.sin(this.speakPhase * 0.5 + 0.8) * 0.15;
        this.lLowerTargetX = -0.6 + Math.sin(this.speakPhase) * 0.15;
        this.rLowerTargetX = -0.6 + Math.sin(this.speakPhase + Math.PI) * 0.15;
        break;
      }
      case 'executing': {
        // Focused — looking at something, arms relaxed but alert
        this.headTargetX = 0.06;
        this.headTargetY = Math.sin(s * 0.8) * 0.15;
        this.headTargetZ = 0;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = -0.3;
        this.lUpperTargetZ = -1.1;
        this.rUpperTargetX = -0.3;
        this.rUpperTargetZ = 1.1;
        this.lLowerTargetX = -0.8;
        this.rLowerTargetX = -0.8;
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
      head.rotation.x = lerp(head.rotation.x, this.headTargetX + this.reactionHeadOffset.x, speed);
      head.rotation.y = lerp(head.rotation.y, this.headTargetY + this.reactionHeadOffset.y, speed);
      head.rotation.z = lerp(head.rotation.z, this.headTargetZ + this.reactionHeadOffset.z, speed);
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
