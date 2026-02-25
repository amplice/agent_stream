// Run this in browser console to see actual bone names
import { getVRM } from './scene';
const vrm = getVRM();
if (vrm?.humanoid) {
  const bones = Object.values(vrm.humanoid.humanBones);
  console.log('Available bones:');
  Object.keys(vrm.humanoid.humanBones).forEach(k => {
    const node = vrm.humanoid.getNormalizedBoneNode(k as any);
    if (node) console.log(` ${k}: ${node.name}`);
  });
}
