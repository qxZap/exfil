// EXFIL client: rendering, HUD, input. All game logic lives in sim.js.
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { loadModels, bake, instanced, liveClone, topLean } from './models.js';
import { Crowd } from './people.js';
import { Audio } from './audio.js';
import { RadioNet } from './radio.js';
import { Game, DT, RAPIER, CITY, carPose, v3, add, sub, mul, len, flat, norm, dist, fwdOf, rightOf, headingOf, AIRFRAME, ESCAPE_DIST, HELI } from './sim.js';

const $ = id => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true }); // 4 km of depth: no z-fighting
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 6000);

// ---------------------------------------------------------------- sky, sun / moon, haze
// A physical sky (Rayleigh/Mie scattering) driven by a time of day. The sun (or, at night, the
// moon) is the one shadow-casting light, so shadows are live and move with it. The sky is baked
// into an environment map for reflections whenever the light has moved enough to matter.
const sky = new Sky();
sky.scale.setScalar(20000);
sky.material.uniforms.turbidity.value = 9;
sky.material.uniforms.mieCoefficient.value = 0.012;
sky.material.uniforms.mieDirectionalG.value = 0.86;
scene.add(sky);
const hemi = new THREE.HemisphereLight(0xcfdde8, 0x5a5448, 0.55);
scene.add(hemi);
scene.fog = new THREE.FogExp2(0xb4bdc4, 0.00085);

// cascaded shadow maps: crisp shadows next to you, still shadows 900 m out. normalBias pushes the
// shadow lookup off the surface, which stops "shadow acne" (striping that flickers on the walls)
const csm = new CSM({
  maxFar: 900, cascades: 4, mode: 'practical', parent: scene, shadowMapSize: 2048,
  lightDirection: new THREE.Vector3(-0.5, -0.8, -0.3).normalize(), lightIntensity: 2.8, lightColor: new THREE.Color(0xfff0dc), lightMargin: 300, shadowBias: -0.0004, camera,
});
csm.fade = true;
for (const l of csm.lights) l.shadow.normalBias = 0.7;
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); csm.updateFrustums(); });

// the night sky: stars and a moon, carried along with the camera (they're "at infinity")
const skyDome = new THREE.Group();
const stars = (() => {
  const n = 2600, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, y = Math.random() ** 0.7;
    const r = Math.sqrt(1 - y * y);
    p.set([Math.cos(a) * r * 4500, y * 4500, Math.sin(a) * r * 4500], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
})();
const moon = new THREE.Mesh(new THREE.SphereGeometry(70, 24, 16), new THREE.MeshBasicMaterial({ color: 0xe9edf6, fog: false }));
skyDome.add(stars, moon);
scene.add(skyDome);

// 0 = full day ... 1 = full night; shaders read it to light windows and lamps
const NIGHT = { value: 0 };
const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene(), envSky = new Sky();
envSky.scale.setScalar(1000); envScene.add(envSky);
let envAt = null, envRT = null;
const SUNDIR = new THREE.Vector3(), MOONDIR = new THREE.Vector3();
function setTimeOfDay(hour) {
  const h = ((hour % 24) + 24) % 24;
  const elev = Math.sin((h - 6) / 12 * Math.PI) * THREE.MathUtils.degToRad(60); // 60° at noon, -60° at midnight
  const az = THREE.MathUtils.degToRad(100 + (h - 6) / 12 * 160);                  // rises east, sets west
  SUNDIR.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az));
  MOONDIR.set(-SUNDIR.x, Math.max(-SUNDIR.y, 0.2), -SUNDIR.z).normalize();
  const day = THREE.MathUtils.smoothstep(SUNDIR.y, -0.1, 0.12);
  NIGHT.value = 1 - day;
  sky.material.uniforms.sunPosition.value.copy(SUNDIR);
  sky.material.uniforms.rayleigh.value = 0.5 + 1.1 * day;
  // the key light: the sun by day, the moon by night; both cast shadows
  const bySun = SUNDIR.y > 0.03;
  csm.lightDirection.copy(bySun ? SUNDIR : MOONDIR).negate();
  const low = THREE.MathUtils.smoothstep(SUNDIR.y, 0.03, 0.45);                    // golden hour when low
  const I = bySun ? 2.8 * THREE.MathUtils.smoothstep(SUNDIR.y, 0.03, 0.2) : 0.5;
  const C = bySun ? new THREE.Color(0xff9a50).lerp(new THREE.Color(0xfff0dc), low) : new THREE.Color(0x8fa8ff);
  for (const l of csm.lights) { l.intensity = I; l.color.copy(C); }
  hemi.intensity = 0.12 + 0.43 * day;
  hemi.color.set(day > 0.5 ? 0xcfdde8 : 0x5d6f9a);
  const dusk = Math.max(0, 1 - Math.abs(SUNDIR.y - 0.03) / 0.15);                  // orange haze around sunrise/sunset
  scene.fog.color.set(0x0b1018).lerp(new THREE.Color(0xb4bdc4), day).lerp(new THREE.Color(0xc0987a), dusk * 0.45);
  scene.environmentIntensity = 0.06 + 0.3 * day;
  renderer.toneMappingExposure = 0.85 + 0.45 * NIGHT.value;
  stars.material.opacity = Math.max(0, NIGHT.value - 0.2) * 1.1;
  moon.position.copy(MOONDIR).multiplyScalar(4300); moon.visible = NIGHT.value > 0.05;
  if (envAt === null || Math.abs(h - envAt) > 0.2) { // re-bake reflections when the light has moved
    for (const k in sky.material.uniforms) envSky.material.uniforms[k].value = sky.material.uniforms[k].value;
    const rt = pmrem.fromScene(envScene); scene.environment = rt.texture; envRT?.dispose(); envRT = rt; envAt = h;
  }
}

// every lit material goes through here: registers it with the shadow cascades and lets a
// shader patch ride along (with its own program cache key)
let patchId = 0;
function std(params, patch) {
  const m = new THREE.MeshStandardMaterial(params);
  csm.setupMaterial(m);
  if (patch) {
    const base = m.onBeforeCompile, key = `patch${patchId++}`;
    m.onBeforeCompile = (sh, r) => { base(sh, r); patch(sh); };
    m.customProgramCacheKey = () => key;
  }
  return m;
}
const WORLD_VARYINGS = sh => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNorm;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef USE_INSTANCING\n vec4 wp4 = modelMatrix * instanceMatrix * vec4(transformed, 1.0); vWNorm = normalize(mat3(modelMatrix * instanceMatrix) * normal);\n#else\n vec4 wp4 = modelMatrix * vec4(transformed, 1.0); vWNorm = normalize(mat3(modelMatrix) * normal);\n#endif\n vWPos = wp4.xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNorm;\nfloat h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }');
};

