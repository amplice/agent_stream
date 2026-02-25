import * as THREE from 'three';

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  baseY: number;
  offset: number;
  color: THREE.Color;
}

export class ParticleSystem {
  private scene: THREE.Scene;
  private particles: Particle[] = [];
  private points: THREE.Points;
  private positions: Float32Array;
  private colors: Float32Array;
  private mode: 'ambient' | 'thinking' | 'money' = 'ambient';
  private time = 0;
  private moneyStartedAt = 0;

  private readonly count = 300;
  private readonly spawnRadius = 2.5;
  private readonly spawnHeight = 3;
  private readonly center = new THREE.Vector3(0, 1.2, 0);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.positions = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);

    this.initParticles();
    this.createPoints();

    scene.add(this.points);
  }

  private initParticles(): void {
    const colorA = new THREE.Color('#220044');
    const colorB = new THREE.Color('#8866ff');

    for (let i = 0; i < this.count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * this.spawnRadius;
      const y = Math.random() * this.spawnHeight - 1;

      const position = new THREE.Vector3(
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius
      );

      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.02,
        0.005 + Math.random() * 0.01,
        (Math.random() - 0.5) * 0.02
      );

      const t = Math.random();
      const color = colorA.clone().lerp(colorB, t);

      this.particles.push({
        position,
        velocity,
        baseY: position.y,
        offset: Math.random() * Math.PI * 2,
        color
      });

      this.positions[i * 3] = position.x;
      this.positions[i * 3 + 1] = position.y;
      this.positions[i * 3 + 2] = position.z;

      this.colors[i * 3] = color.r;
      this.colors[i * 3 + 1] = color.g;
      this.colors[i * 3 + 2] = color.b;
    }
  }

  private createPoints(): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.015,
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.points = new THREE.Points(geometry, material);
  }

  setMode(mode: 'ambient' | 'thinking' | 'money'): void {
    this.mode = mode;
    if (mode === 'money') {
      this.moneyStartedAt = this.time;
    }
  }

  update(dt: number): void {
    this.time += dt;

    for (let i = 0; i < this.count; i++) {
      const p = this.particles[i];

      if (this.mode === 'thinking') {
        const toCenter = this.center.clone().sub(p.position);
        const dist = toCenter.length();
        toCenter.normalize();

        const pullStrength = 0.3 / (dist + 0.5);
        p.velocity.add(toCenter.multiplyScalar(pullStrength * dt));
        p.velocity.multiplyScalar(0.98);

        const swirl = new THREE.Vector3(
          -p.position.z,
          0,
          p.position.x
        ).normalize().multiplyScalar(0.5 * dt);
        p.velocity.add(swirl);
      } else if (this.mode === 'money') {
        // Burst outward from center radially
        const angle = (i / this.count) * Math.PI * 2;
        const speed = 0.5 * dt;
        p.velocity.set(
          Math.cos(angle) * speed,
          speed * 0.3,
          Math.sin(angle) * speed
        );
        // Reset if too far
        if (p.position.distanceTo(this.center) > 3) {
          p.position.copy(this.center);
          p.velocity.set(0, 0, 0);
        }
      } else {
        p.velocity.y = 0.005 + Math.sin(this.time * 0.5 + p.offset) * 0.003;
        p.velocity.x += (Math.random() - 0.5) * 0.001;
        p.velocity.z += (Math.random() - 0.5) * 0.001;
        p.velocity.multiplyScalar(0.99);
      }

      p.position.add(p.velocity);

      if (p.position.y > this.spawnHeight) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * this.spawnRadius;
        p.position.set(
          Math.cos(angle) * radius,
          -1,
          Math.sin(angle) * radius
        );
        p.velocity.set(
          (Math.random() - 0.5) * 0.02,
          0.005 + Math.random() * 0.01,
          (Math.random() - 0.5) * 0.02
        );
      }

      if (this.mode === 'thinking' && p.position.distanceTo(this.center) < 0.4) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 1.5 + Math.random() * 1;
        p.position.set(
          Math.cos(angle) * radius,
          Math.random() * 2 - 0.5,
          Math.sin(angle) * radius
        );
      }

      this.positions[i * 3] = p.position.x;
      this.positions[i * 3 + 1] = p.position.y;
      this.positions[i * 3 + 2] = p.position.z;

      // Update colors for money mode (gold)
      if (this.mode === 'money') {
        this.colors[i * 3] = 1.0;
        this.colors[i * 3 + 1] = 0.67;
        this.colors[i * 3 + 2] = 0.0;
      } else {
        this.colors[i * 3] = p.color.r;
        this.colors[i * 3 + 1] = p.color.g;
        this.colors[i * 3 + 2] = p.color.b;
      }

      const opacity = 0.3 + Math.sin(this.time * 2 + p.offset) * 0.15;
      (this.points.material as THREE.PointsMaterial).opacity = opacity;
    }

    // Auto-return to ambient after 3 seconds in money mode
    if (this.mode === 'money' && this.time - this.moneyStartedAt > 3) {
      this.setMode('ambient');
    }

    const posAttr = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;

    const colAttr = this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    colAttr.needsUpdate = true;
  }
}