// The rendered world, shared by the game (index.html / client.js) and the spectator
// (spectator.html / spectator.js): sky, sun/moon, clouds, shadows, city, traffic, helicopters,
// drones, pedestrians, tracers. It draws a Game's state; it never changes it.
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CITY, sub, mul } from './sim.js';
import { loadModels, bake, instanced, liveClone, topLean } from './models.js';
import { Crowd } from './people.js';
import { Clouds, godRaysPass } from './atmosphere.js';

export function createWorld({ renderer, camera }) {
  const scene = new THREE.Scene();
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
  for (const l of csm.lights) l.shadow.normalBias = 0.12; // enough against acne, small enough to keep drone/car/people shadows

  // post-processing: the scene renders into a target with a depth texture, then sun rays, then
  // tone mapping / colour space (OutputPass)
  const rtMain = new THREE.WebGLRenderTarget(renderer.domElement.width || 1, renderer.domElement.height || 1, { type: THREE.HalfFloatType, samples: 4 });
  rtMain.depthTexture = new THREE.DepthTexture(rtMain.width, rtMain.height);
  const composer = new EffectComposer(renderer, rtMain);
  const rays = godRaysPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(rays);
  composer.addPass(new OutputPass());
  // the RenderPass draws into the composer's second buffer, so that's the depth the ray pass must read
  if (!composer.renderTarget2.depthTexture) composer.renderTarget2.depthTexture = new THREE.DepthTexture(rtMain.width, rtMain.height);
  const clouds = new Clouds(scene);

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
    const elev = Math.sin((h - 6) / 12 * Math.PI) * THREE.MathUtils.degToRad(50); // 50° at noon: long-ish shadows all day
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
    const I = bySun ? 3.4 * THREE.MathUtils.smoothstep(SUNDIR.y, 0.03, 0.2) : 0.5;
    const C = bySun ? new THREE.Color(0xff9a50).lerp(new THREE.Color(0xfff0dc), low) : new THREE.Color(0x8fa8ff);
    for (const l of csm.lights) { l.intensity = I; l.color.copy(C); }
    // neutral fill light. The physical sky is HDR-bright: used as ambient it turned every wall pale blue
    // ("icy"). Measured on a sunlit wall: (100,126,144) sky-lit vs (60,59,55) neutral.
    hemi.intensity = 0.15 + 0.45 * day;
    hemi.color.set(day > 0.5 ? 0xd8d4cc : 0x5d6f9a); hemi.groundColor.set(0x6a6258);
    const dusk = Math.max(0, 1 - Math.abs(SUNDIR.y - 0.03) / 0.15);                  // orange haze around sunrise/sunset
    scene.fog.color.set(0x0b1018).lerp(new THREE.Color(0xb4bdc4), day).lerp(new THREE.Color(0xc0987a), dusk * 0.45);
    scene.environmentIntensity = 0.008 + 0.012 * day; // a trace: glints on glass, not a blue flood
    renderer.toneMappingExposure = 1.0 + 0.3 * NIGHT.value;
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
  const tmpS = new THREE.Vector3();

  // ---------------------------------------------------------------- city meshes
  // buildings: procedural facades laid out in each building's OWN coordinates (per-instance size and
  // seed): windows fit between corner pillars, floors start at the base, one style per building.
  // Concrete, not plastic: matte, fine grain, rain streaks, panel joints, dirty base. Everything is
  // anti-aliased with fwidth and fades to its average far away, so nothing shimmers or "z-fights".
  function windowed(params, house = false) {
    const m = std({ ...params, metalness: 0, roughness: 0.95, envMapIntensity: 0.25 }, sh => {
      WORLD_VARYINGS(sh);
      sh.uniforms.uNight = NIGHT;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aSize; attribute float aSeed;\nvarying vec3 vLocal; varying vec3 vSize; varying float vSeed;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vLocal = position * aSize; vSize = aSize; vSeed = aSeed;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
  varying vec3 vLocal; varying vec3 vSize; varying float vSeed;
  uniform float uNight;
  // a 1-D band [lo, hi] with edges softened by the pixel footprint w
  float band(float x, float lo, float hi, float w) { return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x)); }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          const bool HOUSE = ${house};
          if (vWNorm.y > 0.5) {                                             // roof: gravel
            diffuseColor.rgb *= 0.55 + 0.25 * vnoise(vWPos.xz * 0.8);
          } else if (abs(vWNorm.y) < 0.5) {
            bool xFace = abs(vWNorm.x) > 0.5;
            float faceW = xFace ? vSize.z : vSize.x;
            float u = (xFace ? vLocal.z : vLocal.x) + faceW * 0.5;          // metres from the face's left corner
            float v = vLocal.y + vSize.y * 0.5;                              // metres above the building's base
            float s1 = fract(vSeed * 13.13), s2 = fract(vSeed * 71.71), s3 = fract(vSeed * 5.37);
            float fh = HOUSE ? 2.9 : 3.2 + s2 * 0.8, ground = HOUSE ? 0.35 : fh * 1.3, pillar = HOUSE ? 0.7 : 0.9 + s2 * 0.6;
            float usable = max(faceW - 2.0 * pillar, 0.6);
            float cols = max(1.0, floor(usable / (HOUSE ? 2.8 : mix(1.8, 3.8, s1))));
            float top = vSize.y - (HOUSE ? 0.4 : 1.3);
            float floors = max(1.0, floor((top - ground) / fh));
            float uu = (u - pillar) / (usable / cols), vv = (v - ground) / ((top - ground) / floors);
            vec2 fw = vec2(fwidth(uu), fwidth(vv)) * 0.75;                   // pixel footprint in window cells
            float detail = 1.0 - smoothstep(0.18, 0.45, max(fw.x, fw.y));   // 1 = close, 0 = too small to draw
            vec2 f = fract(vec2(uu, vv));
            float inside = band(uu, 0.0, cols, fw.x) * band(vv, 0.0, floors, fw.y);
            float style = HOUSE ? 0.0 : s3;                                  // punched / ribbon / curtain wall
            float wx = style < 0.4 ? 0.2 : style < 0.72 ? 0.035 : 0.025;
            float wy0 = style < 0.72 ? 0.3 : 0.05, wy1 = style < 0.72 ? 0.84 : 0.96;
            float sharp = band(f.x, wx, 1.0 - wx, fw.x) * band(f.y, wy0, wy1, fw.y);
            float win = inside * mix((1.0 - 2.0 * wx) * (wy1 - wy0), sharp, detail);
            float frame = inside * detail * (band(f.x, wx - 0.05, 1.0 - wx + 0.05, fw.x) * band(f.y, wy0 - 0.05, wy1 + 0.04, fw.y) - sharp);
            float side = xFace ? sign(vWNorm.x) : 2.0 * sign(vWNorm.z);
            vec2 cell = vec2(floor(uu), floor(vv)) + vec2(vSeed * 173.0 + side * 31.0, side * 17.0);
            float litP = 0.15 + 0.33 * uNight;                               // share of rooms with the lights on
            float lit = mix(litP, step(1.0 - litP, h21(cell)), detail);
            float broken = step(0.985, h21(cell * 1.7 + 3.1)) * detail;      // war zone: a few panes blown out
            // concrete: fine grain (only up close), rain streaks under the windows, panel joints, dirty base
            float grain = mix(0.5, vnoise(vWPos.xy * 3.0 + vWPos.zy * 3.0), detail);
            float streak = vnoise(vec2(u * 0.9 + vSeed * 40.0, v * 0.07));
            float joints = inside * detail * (1.0 - band(f.x, 0.012, 0.988, fw.x)) * step(0.72, style);
            float base = 1.0 - smoothstep(0.0, 1.6, v);
            diffuseColor.rgb *= 0.9 + 0.1 * grain;
            diffuseColor.rgb *= 1.0 - 0.14 * smoothstep(0.35, 0.8, streak) - 0.25 * base - 0.2 * joints - 0.35 * max(frame, 0.0);
            float cornice = band(v, top, top + 0.25, fwidth(v));             // band under the parapet
            diffuseColor.rgb *= 1.0 - cornice * 0.3;
            vec3 glass = mix(vec3(0.045, 0.05, 0.055), vec3(0.1, 0.105, 0.11), s2);
            diffuseColor.rgb = mix(diffuseColor.rgb, broken > 0.5 ? vec3(0.015) : glass, win * 0.92);
            roughnessFactor = mix(roughnessFactor, 0.3, win * (1.0 - broken));
            metalnessFactor = mix(metalnessFactor, 0.15, win * (1.0 - broken));
            totalEmissiveRadiance += win * lit * (1.0 - broken) * vec3(1.0, 0.72, 0.38) * (0.35 + 1.8 * uNight);
            if (HOUSE) {                                                     // a front door on one face
              float door = band(u, faceW * 0.5 - 0.55, faceW * 0.5 + 0.55, fwidth(u)) * step(v, 2.2) * step(0.5, fract(vSeed * 3.0 + side * 0.25));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.15, 0.09), door);
            } else if (v < ground) {                                         // shopfronts: bays with glass and awnings
              float bays = max(1.0, floor(usable / 6.0)), bu = (u - pillar) / (usable / bays), bw = fwidth(bu), bf = fract(bu);
              float inB = band(bu, 0.0, bays, bw);
              float shop = inB * band(bf, 0.06, 0.94, bw) * band(v, 0.3, ground - 0.9, fwidth(v));
              float awning = inB * band(v, ground - 0.9, ground - 0.55, fwidth(v));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.055, 0.06), shop * 0.9);
              diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.42, 0.12, 0.1), vec3(0.12, 0.28, 0.3), step(0.5, h21(vec2(floor(bu), vSeed * 9.0)))), awning);
              roughnessFactor = mix(roughnessFactor, 0.25, shop);
              totalEmissiveRadiance += shop * vec3(0.9, 0.8, 0.6) * (0.12 + 0.9 * uNight) * step(0.45, h21(vec2(floor(bu), vSeed * 5.0 + side)));
            }
          }`);
    });
    m.shadowSide = THREE.BackSide; // closed boxes: only back faces write shadow depth, so lit walls never self-shadow (no acne)
    return m;
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
    mk(tall, windowed({}));
    mk(houses, windowed({}, true));
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


  // ---------------------------------------------------------------- per frame
  let droneMeshes = [];
  const tmpM = new THREE.Matrix4();
  function setDrones(game) {
    for (const m of droneMeshes) scene.remove(m);
    droneMeshes = game.drones.map(d => { const m = d === game.player ? droneMesh(0xffffff, 0x46e08a) : droneMesh(0x8a3a3a, 0xff3030); scene.add(m); return m; });
  }
  const perf = { cars: 0, crowd: 0 };
  // everything driven by the game's state (not by any particular camera)
  function update(game, dtReal, hour) {
    const t = game.time, P = game.player;
    game.drones.forEach((d, i) => {
      const m = droneMeshes[i]; if (!m) return;
      const p = d.pos, q = d.q;
      m.position.set(p.x, p.y, p.z); m.quaternion.set(q.x, q.y, q.z, q.w);
      m.userData.rotors.forEach((r, k) => { if (!r) return; r.rotation.y += Math.min(d.rotors[k].w * dtReal, 1.2) * d.rotors[k].spin; r.visible = d.rotors[k].health > 0; });
      m.userData.light.visible = d === P || Math.sin(t * 12) > 0;
    });
    if (cityGroup.userData.beacon) cityGroup.userData.beacon.visible = (t % 1.5) < 0.25;
    game.helis.forEach((h, i) => { const m = heliMeshes[i]; if (!m) return; const p = h.pose.p; m.position.set(p.x, p.y, p.z); m.rotation.y = h.pose.heading; m.userData.rotors[0] && (m.userData.rotors[0].rotation.y = t * 30); m.userData.tail.rotation.x = t * 60; });
    { const t0 = performance.now(); updateCars(game, t); perf.cars = perf.cars * 0.95 + (performance.now() - t0) * 0.05; }
    setTimeOfDay(hour);
    const n = NIGHT.value;
    if (cityGroup.userData.night) { const [pools, glow] = cityGroup.userData.night; poolMat.opacity = n * 0.55; lampGlowMat.opacity = n; pools.visible = glow.visible = n > 0.05; }
    { const t0 = performance.now(); crowd.update(Math.min(dtReal, 0.05), t, P.pos, game.drones); perf.crowd = perf.crowd * 0.95 + (performance.now() - t0) * 0.05; }
    for (const s of smokes) {
      const { f, k } = s.userData, life = ((t * 0.08 + k / 18) % 1), w = game.weather.base;
      s.position.set(f.x + w.x * life * 12, f.y + 4 + life * 120, f.z + w.z * life * 12);
      s.scale.setScalar(8 + life * 45); s.material.opacity = 0.75 * (1 - life);
    }
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
    game.__cloudT = (game.__cloudT ?? 0) + dtReal;
    world.game = game;
  }
  // everything that depends on the camera you're about to render from
  function view(cam, { raysOn = true } = {}) {
    skyDome.position.copy(cam.position);
    const game = world.game;
    const bySun = SUNDIR.y > 0.03, lightDir = bySun ? SUNDIR : MOONDIR;
    const lc = csm.lights[0].color.clone().multiplyScalar(bySun ? 1.25 : 0.35);
    const amb = new THREE.Color(0x9fb0c4).multiplyScalar(0.25 + 0.6 * (1 - NIGHT.value)).lerp(scene.fog.color, 0.3);
    if (game) clouds.update(cam, game.__cloudT, lightDir, lc, amb, scene.fog.color, game.weather.base, NIGHT.value);
    const sp = cam.position.clone().add(SUNDIR.clone().multiplyScalar(1000)).project(cam);
    const onScreen = raysOn && sp.z < 1 && Math.abs(sp.x) < 1.6 && Math.abs(sp.y) < 1.6;
    rays.uniforms.uSun.value.set((sp.x + 1) / 2, (sp.y + 1) / 2);
    rays.uniforms.uStrength.value = onScreen ? 0.55 * THREE.MathUtils.smoothstep(SUNDIR.y, 0.0, 0.12) : 0;
    rays.uniforms.uColor.value.copy(csm.lights[0].color);
    rays.uniforms.tDepth.value = composer.renderTarget2.depthTexture;
    if (csm.camera !== cam) { csm.camera = cam; csm.updateFrustums(); }
    cam.updateMatrixWorld(); csm.update();
  }
  function resize(w, h) { csm.updateFrustums(); composer.setSize(w, h); }
  const world = { hemi, sky, envSky,
    scene, csm, clouds, rays, composer, crowd, NIGHT, SUNDIR, perf, setTimeOfDay,
    ensureModels, buildCityMeshes, buildCars, buildHelis, setDrones, spark, update, view, resize,
    render: () => composer.render(),
    build(game) { buildCityMeshes(game); buildCars(game); buildHelis(game); setDrones(game); crowd.people = []; },
    get droneMeshes() { return droneMeshes; },
  };
  return world;
}