// models (assets/models, see CREDITS.md): loaded once, baked for instancing
let MODELS = null, BAKED = null;
const CAR_TYPES = ['sedan', 'suv', 'van', 'truck', 'police', 'taxi', 'delivery'];
const CAR_LEN = { sedan: 4.5, suv: 4.7, van: 5.0, truck: 5.8, police: 4.6, taxi: 4.5, delivery: 5.6 };
async function ensureModels() {
  if (MODELS) return;
  MODELS = await loadModels(m => { csm.setupMaterial(m); return m; });
  BAKED = { streetLight: bake(MODELS.streetLight, { height: 8 }), waterTower: bake(MODELS.waterTower, { height: 5.4 }) };
  for (const k of ['treeDefault', 'treeOak', 'treePine', 'treeCone']) BAKED[k] = bake(MODELS[k], { height: 1 });
  for (const k of CAR_TYPES) BAKED[k] = bake(MODELS[k], { length: CAR_LEN[k] });
}
const crowd = new Crowd(scene, std);
const audio = new Audio();
const radioLines = [];
function radioLog(from, text, df) {
  radioLines.push({ from, text, df });
  if (radioLines.length > 5) radioLines.shift();
  $('radioLog').innerHTML = radioLines.map(l => `<div class="net"><b>${l.from}</b><i>${l.df}</i> ${l.text}</div>`).join('');
}
const radio = new RadioNet(audio, radioLog);
// volume: two sliders on the start screen (saved per browser), - / = during play
function setVolume(v, voice = audio.voiceVol) {
  audio.volume = Math.max(0, Math.min(1, v)); audio.voiceVol = Math.max(0, Math.min(1, voice));
  $('vol').value = Math.round(audio.volume * 100); $('volV').textContent = `${$('vol').value}%`;
  $('voiceVol').value = Math.round(audio.voiceVol * 100); $('voiceVolV').textContent = `${$('voiceVol').value}%`;
  try { localStorage.setItem('exfil.vol', audio.volume); localStorage.setItem('exfil.voiceVol', audio.voiceVol); } catch {}
}
{
  let v = 0.6, vv = 0.8;
  try { v = +(localStorage.getItem('exfil.vol') ?? 0.6); vv = +(localStorage.getItem('exfil.voiceVol') ?? 0.8); } catch {}
  setVolume(v, vv);
  $('vol').oninput = e => setVolume(e.target.value / 100);
  $('voiceVol').oninput = e => setVolume(audio.volume, e.target.value / 100);
}
const tmpS = new THREE.Vector3();

