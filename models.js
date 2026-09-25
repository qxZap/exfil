// Loads the glTF models in assets/models (see assets/models/CREDITS.md) and turns them into
// things the renderer can use: instanced "baked" meshes for cars/trees/props, and live clones
// (with spinning rotors) for drones and helicopters.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FILES = {
  drone: 'drone/drone.glb', heli: 'helicopter/helicopter.glb',
  sedan: 'vehicles/sedan.glb', suv: 'vehicles/suv.glb', van: 'vehicles/van.glb', truck: 'vehicles/truck.glb',
  police: 'vehicles/police.glb', taxi: 'vehicles/taxi.glb', delivery: 'vehicles/delivery.glb',
  treeDefault: 'trees/tree_default.glb', treeOak: 'trees/tree_oak.glb', treePine: 'trees/tree_pineTallA.glb', treeCone: 'trees/tree_cone.glb',
  streetLight: 'props/roads/light-curved.glb', waterTower: 'props/rooftop/water-tower.glb',
};

// prep(material) lets the caller hook every material (shadow cascades etc.)
export async function loadModels(prep) {
  const loader = new GLTFLoader(), out = {};
  await Promise.all(Object.entries(FILES).map(async ([k, f]) => {
    const g = await loader.loadAsync(`./assets/models/${f}`);
    g.scene.traverse(o => { if (o.isMesh) { o.material = prep(o.material); o.castShadow = o.receiveShadow = true; } });
    out[k] = g.scene;
  }));
  return out;
}

// Merge every mesh of a model into one geometry (one group per material), normalised so it
// stands on y = 0, centred in x/z, and is `size` tall (or long, with {length}).
export function bake(root, { height, length } = {}) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  root.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });
  const materials = [...byMat.keys()];
  const geometry = mergeGeometries(materials.map(m => mergeGeometries(byMat.get(m))), true);
  geometry.computeBoundingBox();
  const b = geometry.boundingBox, size = b.getSize(new THREE.Vector3());
  const s = height ? height / size.y : length ? length / size.z : 1;
  geometry.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2).scale(s, s, s);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, materials };
}

// a direction in the model's xz-plane pointing from its base toward its upper parts (e.g. the
// arm of a street light), so it can be turned to face the road
export function topLean(geometry) {
  const p = geometry.attributes.position, top = geometry.boundingBox.max.y * 0.8;
  let x = 0, z = 0, n = 0;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > top) { x += p.getX(i); z += p.getZ(i); n++; }
  return Math.atan2(x / n, z / n);
}

export function instanced(baked, count) {
  const m = new THREE.InstancedMesh(baked.geometry, baked.materials.length === 1 ? baked.materials[0] : baked.materials, count);
  m.castShadow = m.receiveShadow = true;
  m.frustumCulled = false; // instances cover the whole city
  return m;
}

// live clone of a model with its moving parts found by name; `tint` multiplies every material
export function liveClone(root, { length, tint, rotors = [] } = {}) {
  const g = root.clone(true);
  if (tint) g.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.multiply(new THREE.Color(tint)); } });
  const box = new THREE.Box3().setFromObject(g), size = box.getSize(new THREE.Vector3());
  const s = length / size.z;
  const wrap = new THREE.Group();
  g.position.set(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -(box.min.z + box.max.z) / 2);
  const inner = new THREE.Group(); inner.add(g); inner.scale.setScalar(s); wrap.add(inner);
  wrap.userData.rotors = rotors.map(n => g.getObjectByName(n));
  wrap.userData.size = size.multiplyScalar(s);
  return wrap;
}
