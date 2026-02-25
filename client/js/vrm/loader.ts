import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';

let _vrm: VRM | null = null;

export async function loadVRM(scene: THREE.Scene, url: string): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const vrm = gltf.userData.vrm as VRM;
        if (!vrm) { reject(new Error('No VRM in file')); return; }
        scene.add(vrm.scene);
        _vrm = vrm;
        resolve(vrm);
      },
      undefined,
      reject
    );
  });
}

export function getVRM(): VRM | null { return _vrm; }