// ---------------------------------------------------------------- city meshes
// buildings: procedural facades laid out in each building's OWN coordinates (per-instance size and
// seed), so windows fit exactly between the corner pillars, floors start at the building's base,
// and every building keeps one consistent style: punched windows, ribbon glazing or curtain wall
function windowed(params, house = false) {
  return std(params, sh => {
    WORLD_VARYINGS(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSize; attribute float aSeed;\nvarying vec3 vLocal; varying vec3 vSize; varying float vSeed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vLocal = position * aSize; vSize = aSize; vSeed = aSeed;');
    sh.uniforms.uNight = NIGHT;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal; varying vec3 vSize; varying float vSeed;\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        const bool HOUSE = ${house};
        float grime = vnoise(vWPos.xz * 0.05 + vWPos.y * 0.03) * 0.22 + vnoise(vWPos.xy * 0.4 + vWPos.zy * 0.4) * 0.07;
        if (vWNorm.y > 0.5) {                                             // roof: gravel
          diffuseColor.rgb *= 0.55 + 0.25 * vnoise(vWPos.xz * 0.8);
          roughnessFactor = 1.0;
        } else if (abs(vWNorm.y) < 0.5) {
          bool xFace = abs(vWNorm.x) > 0.5;
          float faceW = xFace ? vSize.z : vSize.x;
          float u = (xFace ? vLocal.z : vLocal.x) + faceW * 0.5;          // metres from the face's left corner
          float v = vLocal.y + vSize.y * 0.5;                              // metres above the building's base
          float s1 = fract(vSeed * 13.13), s2 = fract(vSeed * 71.71), s3 = fract(vSeed * 5.37);
          float fh = HOUSE ? 2.9 : 3.2 + s2 * 0.8;                         // floor height
          float ground = HOUSE ? 0.35 : fh * 1.3;                          // ground floor (shops) in the city
          float pillar = HOUSE ? 0.7 : 0.9 + s2 * 0.6;                     // corner pillars
          float usable = max(faceW - 2.0 * pillar, 0.6);
          float cols = max(1.0, floor(usable / (HOUSE ? 2.8 : mix(1.8, 3.8, s1))));
          float uu = (u - pillar) / (usable / cols);
          float top = vSize.y - (HOUSE ? 0.4 : 1.3);                       // parapet above the last floor
          float floors = max(1.0, floor((top - ground) / fh));
          float vv = (v - ground) / ((top - ground) / floors);
          vec2 f = vec2(fract(uu), fract(vv));
          float inside = step(0.0, uu) * step(uu, cols) * step(0.0, vv) * step(vv, floors);
          float style = HOUSE ? 0.0 : s3;                                  // punched / ribbon / curtain wall
          float wx = style < 0.4 ? 0.2 : style < 0.72 ? 0.035 : 0.025;
          float wy0 = style < 0.72 ? 0.3 : 0.05, wy1 = style < 0.72 ? 0.84 : 0.96;
          float win = inside * step(wx, f.x) * step(f.x, 1.0 - wx) * step(wy0, f.y) * step(f.y, wy1);
          float side = xFace ? sign(vWNorm.x) : 2.0 * sign(vWNorm.z);
          vec2 cell = vec2(floor(uu), floor(vv)) + vec2(vSeed * 173.0 + side * 31.0, side * 17.0);
          float lit = step(0.85 - 0.33 * uNight, h21(cell));                 // more rooms lit at night
          float broken = step(0.985, h21(cell * 1.7 + 3.1));                // war zone: a few panes blown out
          float sill = inside * (1.0 - win) * step(wy0 - 0.06, f.y) * step(f.y, wy0) * step(wx, f.x) * step(f.x, 1.0 - wx);
          float slab = style < 0.72 ? 0.0 : inside * (1.0 - step(0.05, f.y)); // curtain wall: floor lines
          vec3 glass = mix(vec3(0.06, 0.063, 0.066), vec3(0.14, 0.145, 0.15), s2); // neutral, not icy
          diffuseColor.rgb *= 1.0 - grime;
          diffuseColor.rgb *= 1.0 - sill * 0.25 - slab * 0.35;
          float cornice = step(top, v) * (1.0 - step(top + 0.25, v));      // band under the parapet
          diffuseColor.rgb *= 1.0 - cornice * 0.35;
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.88);
          roughnessFactor = mix(roughnessFactor, broken > 0.5 ? 1.0 : 0.16, win);
          metalnessFactor = mix(metalnessFactor, broken > 0.5 ? 0.0 : 0.4, win);
          if (broken > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), win);
          totalEmissiveRadiance += win * lit * (1.0 - broken) * vec3(1.0, 0.72, 0.38) * (0.4 + 1.8 * uNight);
          if (HOUSE) {                                                     // a front door on one face
            float door = step(abs(u - faceW * 0.5), 0.55) * step(v, 2.2) * step(0.5, fract(vSeed * 3.0 + side * 0.25));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.15, 0.09), door);
          } else if (v < ground) {                                         // shopfronts: bays with glass and awnings
            float bays = max(1.0, floor(usable / 6.0)), bu = (u - pillar) / (usable / bays), bf = fract(bu);
            float shop = step(0.0, bu) * step(bu, bays) * step(0.06, bf) * step(bf, 0.94) * step(0.3, v) * step(v, ground - 0.9);
            float awning = step(0.0, bu) * step(bu, bays) * step(ground - 0.9, v) * step(v, ground - 0.55);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.08, 0.09), shop * 0.9);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.45, 0.12, 0.1), vec3(0.12, 0.3, 0.35), step(0.5, h21(vec2(floor(bu), vSeed * 9.0)))), awning);
            roughnessFactor = mix(roughnessFactor, 0.12, shop);
            metalnessFactor = mix(metalnessFactor, 0.55, shop);
            totalEmissiveRadiance += shop * vec3(0.9, 0.8, 0.6) * (0.14 + 0.9 * uNight) * step(0.45, h21(vec2(floor(bu), vSeed * 5.0 + side)));
          }
        }`);
  });
}
// ground: patchy grass, dry dirt, scorch marks
function groundMat() {
  return std({ color: 0xffffff, roughness: 1 }, sh => {
    WORLD_VARYINGS(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float n = vnoise(vWPos.xz * 0.02) * 0.6 + vnoise(vWPos.xz * 0.15) * 0.3 + vnoise(vWPos.xz * 1.3) * 0.1;
      diffuseColor.rgb = mix(vec3(0.30, 0.36, 0.22), vec3(0.42, 0.38, 0.30), smoothstep(0.35, 0.75, n));
      float scorch = smoothstep(0.82, 0.9, vnoise(vWPos.xz * 0.01 + 7.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.07, 0.06), scorch * 0.8);`);
  });
}
// asphalt / paving with wear and patches
function asphaltMat(color, factor) {
  return std({ color, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: factor, polygonOffsetUnits: factor }, sh => {
    WORLD_VARYINGS(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= 0.8 + 0.35 * vnoise(vWPos.xz * 0.25) + 0.1 * vnoise(vWPos.xz * 3.0);`);
  });
}

const cityGroup = new THREE.Group();
scene.add(cityGroup);
function buildCityMeshes(game) {
  cityGroup.clear();
  const B = game.city.buildings, m4 = new THREE.Matrix4(), col = new THREE.Color();
  const palette = { tower: [0x8b8a86, 0x75746f, 0x9c9891, 0x67665f, 0xa9a69f], block: [0x98928a, 0x86817a, 0xa59f95, 0x7a766f], warehouse: [0x7e7d78, 0x8d8981], stack: [0x6a6259], house: [0xd8cdb8, 0xc2b59b, 0xe0d6c8, 0xb8a58a, 0x9fb0b8] };
  const tall = B.filter(b => b.kind !== 'house'), houses = B.filter(b => b.kind === 'house');
  const mk = (list, mat) => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap(b => [b.hx * 2, b.hy * 2, b.hz * 2])), 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(list.map(b => b.shade * 97.13 + b.x * 0.013 + b.z * 0.007)), 1));
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((b, i) => {
      m4.makeScale(b.hx * 2, b.hy * 2, b.hz * 2).setPosition(b.x, b.y, b.z);
      im.setMatrixAt(i, m4);
      const p = palette[b.kind]; im.setColorAt(i, col.setHex(p[Math.floor(b.shade * p.length)]));
    });
    im.castShadow = im.receiveShadow = true;
    cityGroup.add(im);
  };
  mk(tall, windowed({ roughness: 0.82, metalness: 0.08 }));
  mk(houses, windowed({ roughness: 0.9 }, true));
  // roofs on houses
  const roofs = new THREE.InstancedMesh(new THREE.ConeGeometry(0.72, 1, 4, 1).rotateY(Math.PI / 4), std({ color: 0x8a4b3a, roughness: 0.9 }), houses.length);
  houses.forEach((b, i) => { m4.makeScale(b.hx * 2, 2.6, b.hz * 2).setPosition(b.x, b.y + b.hy + 1.3, b.z); roofs.setMatrixAt(i, m4); roofs.setColorAt(i, col.setHex([0x8a4b3a, 0x5b5f66, 0x6d3b2f][Math.floor(b.shade * 3)])); });
  roofs.castShadow = true; cityGroup.add(roofs);
  // trees: four kinds mixed, each scaled to its physics collider (trunk + crown)
  const T = game.city.trees, kinds = ['treeDefault', 'treeOak', 'treePine', 'treeCone'];
  kinds.forEach((k, ki) => {
    const list = T.filter((t, i) => (i * 7 + Math.floor(Math.abs(t.x))) % 4 === ki);
    const im = instanced(BAKED[k], list.length);
    list.forEach((t, i) => { const H = t.h + t.r * (k === 'treePine' || k === 'treeCone' ? 1.6 : 1.1); m4.makeRotationY((t.x * 13 + t.z * 7) % 6.28).scale(tmpS.set(H, H, H)).setPosition(t.x, 0, t.z); im.setMatrixAt(i, m4); });
    cityGroup.add(im);
  });
  // ground + roads
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000).rotateX(-Math.PI / 2), groundMat());
  ground.receiveShadow = true; cityGroup.add(ground);
  const n = Math.round(2 * CITY.half / CITY.pitch) + 1;
  const roads = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), asphaltMat(0x3b3e42, -2), n * 2);
  for (let k = 0; k < n; k++) {
    const c = -CITY.half + k * CITY.pitch;
    m4.makeScale(CITY.road, 1, CITY.half * 2 + CITY.road).setPosition(c, 0.08, 0); roads.setMatrixAt(k, m4);
    m4.makeScale(CITY.half * 2 + CITY.road, 1, CITY.road).setPosition(0, 0.12, c); roads.setMatrixAt(n + k, m4);
  }
  roads.receiveShadow = true; cityGroup.add(roads);
  // sidewalks either side of every road, dashed centre lines
  const walks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), asphaltMat(0x8b8d8f, -1), n * 4);
  for (let k = 0; k < n; k++) {
    const c = -CITY.half + k * CITY.pitch;
    for (const [j, sgn] of [[0, 1], [1, -1]]) {
      m4.makeScale(2.4, 1, CITY.half * 2).setPosition(c + sgn * (CITY.road / 2 - 1.2), 0.1, 0); walks.setMatrixAt(k * 4 + j, m4);
      m4.makeScale(CITY.half * 2, 1, 2.4).setPosition(0, 0.1, c + sgn * (CITY.road / 2 - 1.2)); walks.setMatrixAt(k * 4 + 2 + j, m4);
    }
  }
  walks.receiveShadow = true; cityGroup.add(walks);
  const dashN = n * Math.floor(CITY.half * 2 / 12) * 2;
  const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd8d2b0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), dashN);
  let di = 0;
  for (let k = 0; k < n; k++) {
    const c = -CITY.half + k * CITY.pitch;
    for (let s = -CITY.half + 6; s < CITY.half && di < dashN - 1; s += 12) {
      if (((s + CITY.half) % CITY.pitch) < 12) continue; // leave the junctions clear
      m4.makeScale(0.2, 1, 5).setPosition(c, 0.14, s); dashes.setMatrixAt(di++, m4);
      m4.makeScale(5, 1, 0.2).setPosition(s, 0.14, c); dashes.setMatrixAt(di++, m4);
    }
  }
  dashes.count = di; cityGroup.add(dashes);
  // rooftop clutter (same colliders as the physics): AC units, water tanks on legs, masts with red lights
  const P = game.city.props, byType = t => P.filter(p => p.type === t);
  const ac = byType('ac'), tanks = byType('tank'), masts = byType('mast');
  const acM = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1.4, 1.6), std({ color: 0xb9bcbf, roughness: 0.6, metalness: 0.4 }), ac.length);
  ac.forEach((p, i) => { m4.makeRotationY((i % 4) * Math.PI / 2).setPosition(p.x, p.y, p.z); acM.setMatrixAt(i, m4); });
  const tankM = instanced(BAKED.waterTower, tanks.length);
  tanks.forEach((p, i) => { m4.makeRotationY(i * 1.3).setPosition(p.x, p.y - 3.2, p.z); tankM.setMatrixAt(i, m4); });
  const mastM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.2, 1, 6), std({ color: 0x9a9da0, metalness: 0.6 }), masts.length);
  const beacon = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 }), masts.length);
  masts.forEach((p, i) => { m4.makeScale(1, p.h, 1).setPosition(p.x, p.y, p.z); mastM.setMatrixAt(i, m4); m4.makeTranslation(p.x, p.y + p.h / 2, p.z); beacon.setMatrixAt(i, m4); });
  for (const m of [acM, mastM]) m.castShadow = m.receiveShadow = true;
  cityGroup.add(acM, tankM, mastM, beacon);
  cityGroup.userData.beacon = beacon;
  // street lights: pole, arm over the road, lamp head
  const L = game.city.lights;
  const lamps = instanced(BAKED.streetLight, L.length), lean0 = topLean(BAKED.streetLight.geometry);
  L.forEach((l, i) => {
    const dx = l.axis === 'x' ? 0 : -l.side, dz = l.axis === 'x' ? -l.side : 0; // arm points over the road
    m4.makeRotationY(Math.atan2(dx, dz) - lean0).setPosition(l.x, 0, l.z); lamps.setMatrixAt(i, m4);
  });
  cityGroup.add(lamps);
  { // where the lamp head is: the far end of the arm
    const g = BAKED.streetLight.geometry, pos = g.attributes.position, top = g.boundingBox.max.y * 0.8;
    let reach = 0; for (let i = 0; i < pos.count; i++) if (pos.getY(i) > top) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
    const heads = new Float32Array(L.length * 3), pools = new THREE.InstancedMesh(new THREE.CircleGeometry(7, 20).rotateX(-Math.PI / 2), poolMat, L.length);
    L.forEach((l, i) => {
      const dx = l.axis === 'x' ? 0 : -l.side, dz = l.axis === 'x' ? -l.side : 0, hx = l.x + dx * reach * 0.9, hz = l.z + dz * reach * 0.9;
      heads.set([hx, 7.7, hz], i * 3);
      m4.makeTranslation(hx, 0.2, hz); pools.setMatrixAt(i, m4);
    });
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.BufferAttribute(heads, 3));
    const glow = new THREE.Points(hg, lampGlowMat);
    pools.frustumCulled = glow.frustumCulled = false;
    cityGroup.add(pools, glow);
    cityGroup.userData.night = [pools, glow];
  }
  // the server on the roof
  const s = game.server;
  const rack = new THREE.Mesh(new THREE.BoxGeometry(1, 1.8, 0.7), std({ color: 0x1d2228, metalness: 0.6, roughness: 0.4 }));
  rack.position.set(s.x, s.y, s.z); cityGroup.add(rack);
  for (let k = 0; k < 6; k++) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: k % 2 ? 0x46e08a : 0x3aa0ff }));
    led.position.set(s.x - 0.3 + k * 0.1, s.y + 0.5, s.z + 0.36); cityGroup.add(led);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 6), std({ color: 0x888888 }));
  mast.position.set(s.x + 1, s.y + 2.5, s.z); cityGroup.add(mast);
  // fires: glowing roof + a smoke column (sprites rising)
  smokes.length = 0;
  for (const f of game.city.fires) {
    const glow = new THREE.PointLight(0xff7a2a, 40, 60, 2); glow.position.set(f.x, f.y + 2, f.z); cityGroup.add(glow);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(4, 7, 7), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.8 }));
    flame.position.set(f.x, f.y + 3, f.z); cityGroup.add(flame);
    for (let k = 0; k < 18; k++) {
      const sp = new THREE.Sprite(smokeMat.clone()); sp.userData = { f, k }; cityGroup.add(sp); smokes.push(sp);
    }
  }
}
const smokeTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(60,58,56,0.9)'); g.addColorStop(1, 'rgba(60,58,56,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const smokeMat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, fog: true });
const smokes = [];
// night lighting sprites: a soft radial blob, reused for lamp heads, light pools and headlights
const blobTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const lampGlowMat = new THREE.PointsMaterial({ map: blobTex, color: 0xffd9a0, size: 3.2, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
const poolMat = new THREE.MeshBasicMaterial({ map: blobTex, color: 0xffc98a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4dc }), tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });

// cars: one instanced mesh per model (sedan, SUV, van, truck, police, taxi, delivery)
let carSets = [];
// mostly sedans and SUVs, some vans/trucks/delivery, a few taxis, the odd police car
const CAR_W = [0.3, 0.2, 0.12, 0.1, 0.05, 0.1, 0.13];
function carType(i) { let u = ((i * 2654435761) >>> 0) / 4294967296; for (let k = 0; k < CAR_W.length; k++) { if ((u -= CAR_W[k]) < 0) return k; } return 0; }
const CAR_NEAR = 320, CAR_FAR = 1400, NEAR_CAP = 1600;
let farCars = null, carTypeOf = [], headL = null, tailL = null;
function buildCars(game) {
  for (const c of carSets) scene.remove(c.mesh);
  for (const m of [farCars, headL, tailL]) if (m) scene.remove(m);
  carTypeOf = game.cars.map((c, i) => carType(i));
  carSets = CAR_TYPES.map(k => { const mesh = instanced(BAKED[k], NEAR_CAP); mesh.count = 0; scene.add(mesh); return { mesh, len: CAR_LEN[k] }; });
  // every car also has a box in the far field (hidden while it's close); colours fixed per car
  farCars = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 1.5, 4.5).translate(0, 0.75, 0), std({ roughness: 0.55, metalness: 0.35 }), game.cars.length);
  farCars.frustumCulled = false;
  const col = new THREE.Color();
  game.cars.forEach((c, i) => farCars.setColorAt(i, col.setHSL(c.color, 0.25, 0.3 + (c.color * 7 % 1) * 0.35)));
  headL = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 0.3), headMat, NEAR_CAP * 2);
  tailL = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 0.25), tailMat, NEAR_CAP * 2);
  for (const m of [headL, tailL]) { m.frustumCulled = false; m.count = 0; }
  scene.add(farCars, headL, tailL);
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0), tmpL = new THREE.Matrix4();
let carFrame = 0;
function updateCars(game, t) {
  // no allocations in here: it runs over ~14,000 cars every frame
  const cx = camera.position.x, cz = camera.position.z, lights = NIGHT.value > 0.25, part = carFrame++ % 3;
  const near2 = CAR_NEAR * CAR_NEAR, far2 = CAR_FAR * CAR_FAR, cars = game.cars;
  for (const set of carSets) set.mesh.count = 0;
  let nl = 0;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    const along = ((c.phase + c.speed * t) % 4000 + 4000) % 4000 - 2000, sAl = along * c.dir, lane = 3.5 * c.dir;
    const x = c.axis === 'x' ? sAl : c.line - lane, z = c.axis === 'x' ? c.line + lane : sAl;
    const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    const set = carSets[carTypeOf[i]];
    if (d2 < near2 && set.mesh.count < NEAR_CAP) {
      const h = c.axis === 'x' ? (c.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (c.dir > 0 ? 0 : Math.PI);
      tmpM.makeRotationY(h).setPosition(x, 0.05, z);
      set.mesh.setMatrixAt(set.mesh.count++, tmpM);
      farCars.setMatrixAt(i, ZERO);
      if (lights && nl < NEAR_CAP * 2) {
        const fx = Math.sin(h), fz = Math.cos(h), hl = set.len / 2 + 0.03;
        tmpL.makeRotationY(h).setPosition(x + fx * hl, 0.72, z + fz * hl); headL.setMatrixAt(nl, tmpL);
        tmpL.makeRotationY(h + Math.PI).setPosition(x - fx * hl, 0.8, z - fz * hl); tailL.setMatrixAt(nl, tmpL);
        nl++;
      }
    } else if (i % 3 === part) { // far boxes: a third of them per frame is plenty at 300 m+
      if (d2 > far2) farCars.setMatrixAt(i, ZERO);
      else { tmpM.makeRotationY(c.axis === 'x' ? Math.PI / 2 : 0).setPosition(x, 0.05, z); farCars.setMatrixAt(i, tmpM); }
    }
  }
  headL.count = tailL.count = nl;
  for (const m of [farCars, headL, tailL, ...carSets.map(s => s.mesh)]) m.instanceMatrix.needsUpdate = true;
}

// helicopters: the model's main rotor spins; a tail rotor is added at the end of the boom
function heliMesh() {
  const g = liveClone(MODELS.heli, { length: 13, tint: 0xb9c2a6, rotors: ['MainRotor'] });
  const sz = g.userData.size;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.9, 0.22), std({ color: 0x222222 }));
  tail.position.set(0.45, sz.y * 0.15, -sz.z / 2 + 0.4);
  g.add(tail); g.userData.tail = tail;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}
let heliMeshes = [];

// drones: the quadcopter model (CC-BY, see CREDITS.md), tinted per side; the four rotors spin
// with the simulated motor speed and vanish when a rotor is shot off
function droneMesh(color, led) {
  const g = liveClone(MODELS.drone, { length: 0.75, tint: color, rotors: ['Rotor_FL', 'Rotor_FR', 'Rotor_BR', 'Rotor_BL'] });
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: led }));
  light.position.set(0, 0.06, -0.3); g.add(light);
  g.userData.light = light;
  g.scale.setScalar(1.4); // ponytail: drawn 1.4× so it reads at chase-cam distance; physics is true size
  return g;
}

function buildHelis(game) {
  for (const m of heliMeshes) scene.remove(m);
  heliMeshes = game.helis.map(() => { const m = heliMesh(); scene.add(m); return m; });
}

// tracers + sparks
const MAXR = 400;
const tracerGeo = new THREE.BufferGeometry();
tracerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXR * 6), 3));
tracerGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXR * 6), 3));
const tracers = new THREE.LineSegments(tracerGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
tracers.frustumCulled = false; scene.add(tracers);
const sparks = [];
const sparkMat = new THREE.SpriteMaterial({ color: 0xffd27a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
function spark(p, size = 1) { const s = new THREE.Sprite(sparkMat.clone()); s.position.set(p.x, p.y, p.z); s.scale.setScalar(size); s.userData.t = 0; scene.add(s); sparks.push(s); }

// ---------------------------------------------------------------- game state
let game, droneMeshes = [], settings = { difficulty: 'normal', seed: 0, hour: 13, clock: false, hourNow: 13 }, running = false;
try { const saved = JSON.parse(localStorage.getItem('exfil.time') ?? 'null'); if (saved) Object.assign(settings, saved, { hourNow: saved.hour }); } catch {}
const input = { keys: new Set(), yaw: 0, pitch: -0.12, firing: false, cam: 'chase', intel: false, mode: 'angle', stick: { fwd: 0, right: 0 }, head: false };
const MODES = ['angle', 'acro', 'assist'];

async function start(seed) {
  $('loading').style.display = 'grid';
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
  settings.seed = seed ?? settings.seed ?? 1;
  audio.start();
  await ensureModels();
  game = await Game.create({ seed: settings.seed, difficulty: settings.difficulty });
  radio.reset(); radioLines.length = 0; $('radioLog').innerHTML = '';
  buildCityMeshes(game); buildCars(game); buildHelis(game); crowd.people = [];
  for (const m of droneMeshes) scene.remove(m);
  droneMeshes = game.drones.map(d => { const m = d === game.player ? droneMesh(0xffffff, 0x46e08a) : droneMesh(0x8a3a3a, 0xff3030); scene.add(m); return m; });
  input.yaw = game.player.heading; input.pitch = -0.12; settings.hourNow = settings.hour;
  $('menu').style.display = 'none'; $('over').style.display = 'none'; $('loading').style.display = 'none';
  running = true; acc = 0;
  canvas.requestPointerLock?.();
}

// ---------------------------------------------------------------- input
document.querySelectorAll('.choices').forEach(box => box.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  box.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
  if (box.id === 'diff') settings.difficulty = b.dataset.v;
  if (box.id === 'tod') { settings.hour = settings.hourNow = +b.dataset.v; }
  if (box.id === 'clockMode') settings.clock = b.dataset.v === 'run';
  try { localStorage.setItem('exfil.time', JSON.stringify({ hour: settings.hour, clock: settings.clock })); } catch {}
}));
$('start').onclick = () => start(1 + Math.floor(Math.random() * 1e6));
$('again').onclick = () => start(settings.seed);
$('newCity').onclick = () => start(1 + Math.floor(Math.random() * 1e6));
$('toMenu').onclick = () => { $('over').style.display = 'none'; $('menu').style.display = 'grid'; };
canvas.addEventListener('click', () => { if (running && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  input.yaw -= e.movementX * 0.0022;
  input.pitch = Math.max(-1.25, Math.min(0.5, input.pitch - e.movementY * 0.0022));
});
addEventListener('mousedown', e => { if (e.button === 0 && document.pointerLockElement === canvas) input.firing = true; });
addEventListener('mouseup', e => { if (e.button === 0) input.firing = false; });
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  // while flying, keys belong to the game: no Ctrl+S/Ctrl+D/space-scroll/F-find etc.
  // (Ctrl+W and Ctrl+T can't be blocked by any web page, which is why nothing uses Ctrl)
  if (running && (e.ctrlKey || e.metaKey || e.altKey || !['f5', 'f11', 'f12', 'escape'].includes(k))) e.preventDefault();
  input.keys.add(k);
  if (k === 'v' || k === 'c') input.cam = input.cam === 'chase' ? 'nose' : 'chase';
  if (k === 'f') { input.mode = MODES[(MODES.indexOf(input.mode) + 1) % MODES.length]; toast(`${input.mode.toUpperCase()} MODE`); }
  if (k === 'k') showKeys(!keysShown);
  if (k === 'm') { audio.muted = !audio.muted; toast(audio.muted ? 'SOUND OFF' : 'SOUND ON'); }
  if (k === '-' || k === '=' || k === '+') { setVolume(audio.volume + (k === '-' ? -0.1 : 0.1)); toast(`VOLUME ${Math.round(audio.volume * 100)}%`); }
  if (k === 'n') { audio.radioOn = !audio.radioOn; toast(audio.radioOn ? 'INTERCEPT RECEIVER ON' : 'INTERCEPT RECEIVER OFF'); }
  if (k === 'h') { input.head = !input.head; toast(input.head ? 'HEAD FIRST · SPRINT' : 'FACE FIRST'); }
  if (k === 'r' && game && (running || $('over').style.display === 'grid')) { start(settings.seed); return; } // retry, same city
  if (k === 'enter' && $('over').style.display === 'grid') { start(1 + Math.floor(Math.random() * 1e6)); return; }
  if (k === 'b') { input.intel = !input.intel; $('intel').style.display = input.intel ? 'block' : 'none'; }
});
addEventListener('keyup', e => input.keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { input.keys.clear(); input.firing = false; });
const held = (...k) => k.some(x => input.keys.has(x));

// sticks ramp like a real gimbal instead of snapping: a tap is a small tilt, holding goes to full
function ramp(cur, target, dt) { const r = target === 0 ? 4 : 2.2; return cur + Math.max(-r * dt, Math.min(r * dt, target - cur)); }
function playerCommand(dt) {
  const P = game.player;
  const fx = (held('w', 'arrowup') ? 1 : 0) - (held('s', 'arrowdown') ? 1 : 0);
  const rx = (held('d', 'arrowright') ? 1 : 0) - (held('a', 'arrowleft') ? 1 : 0);
  const yawKey = (held('q') ? 1 : 0) - (held('e') ? 1 : 0); // +heading = turn left
  const up = (held(' ') ? 1 : 0) - (held('x') ? 1 : 0);
  const gentle = held('shift') ? 0.35 : 1;
  input.stick.fwd = ramp(input.stick.fwd, fx * gentle, dt);
  input.stick.right = ramp(input.stick.right, rx * gentle, dt);
  const aim = aimDir(), cut = held('g'), sprint = input.head;
  if (input.mode === 'acro') { // rates: flips and rolls; throttle is yours (around hover)
    input.yaw = P.heading;
    const hover = P.mass * 9.81 / (4 * AIRFRAME.maxThrust);
    return { mode: 'acro', rates: { pitch: input.stick.fwd * 4.5, roll: input.stick.right * 4.5, yaw: yawKey * 2.5 }, throttle: hover * (1 + 0.9 * Math.max(0, up)) - hover * 0.8 * Math.max(0, -up), cut, aim, fire: input.firing };
  }
  input.yaw += yawKey * 1.8 * dt;
  const vz = up * (held('shift') ? 3 : 9);
  if (input.mode === 'assist') {
    const h = input.yaw, v = add(mul(fwdOf(h), fx), mul(rightOf(h), rx));
    return { v: mul(len(v) > 1 ? norm(v) : v, held('shift') ? 7 : 60), vz, heading: h, yawRate: yawKey * 1.8, cut, sprint, aim, fire: input.firing };
  }
  return { mode: 'angle', tilt: { fwd: input.stick.fwd, right: input.stick.right }, vz, heading: input.yaw, yawRate: yawKey * 1.8, cut, sprint, aim, fire: input.firing };
}
// where the gun points: along the camera
function aimDir() { const d = new THREE.Vector3(); camera.getWorldDirection(d); return v3(d.x, d.y, d.z); }

// ---------------------------------------------------------------- HUD
const radar = $('radar').getContext('2d');
function drawRadar(t) {
  const R = 105, cx = 110, cy = 110, range = 500, P = game.player, h = P.heading;
  radar.clearRect(0, 0, 220, 220);
  radar.strokeStyle = 'rgba(157,255,198,.25)'; radar.lineWidth = 1;
  for (const k of [1, 2, 3]) { radar.beginPath(); radar.arc(cx, cy, R * k / 3, 0, Math.PI * 2); radar.stroke(); }
  radar.beginPath(); radar.moveTo(cx, cy - R); radar.lineTo(cx, cy + R); radar.moveTo(cx - R, cy); radar.lineTo(cx + R, cy); radar.stroke();
  const sweep = (t * 2.4) % (Math.PI * 2);
  radar.strokeStyle = 'rgba(157,255,198,.5)'; radar.beginPath(); radar.moveTo(cx, cy); radar.lineTo(cx + R * Math.sin(sweep), cy - R * Math.cos(sweep)); radar.stroke();
  const plot = (p, color, sz, label, hollow) => { // heading-up
    const d = sub(p, P.pos), a = Math.atan2(d.x, d.z) - h, rr = Math.min(1, Math.hypot(d.x, d.z) / range) * R;
    const x = cx - Math.sin(a) * rr, y = cy - Math.cos(a) * rr;
    radar.fillStyle = radar.strokeStyle = color;
    radar.beginPath(); radar.arc(x, y, sz, 0, Math.PI * 2); hollow ? radar.stroke() : radar.fill();
    if (label) { radar.font = '10px monospace'; radar.fillText(label, x + 5, y - 4); }
  };
  plot(game.server, '#ffffff', 3, 'SRV');
  for (const hh of game.helis) plot(hh.pose.p, '#ffd24a', 3, 'H');
  for (const H of game.hunters) {
    const k = game.playerSensors.tracks.get(H.d);
    if (!k) continue;
    const age = game.time - k.t;
    if (age < 1.2) plot(k.pos, '#ff4a4a', 5, k.src[0]); else if (age < 30) plot(k.pos, 'rgba(255,74,74,.6)', 5, `${Math.round(age)}s`, true);
  }
  // direction-finding: a line toward whoever just keyed their radio (with DF error), fading out
  const nowS = performance.now() / 1000;
  for (const d of radio.df) {
    const a = d.bearing * Math.PI / 180 - h, f = 1 - (nowS - d.at) / 6;
    radar.strokeStyle = `rgba(255, 170, 60, ${Math.max(0, f)})`; radar.lineWidth = 2;
    radar.beginPath(); radar.moveTo(cx, cy); radar.lineTo(cx - Math.sin(a) * R, cy - Math.cos(a) * R); radar.stroke();
    radar.fillStyle = `rgba(255, 170, 60, ${Math.max(0, f)})`; radar.font = '10px monospace'; radar.fillText('DF', cx - Math.sin(a) * (R - 12) + 3, cy - Math.cos(a) * (R - 12));
  }
  radar.lineWidth = 1;
  radar.fillStyle = '#9dffc6'; radar.beginPath(); radar.moveTo(cx, cy - 6); radar.lineTo(cx - 4, cy + 4); radar.lineTo(cx + 4, cy + 4); radar.fill();
  radar.fillStyle = 'rgba(157,255,198,.6)'; radar.font = '10px monospace'; radar.fillText('500 m', 6, 214);
}

function hud() {
  const P = game.player, t = game.time, vel = P.vel;
  // what I know about the hunters (my sensors, not the truth)
  let best = null;
  for (const H of game.hunters) {
    const k = game.playerSensors.tracks.get(H.d);
    if (k && H.d.alive) { const d = dist(k.pos, P.pos); if (!best || d < best.d) best = { d, age: t - k.t, src: k.src }; }
  }
  const alive = game.hunters.filter(H => H.d.alive).length;
  $('hDist').textContent = (best ? `${Math.round(best.d)} m${best.age > 1.2 ? ' ?' : ''}` : 'unknown') + ` · ${alive} up`;
  $('bar').firstElementChild.style.width = `${Math.min(100, (best?.d ?? 0) / ESCAPE_DIST * 100)}%`;
  $('contact').textContent = best ? (best.age < 1.2 ? `${best.src} now` : `${best.src} ${Math.round(best.age)} s ago`) : 'none';
  const hh = ((settings.hourNow % 24) + 24) % 24;
  $('clock').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} · local ${String(Math.floor(hh)).padStart(2, '0')}:${String(Math.floor(hh % 1 * 60)).padStart(2, '0')}`;
  const agl = P.agl;
  $('spd').textContent = `${Math.round(len(vel) * 3.6)} km/h`;
  $('alt').textContent = `${agl.toFixed(0)} / ${P.pos.y.toFixed(0)} m`;
  $('vz').textContent = `${vel.y >= 0 ? '+' : ''}${vel.y.toFixed(1)} m/s`;
  $('hdg').textContent = `${String(Math.round(((P.heading * 180 / Math.PI) % 360 + 360) % 360)).padStart(3, '0')}° · ${Math.round(Math.acos(Math.min(1, P.up.y)) * 57.3)}°`;
  const w = game.windAt(P.pos);
  $('wind').textContent = `${len(flat(w)).toFixed(1)} m/s${w.y < -2 ? ` · DOWNWASH ${(-w.y).toFixed(0)}` : w.y > 2 ? ` · UPDRAFT ${w.y.toFixed(0)}` : ''}`;
  const soc = P.soc * 100, left = P.battery.wh / Math.max(P.battery.powerW, 1) * 60;
  $('bat').textContent = `${soc.toFixed(0)}%`; $('bat').style.color = soc < 20 ? 'var(--bad)' : soc < 40 ? 'var(--warn)' : '';
  $('draw').textContent = `${Math.round(P.battery.powerW)} W · ${left.toFixed(0)} min${P.battery.leakW ? ' · LEAK' : ''}`;
  $('hull').textContent = `${Math.round(P.hull)}%`; $('hull').style.color = P.hull < 35 ? 'var(--bad)' : P.hull < 70 ? 'var(--warn)' : '';
  [0, 1, 3, 2].forEach((ri, k) => { const hp = P.rotors[ri].health, b = $('rotors').children[k]; b.style.borderColor = hp > 0.66 ? 'var(--ok)' : hp > 0.2 ? 'var(--warn)' : 'var(--bad)'; b.style.opacity = hp > 0 ? 1 : 0.35; });
  $('ammo').textContent = P.ammo;
  for (const s of ['RADAR', 'CAMERA', 'ACOUSTIC']) $(`s${s}`).classList.toggle('on', game.hunters.some(H => { const k = game.playerSensors.tracks.get(H.d); return k && k.src === s && t - k.t < 0.6; }));
  // radar warning receiver: is anyone tracking me / shooting at me?
  const tracked = game.hunters.map(H => H.d.alive && H.sensors.track(game.player, t, 0.6)).filter(Boolean);
  const firing = game.hunters.some(H => H.d.firing);
  const rwr = $('rwr');
  if (game.status === 'downed') {
    rwr.style.display = 'block'; rwr.style.opacity = 1;
    rwr.textContent = `DOWNED · HUNTER ${Math.round(game.closing ?? 0)} m`;
    if (input.intel) $('intelText').innerHTML = game.hunters.map(H => `<p><b>${H.d.name}</b> · ${H.mode}<br>${H.thought}</p>`).join('');
    drawRadar(t);
    return;
  }
  rwr.style.display = tracked.length || firing ? 'block' : 'none';
  rwr.textContent = firing ? '▲ UNDER FIRE ▲' : tracked.some(k => k.src === 'CAMERA') ? 'OPTICAL LOCK' : tracked.some(k => k.src === 'RADAR') ? 'RADAR TRACK' : 'HEARD';
  rwr.style.opacity = firing ? (Math.sin(t * 20) > 0 ? 1 : 0.35) : 1;
  if (input.intel) $('intelText').innerHTML = game.hunters.map(H => `<p><b>${H.d.name}</b> · ${H.mode} · hull ${Math.round(H.d.hull)}%<br>${H.thought}</p>`).join('');
  drawRadar(t);
}
let toastTimer;
function toast(txt, color = '#9dffc6') { const e = $('toast'); e.textContent = txt; e.style.color = color; e.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => (e.style.opacity = 0), 1600); }

function gameOver(status) {
  running = false;
  document.exitPointerLock?.();
  const P = game.player, s = game.stats;
  const lostRotor = P.rotors.some(r => r.health < 0.05), found = game.hunters.some(H => H.d.alive) ? ' The hunter flew in to confirm.' : '';
  const titles = { escaped: ['EXFILTRATED', `You got ${ESCAPE_DIST} m clear of every hunter. The data is out.`], 'hunters-down': ['HUNTERS DOWN', 'You shot down every hunter.'],
    destroyed: ['SHOT DOWN', (P.deathCause === 'impact' ? 'You flew into something hard.' : lostRotor ? "You lost a rotor and couldn't stay in the air." : !P.alive ? 'The hunter shredded you.' : 'Too much damage to lift off again.') + found],
    battery: ['BATTERY DEAD', 'You ran out of power and dropped.' + found] };
  const [title, why] = titles[status];
  $('overTitle').textContent = title; $('overTitle').style.color = status === 'escaped' || status === 'hunters-down' ? 'var(--hud)' : 'var(--bad)';
  $('overWhy').textContent = why;
  $('overStats').innerHTML = [
    ['difficulty', `${game.diff.label} · ${game.hunters.length} hunter${game.hunters.length > 1 ? 's' : ''}`],
    ['time', `${Math.floor(game.time / 60)}:${String(Math.floor(game.time % 60)).padStart(2, '0')}`],
    ['flown', `${(s.flown / 1000).toFixed(2)} km`], ['battery used', `${(AIRFRAME.batteryWh - P.battery.wh).toFixed(0)} Wh of ${AIRFRAME.batteryWh}`],
    ['shots · hits', `${s.shots} · ${s.hits}`], ['hits taken', s.taken],
  ].map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('');
  $('over').style.display = 'grid';
}

// ---------------------------------------------------------------- loop
let acc = 0, last = performance.now();
const perf = { cars: 0, crowd: 0, render: 0, sim: 0 }; // ms, smoothed (window.exfil.perf)
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), camPos = new THREE.Vector3(0, 300, 300);
function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
  if (!game) return;
  if (running) {
    acc += dtReal;
    const cmd = playerCommand(dtReal);
    const ts = performance.now();
    for (let n = 0; acc >= DT && n < 12; n++, acc -= DT) {
      for (const e of game.step(cmd)) {
        audio.event(e, game);
        if (e.type === 'hit') { spark(e.p, e.who === game.player ? 1.2 : 0.8); if (e.who === game.player) toast(e.rotor >= 0 ? `ROTOR ${e.rotor + 1} HIT` : 'HULL HIT', '#ff4a4a'); else toast(`HIT ${e.who.name.toUpperCase()}`); }
        if (e.type === 'ricochet') { spark(e.p, 0.5); if (e.p.y < 20) crowd.scare(e.p, 60, game.time); }
        if (e.type === 'impact' && e.who === game.player) toast(`IMPACT ${e.dv.toFixed(0)} m/s`, '#ffb020');
        if (e.type === 'downed') toast(e.why === 'battery' ? 'BATTERY DEAD · YOU ARE DOWN' : 'YOU ARE DOWN', '#ff4a4a');
        if (e.type === 'end') gameOver(e.status);
      }
    }
    perf.sim = perf.sim * 0.95 + (performance.now() - ts) * 0.05;
  }
  const t = game.time, P = game.player;
  // drones
  game.drones.forEach((d, i) => {
    const m = droneMeshes[i], p = d.pos, q = d.q;
    m.position.set(p.x, p.y, p.z); m.quaternion.set(q.x, q.y, q.z, q.w);
    m.userData.rotors.forEach((r, k) => { if (!r) return; r.rotation.y += Math.min(d.rotors[k].w * dtReal, 1.2) * d.rotors[k].spin; r.visible = d.rotors[k].health > 0; });
    m.userData.light.visible = d === P || Math.sin(t * 12) > 0;
  });
  // aviation beacons blink
  if (cityGroup.userData.beacon) cityGroup.userData.beacon.visible = (t % 1.5) < 0.25;
  // helicopters
  game.helis.forEach((h, i) => { const m = heliMeshes[i]; if (!m) return; const p = h.pose.p; m.position.set(p.x, p.y, p.z); m.rotation.y = h.pose.heading; m.userData.rotors[0] && (m.userData.rotors[0].rotation.y = t * 30); m.userData.tail.rotation.x = t * 60; });
  // cars
  { const t0 = performance.now(); updateCars(game, t); perf.cars = perf.cars * 0.95 + (performance.now() - t0) * 0.05; }
  // time of day (optionally the clock runs: 1 hour per 2 minutes), stars/moon follow the camera
  if (settings.clock && running) settings.hourNow += dtReal * 30 / 3600;
  setTimeOfDay(settings.hourNow);
  skyDome.position.copy(camera.position);
  const n = NIGHT.value;
  if (cityGroup.userData.night) { const [pools, glow] = cityGroup.userData.night; poolMat.opacity = n * 0.55; lampGlowMat.opacity = n; pools.visible = glow.visible = n > 0.05; }
  // people on the sidewalks around you
  { const t0 = performance.now(); crowd.update(Math.min(dtReal, 0.05), t, P.pos, game.drones); perf.crowd = perf.crowd * 0.95 + (performance.now() - t0) * 0.05; }
  // smoke
  for (const s of smokes) {
    const { f, k } = s.userData, life = ((t * 0.08 + k / 18) % 1);
    const w = game.weather.base;
    s.position.set(f.x + w.x * life * 12, f.y + 4 + life * 120, f.z + w.z * life * 12);
    s.scale.setScalar(8 + life * 45); s.material.opacity = 0.75 * (1 - life);
  }
  // tracers
  const pos = tracerGeo.attributes.position.array, col = tracerGeo.attributes.color.array;
  const rs = game.rounds.slice(-MAXR);
  rs.forEach((b, i) => {
    const tail = sub(b.p, mul(b.v, 0.02));
    pos.set([b.p.x, b.p.y, b.p.z, tail.x, tail.y, tail.z], i * 6);
    const c = b.owner === P ? [1, 0.95, 0.5] : [1, 0.3, 0.2]; col.set([...c, ...c], i * 6);
  });
  tracerGeo.setDrawRange(0, rs.length * 2);
  tracerGeo.attributes.position.needsUpdate = tracerGeo.attributes.color.needsUpdate = true;
  for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.userData.t += dtReal; s.material.opacity = 1 - s.userData.t / 0.25; if (s.userData.t > 0.25) { scene.remove(s); sparks.splice(i, 1); } }
  // camera: chase (pulled in if a wall is behind you) or nose cam
  const cp = Math.cos(input.pitch), look = new THREE.Vector3(Math.sin(input.yaw) * cp, Math.sin(input.pitch), Math.cos(input.yaw) * cp);
  const p = P.pos;
  if (input.cam === 'nose') { // FPV: camera bolted to the airframe, tilted up by the gimbal (mouse Y)
    const m = P.part(v3(0, 0.02, 0.16)), q = P.q;
    camera.position.set(m.x, m.y, m.z);
    camera.quaternion.set(q.x, q.y, q.z, q.w).multiply(tmpQ.setFromAxisAngle(tmpV.set(0, 1, 0), Math.PI))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (input.mode === 'acro' ? 0.3 : 0.1) + input.pitch));
    camPos.copy(camera.position);
  } else {
    const back = v3(-look.x, -look.y + 0.28, -look.z), bl = len(back), dir = mul(back, 1 / bl);
    const hit = game.world.castRay(new RAPIER.Ray(p, dir), 6.5, true, undefined, undefined, undefined, P.body);
    const d = Math.max(0.8, (hit ? hit.timeOfImpact : 6.5) - 0.3);
    camPos.lerp(tmpV.set(p.x + dir.x * d, p.y + dir.y * d, p.z + dir.z * d), 0.35);
  }
  if (input.cam !== 'nose') {
    camera.position.copy(camPos);
    camera.lookAt(camPos.x + look.x * 100, camPos.y + look.y * 100, camPos.z + look.z * 100);
  }
  $('fmode').textContent = $('kMode').textContent = input.mode.toUpperCase();
  $('posture').textContent = $('kPosture').textContent = held('g') ? 'POWER CUT' : input.head ? 'HEAD' : 'FACE';
  $('posture').style.color = held('g') ? 'var(--bad)' : input.head ? 'var(--warn)' : '';
  camera.updateMatrixWorld(); csm.update();
  if (running || game.status !== 'play') { audio.update(game, camera, dtReal, { cut: held('g') }); radio.update(game, performance.now() / 1000); }
  hud();
  { const t0 = performance.now(); renderer.render(scene, camera); perf.render = perf.render * 0.95 + (performance.now() - t0) * 0.05; }
}
requestAnimationFrame(frame);

