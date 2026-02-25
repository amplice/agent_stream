import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM, VRMUtils } from '@pixiv/three-vrm';

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);
export const renderer = new THREE.WebGLRenderer({ antialias: true });

let vrm: VRM | null = null;
let fallbackSphere: THREE.Mesh | null = null;

function initRenderer(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a0a0f);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  if (canvas) {
    canvas.replaceWith(renderer.domElement);
    renderer.domElement.id = 'canvas';
  } else {
    document.body.appendChild(renderer.domElement);
  }
}

function initLighting(): void {
  scene.add(new THREE.AmbientLight(0x110022, 0.2));

  const keyLight = new THREE.DirectionalLight(0x8866ff, 0.8);
  keyLight.position.set(1, 2, 2);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x2200aa, 0.3);
  fillLight.position.set(-1, 1, 0);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0x4400ff, 0.5);
  rimLight.position.set(0, 1, -2);
  scene.add(rimLight);
}

function initCamera(): void {
  // VRM faces -Z, so camera goes in -Z to look at the front
  camera.position.set(0, 1.35, -1.8);
  camera.lookAt(0, 1.3, 0);
}

function showFallback(): void {
  const geo = new THREE.SphereGeometry(0.3, 32, 32);
  const mat = new THREE.MeshStandardMaterial({ emissive: 0x6633cc, emissiveIntensity: 0.8 });
  fallbackSphere = new THREE.Mesh(geo, mat);
  fallbackSphere.position.set(0, 1.2, 0);
  scene.add(fallbackSphere);
}

export async function loadAvatar(url: string): Promise<VRM | null> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  try {
    const gltf = await loader.loadAsync(url);
    vrm = gltf.userData.vrm as VRM;
    if (!vrm) throw new Error('No VRM in file');
    VRMUtils.removeUnnecessaryJoints(vrm.scene);
    // Do NOT rotate — VRM faces -Z by default, camera looks at +Z toward it
    scene.add(vrm.scene);
    console.log('[scene] VRM loaded:', url);

    // Dump bone names so we can fix the animator
    if (vrm.humanoid) {
      const bones: string[] = [];
      (Object.keys(vrm.humanoid.humanBones) as string[]).forEach(k => {
        if (vrm!.humanoid.getNormalizedBoneNode(k as any)) bones.push(k);
      });
      console.log('[scene] bones:', bones.join(', '));
      (window as any)._noxVRM = vrm;
    }

    return vrm;
  } catch (e) {
    console.warn('[scene] VRM load failed, using fallback sphere:', e);
    showFallback();
    return null;
  }
}

export function getVRM(): VRM | null { return vrm; }

export function updateVRM(dt: number): void {
  if (vrm) vrm.update(dt);
}

export function init(): void {
  initRenderer();
  initLighting();
  initCamera();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
