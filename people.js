// Pedestrians: a crowd that lives on the sidewalks around you. They walk, stand around, and run
// when drones come in low or rounds start hitting nearby, then calm down again. Pure visuals:
// instanced low-poly bodies with swinging arms and legs.
import * as THREE from 'three';
import { CITY } from './sim.js';

const PARTS = ['torso', 'head', 'legL', 'legR', 'armL', 'armR'];
const SIDE = CITY.road / 2 - 1.2; // sidewalk centre from the road centre line

export class Crowd {
  constructor(scene, std, count = 520) {
    this.n = count; this.people = [];
    const box = new THREE.BoxGeometry(1, 1, 1), ball = new THREE.SphereGeometry(0.5, 8, 6);
    this.mesh = {};
    for (const k of PARTS) {
      const m = new THREE.InstancedMesh(k === 'head' ? ball : box, std({ roughness: 0.85 }), count);
      m.castShadow = true; m.frustumCulled = false;
      scene.add(m); this.mesh[k] = m;
    }
    this.M = new THREE.Matrix4(); this.B = new THREE.Matrix4(); this.T = new THREE.Matrix4();
    this.center = null;
  }

  spawnNear(c, r, p = {}) {
    const n = Math.round(2 * CITY.half / CITY.pitch);
    const lineNear = v => Math.round((v + CITY.half) / CITY.pitch + (r() - 0.5) * 6);
    const axis = r() < 0.5 ? 'x' : 'z', k = Math.max(0, Math.min(n, lineNear(axis === 'x' ? c.z : c.x)));
    p.axis = axis;
    p.line = -CITY.half + k * CITY.pitch + (r() < 0.5 ? SIDE : -SIDE) + (r() - 0.5) * 1.4;
    p.s = (axis === 'x' ? c.x : c.z) + (r() - 0.5) * 700;
    p.dir = r() < 0.5 ? 1 : -1;
    p.walk = 1.1 + r() * 0.6; p.speed = p.walk; p.mode = r() < 0.12 ? 'idle' : 'walk';
    p.phase = r() * 10; p.calm = 0; p.height = 0.9 + r() * 0.2;
    return p;
  }

  reset(center) {
    const r = Math.random;
    this.people = Array.from({ length: this.n }, () => this.spawnNear(center, r));
    const col = new THREE.Color();
    this.people.forEach((p, i) => {
      const shirt = col.setHSL(r(), 0.35 + r() * 0.3, 0.25 + r() * 0.35).clone();
      this.mesh.torso.setColorAt(i, shirt); this.mesh.armL.setColorAt(i, shirt); this.mesh.armR.setColorAt(i, shirt);
      const pants = col.setHSL(0.6 + r() * 0.1, 0.2 + r() * 0.3, 0.12 + r() * 0.2).clone();
      this.mesh.legL.setColorAt(i, pants); this.mesh.legR.setColorAt(i, pants);
      this.mesh.head.setColorAt(i, col.setHSL(0.07, 0.35 + r() * 0.2, 0.3 + r() * 0.4));
    });
    for (const k of PARTS) this.mesh[k].instanceColor.needsUpdate = true;
  }

  pos(p) { return p.axis === 'x' ? { x: p.s, z: p.line } : { x: p.line, z: p.s }; }

  // something scary at point q (a drone overhead, a round hitting a wall): everyone near it runs
  scare(q, radius, t) {
    for (const p of this.people) {
      const a = this.pos(p), d = Math.hypot(a.x - q.x, a.z - q.z);
      if (d > radius) continue;
      const along = p.axis === 'x' ? a.x - q.x : a.z - q.z;
      p.dir = along >= 0 ? 1 : -1; // away from it
      p.mode = 'run'; p.speed = 4.2 + Math.random() * 2; p.calm = t + 6 + Math.random() * 6;
    }
  }

  update(dt, t, center, drones) {
    if (!this.people.length) this.reset(center);
    for (const d of drones) { const q = d.pos; if (d.alive && q.y < 35) this.scare(q, 45, t); }
    const { M, B, T } = this;
    this.people.forEach((p, i) => {
      if (p.mode === 'run' && t > p.calm) { p.mode = Math.random() < 0.2 ? 'idle' : 'walk'; p.speed = p.walk; }
      if (p.mode === 'idle' && Math.random() < dt * 0.05) p.mode = 'walk';
      if (p.mode === 'walk' && Math.random() < dt * 0.01) p.mode = 'idle';
      const v = p.mode === 'idle' ? 0 : p.speed;
      p.s += p.dir * v * dt;
      p.phase += v * dt * (p.mode === 'run' ? 2.2 : 3.2);
      let a = this.pos(p);
      if (Math.hypot(a.x - center.x, a.z - center.z) > 480) { this.spawnNear(center, Math.random, p); a = this.pos(p); }
      const h = p.axis === 'x' ? (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (p.dir > 0 ? 0 : Math.PI);
      const run = p.mode === 'run', swing = v === 0 ? 0 : Math.sin(p.phase) * (run ? 0.9 : 0.45);
      const bob = v === 0 ? 0 : Math.abs(Math.cos(p.phase)) * (run ? 0.08 : 0.03), lean = run ? 0.28 : 0.03, H = p.height;
      B.makeRotationY(h).setPosition(a.x, 0, a.z);
      const put = (k, m) => this.mesh[k].setMatrixAt(i, M.multiplyMatrices(B, m));
      put('torso', T.makeTranslation(0, (1.12 + bob) * H, 0).multiply(new THREE.Matrix4().makeRotationX(lean)).scale(new THREE.Vector3(0.42 * H, 0.6 * H, 0.24 * H)));
      put('head', T.makeTranslation(0, (1.6 + bob) * H, lean * 0.35).scale(new THREE.Vector3(0.24 * H, 0.26 * H, 0.24 * H)));
      for (const [k, sx, sgn] of [['legL', 0.11, 1], ['legR', -0.11, -1]])
        put(k, T.makeTranslation(sx * H, 0.84 * H, 0).multiply(new THREE.Matrix4().makeRotationX(swing * sgn)).multiply(new THREE.Matrix4().makeTranslation(0, -0.42 * H, 0)).scale(new THREE.Vector3(0.15 * H, 0.84 * H, 0.16 * H)));
      for (const [k, sx, sgn] of [['armL', 0.28, -1], ['armR', -0.28, 1]])
        put(k, T.makeTranslation(sx * H, (1.38 + bob) * H, 0).multiply(new THREE.Matrix4().makeRotationX(swing * sgn * 0.9 - (run ? 0.3 : 0))).multiply(new THREE.Matrix4().makeTranslation(0, -0.29 * H, 0)).scale(new THREE.Vector3(0.1 * H, 0.58 * H, 0.1 * H)));
    });
    for (const k of PARTS) this.mesh[k].instanceMatrix.needsUpdate = true;
  }
}
