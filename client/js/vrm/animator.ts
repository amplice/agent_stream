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
  // Y axis = arm swing. Left Y- = down/forward, Right Y+ = down/forward
  private lUpperTargetX = 0; private lUpperTargetY = -1.4; private lUpperTargetZ = 0;
  private rUpperTargetX = 0; private rUpperTargetY = 1.4; private rUpperTargetZ = 0;
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
    console.log('[animator] BUILD: v10 — Y axis confirmed for arm swing, all states fixed');
    console.log('[animator] Procedural animator ready');

    // Test mode: cycle through axes
    this.testAxis = new THREE.Vector3(0, 1, 0); // default Y
    this.testAngle = 1.57;
    window.addEventListener('keydown', (e) => {
      const axes: [string, THREE.Vector3][] = [
        ['+X', new THREE.Vector3(1,0,0)],
        ['-X', new THREE.Vector3(-1,0,0)],
        ['+Y', new THREE.Vector3(0,1,0)],
        ['-Y', new THREE.Vector3(0,-1,0)],
        ['+Z', new THREE.Vector3(0,0,1)],
        ['-Z', new THREE.Vector3(0,0,-1)],
      ];
      if (e.key >= '1' && e.key <= '6') {
        const idx = parseInt(e.key) - 1;
        this.testAxis = axes[idx][1];
        console.log(`[test] axis=${axes[idx][0]} angle=${this.testAngle.toFixed(2)}`);
      }
      if (e.key === '[') { this.testAngle -= 0.2; console.log(`[test] angle=${this.testAngle.toFixed(2)}`); }
      if (e.key === ']') { this.testAngle += 0.2; console.log(`[test] angle=${this.testAngle.toFixed(2)}`); }
    });

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
  private testAxis = new THREE.Vector3(0, 1, 0);
  private testAngle = 1.57;

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
        // Arms relaxed at sides with subtle breathing sway
        this.headTargetX = Math.sin(s * 0.7) * 0.04;
        this.headTargetY = Math.sin(s * 0.3) * 0.08;
        this.headTargetZ = Math.sin(s * 0.4) * 0.02;
        this.spineTargetX = Math.sin(s * 0.6) * 0.02;
        this.chestTargetX = Math.sin(s * 0.5) * 0.03;
        this.lUpperTargetX = 0;
        this.lUpperTargetY = -1.4 + Math.sin(s * 0.3) * 0.03;
        this.lUpperTargetZ = 0;
        this.rUpperTargetX = 0;
        this.rUpperTargetY = 1.4 - Math.sin(s * 0.3) * 0.03;
        this.rUpperTargetZ = 0;
        this.lLowerTargetX = -0.3;
        this.rLowerTargetX = -0.3;
        break;
      }
      case 'thinking': {
        // Right hand raised toward chin, left arm relaxed at side
        this.headTargetX = 0.08;
        this.headTargetY = Math.sin(s * 0.25) * 0.12;
        this.headTargetZ = 0.06;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = 0;
        this.lUpperTargetY = -1.3;
        this.lUpperTargetZ = 0;
        this.rUpperTargetX = -0.5;
        this.rUpperTargetY = 0.5;
        this.rUpperTargetZ = 0;
        this.lLowerTargetX = -0.3;
        this.rLowerTargetX = -1.4;  // elbow bent
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
        this.lUpperTargetX = -0.5 + Math.sin(this.typingPhase) * 0.05;
        this.lUpperTargetY = -0.8;
        this.lUpperTargetZ = 0;
        this.rUpperTargetX = -0.5 + Math.sin(this.typingPhase + Math.PI) * 0.05;
        this.rUpperTargetY = 0.8;
        this.rUpperTargetZ = 0;
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
        // Subtle gestures while talking — arms mostly at sides
        this.lUpperTargetX = Math.sin(this.speakPhase * 0.7) * 0.08;
        this.lUpperTargetY = -1.3 + Math.sin(this.speakPhase * 0.5) * 0.1;
        this.lUpperTargetZ = 0;
        this.rUpperTargetX = Math.sin(this.speakPhase * 0.7 + 0.8) * 0.08;
        this.rUpperTargetY = 1.3 - Math.sin(this.speakPhase * 0.5 + 0.8) * 0.1;
        this.rUpperTargetZ = 0;
        this.lLowerTargetX = -0.4 + Math.sin(this.speakPhase) * 0.1;
        this.rLowerTargetX = -0.4 + Math.sin(this.speakPhase + Math.PI) * 0.1;
        break;
      }
      case 'executing': {
        // Focused — arms partially forward
        this.headTargetX = 0.06;
        this.headTargetY = Math.sin(s * 0.8) * 0.15;
        this.headTargetZ = 0;
        this.spineTargetX = 0.04;
        this.chestTargetX = 0.02;
        this.lUpperTargetX = -0.4;
        this.lUpperTargetY = -0.9;
        this.lUpperTargetZ = 0;
        this.rUpperTargetX = -0.4;
        this.rUpperTargetY = 0.9;
        this.rUpperTargetZ = 0;
        this.lLowerTargetX = -0.8;
        this.rLowerTargetX = -0.8;
        break;
      }
    }
  }

  // Quaternion for target arm pose — cached for slerp
  private luCurrent = new THREE.Quaternion();
  private ruCurrent = new THREE.Quaternion();

  private applyBones(): void {
    // Use setNormalizedPose for head/spine/chest
    const hx = this.headTargetX + this.reactionHeadOffset.x;
    const hy = this.headTargetY + this.reactionHeadOffset.y;
    const hz = this.headTargetZ + this.reactionHeadOffset.z;

    _q.setFromEuler(new THREE.Euler(hx, hy, hz));
    const headQ: [number, number, number, number] = [_q.x, _q.y, _q.z, _q.w];

    _q.setFromEuler(new THREE.Euler(this.spineTargetX, 0, 0));
    const spineQ: [number, number, number, number] = [_q.x, _q.y, _q.z, _q.w];

    _q.setFromEuler(new THREE.Euler(this.chestTargetX, 0, 0));
    const chestQ: [number, number, number, number] = [_q.x, _q.y, _q.z, _q.w];

    // Arms: Z = roll/twist, so use WORLD-SPACE rotation for arm swing
    // VRM normalized leftUpperArm in T-pose: bone axis = -X (toward left hand)
    // To swing arm DOWN from T-pose: rotate around +Z world axis
    // But normalized bone local Z IS the bone axis (twist). 
    // The CORRECT way: set the arm target as a world-space rotation.
    // For arms down: leftUpperArm needs its local Y pointing down.
    // In T-pose, local Y points forward (+Z world? or +Y world?)
    // Let's just try using setNormalizedPose with known good quaternions.
    
    // Arms down from T-pose = rotate 90° around the bone-local X axis 
    // (X = perpendicular to arm in the "swing forward/back" plane)
    // But this moved arms forward in our test. So the "down" direction 
    // might be -Y local. Let's use setNormalizedPose and try all axes.
    
    // Build arm quaternion: Y = swing down/up, X = forward/back, Z = twist
    const luTarget = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(this.lUpperTargetX, this.lUpperTargetY, this.lUpperTargetZ, 'YXZ'));
    const ruTarget = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(this.rUpperTargetX, this.rUpperTargetY, this.rUpperTargetZ, 'YXZ'));
    
    this.luCurrent.slerp(luTarget, 0.1);
    this.ruCurrent.slerp(ruTarget, 0.1);

    _q.setFromAxisAngle(_axis.set(1, 0, 0), this.lLowerTargetX);
    const llQ: [number, number, number, number] = [_q.x, _q.y, _q.z, _q.w];

    _q.setFromAxisAngle(_axis.set(1, 0, 0), this.rLowerTargetX);
    const rlQ: [number, number, number, number] = [_q.x, _q.y, _q.z, _q.w];

    this.vrm.humanoid.setNormalizedPose({
      head: { rotation: headQ },
      spine: { rotation: spineQ },
      chest: { rotation: chestQ },
      leftUpperArm: { rotation: [this.luCurrent.x, this.luCurrent.y, this.luCurrent.z, this.luCurrent.w] },
      rightUpperArm: { rotation: [this.ruCurrent.x, this.ruCurrent.y, this.ruCurrent.z, this.ruCurrent.w] },
      leftLowerArm: { rotation: llQ },
      rightLowerArm: { rotation: rlQ },
    });
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