// a city behind the menu
(async () => { $('loading').textContent = 'LOADING MODELS…'; $('loading').style.display = 'grid'; await ensureModels(); $('loading').style.display = 'none'; $('loading').textContent = 'BUILDING CITY…';
  game = await Game.create({ seed: 1, difficulty: 'easy' }); buildCityMeshes(game); buildCars(game); buildHelis(game);
  droneMeshes = game.drones.map(d => { const m = d === game.player ? droneMesh(0xffffff, 0x46e08a) : droneMesh(0x8a3a3a, 0xff3030); scene.add(m); return m; });
  input.yaw = game.player.heading + 0.6; input.pitch = -0.25; })();
// controls panel: on by default, H toggles, remembered per browser
let keysShown = true;
function showKeys(on) {
  keysShown = on;
  $('keysPanel').style.display = on ? 'grid' : 'none'; $('keysHint').style.display = on ? 'none' : 'block';
  try { localStorage.setItem('exfil.keys', on ? '1' : '0'); } catch {}
}
try { showKeys(localStorage.getItem('exfil.keys') !== '0'); } catch { showKeys(true); }
// show the saved time-of-day choices as selected
document.querySelectorAll('#tod button').forEach(b => b.classList.toggle('sel', +b.dataset.v === settings.hour));
document.querySelectorAll('#clockMode button').forEach(b => b.classList.toggle('sel', (b.dataset.v === 'run') === settings.clock));
window.exfil = { get game() { return game; }, input, start, settings, renderer, crowd, audio, radio, perf };
