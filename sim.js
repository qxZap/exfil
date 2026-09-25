// EXFIL: pure simulation (no rendering). The browser (index.html) and the headless test bench
// (test-sim.mjs) run this exact file. Units: metres, seconds, kilograms, newtons. +Y is up.
import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };
export const ready = RAPIER.init();

export const DT = 1 / 120;
export const G = 9.81;
export const RHO = 1.225;           // air density (kg/m³)
export const ESCAPE_DIST = 700;     // get this far from every hunter and you're out

// collision groups: membership << 16 | filter
const WORLD = 1, DRONE = 2, AIRCRAFT = 4;
const grp = (m, f) => ((m << 16) | f) >>> 0;
const SEE_WORLD = grp(0xffff, WORLD | AIRCRAFT);   // rays/sweeps: buildings, trees, ground, helicopters
const SEE_SOLID = grp(0xffff, WORLD);          // line of sight: buildings, trees, ground

// ---------------------------------------------------------------- vector kit ({x,y,z})
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = a => Math.hypot(a.x, a.y, a.z);
export const norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };
export const flat = a => v3(a.x, 0, a.z);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const dist = (a, b) => len(sub(a, b));
const lerp = (a, b, t) => a + (b - a) * t;
export const rot = (q, v) => { // rotate v by unit quaternion q
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return v3(v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx));
};
const conj = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const yawQuat = h => ({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });
export const headingOf = d => Math.atan2(d.x, d.z);                   // fwd = (sin h, 0, cos h)
export const fwdOf = h => v3(Math.sin(h), 0, Math.cos(h));
export const rightOf = h => v3(-Math.cos(h), 0, Math.sin(h));        // fwd × up
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

export function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the city
// A 4 km square grid: downtown towers in the middle, midtown blocks, an industrial sector,
// parks, and suburbs of houses with gardens. 16 m roads every 120 m. Everything solid is a
// static collider; cars are analytic (they follow the roads) and only matter near the ground.
export const CITY = { half: 2000, pitch: 120, road: 16 };

function buildCity(world, r) {
  const buildings = [], trees = [], fires = [];
  const box = (x, z, hx, hy, hz, kind, base = 0) => {
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, base + hy, z).setCollisionGroups(grp(WORLD, 0xffff)));
    buildings.push({ x, y: base + hy, z, hx, hy, hz, kind, shade: r() });
  };
  const tree = (x, z) => {
    const h = 5 + r() * 4, cr = 1.8 + r() * 1.4;
    world.createCollider(RAPIER.ColliderDesc.ball(cr).setTranslation(x, h, z).setCollisionGroups(grp(WORLD, 0xffff)));
    world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, 0.25).setTranslation(x, h / 2, z).setCollisionGroups(grp(WORLD, 0xffff)));
    trees.push({ x, z, h, r: cr });
  };
  world.createCollider(RAPIER.ColliderDesc.cuboid(3500, 1, 3500).setTranslation(0, -1, 0).setCollisionGroups(grp(WORLD, 0xffff)));

  const n = Math.round(2 * CITY.half / CITY.pitch), inner = (CITY.pitch - CITY.road) / 2;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const cx = -CITY.half + CITY.pitch * (i + 0.5), cz = -CITY.half + CITY.pitch * (j + 0.5);
    const d = Math.hypot(cx, cz) * (0.85 + r() * 0.3), ang = Math.atan2(cz, cx);
    // split the block into an a×b grid of lots
    const lots = (a, b, fn) => {
      for (let u = 0; u < a; u++) for (let w = 0; w < b; w++) {
        const lx = cx - inner + (2 * inner / a) * (u + 0.5), lz = cz - inner + (2 * inner / b) * (w + 0.5);
        fn(lx, lz, inner / a, inner / b);
      }
    };
    if (d > 500 && r() < 0.07) { // park
      for (let k = 0; k < 14; k++) tree(cx + (r() * 2 - 1) * inner * 0.9, cz + (r() * 2 - 1) * inner * 0.9);
    } else if (d < 650) { // downtown: towers
      const k = r() < 0.4 ? 1 : 2;
      lots(k, k, (x, z, ax, az) => {
        const h = 50 + 230 * Math.exp(-d / 380) * (0.35 + 0.65 * r() ** 0.8);
        box(x, z, ax * (0.62 + r() * 0.3), h / 2, az * (0.62 + r() * 0.3), 'tower');
        if (r() < 0.03) fires.push(v3(x, h, z));
      });
    } else if (d > 900 && ang > -1.1 && ang < -0.2) { // industrial sector: warehouses, stacks
      lots(1, 2, (x, z, ax, az) => {
        box(x, z, ax * 0.85, 5 + r() * 5, az * 0.8, 'warehouse');
        if (r() < 0.2) box(x + ax * 0.6, z, 1.5, 18 + r() * 12, 1.5, 'stack');
        if (r() < 0.02) fires.push(v3(x, 12, z));
      });
    } else if (d < 1300) { // midtown
      lots(2, 3, (x, z, ax, az) => {
        if (r() < 0.12) return tree(x, z);
        box(x, z, ax * (0.7 + r() * 0.2), (12 + r() * 45 * Math.exp(-(d - 650) / 500)) / 2, az * (0.7 + r() * 0.2), 'block');
      });
    } else { // suburbs: houses with gardens
      lots(4, 3, (x, z, ax, az) => {
        box(x, z - az * 0.2, 5 + r() * 2, 3 + r() * 1.6, 4 + r() * 1.5, 'house');
        if (r() < 0.6) tree(x + (r() - 0.5) * ax, z + az * 0.6);
      });
    }
  }
  return { buildings, trees, fires };
}

// Cars: follow the road grid, wrap at the city edge. Pure functions of time.
function makeCars(r, count = 360) {
  const n = Math.round(2 * CITY.half / CITY.pitch);
  return Array.from({ length: count }, () => ({
    axis: r() < 0.5 ? 'x' : 'z',
    line: -CITY.half + CITY.pitch * Math.floor(r() * (n + 1)),
    dir: r() < 0.5 ? 1 : -1,
    speed: 8 + r() * 9,
    phase: r() * 4000,
    color: r(),
  }));
}
export function carPose(c, t) {
  const along = ((c.phase + c.speed * t) % 4000 + 4000) % 4000 - 2000, s = along * c.dir, lane = 3.5 * c.dir;
  return c.axis === 'x' ? { x: s, z: c.line + lane, h: c.dir > 0 ? Math.PI / 2 : -Math.PI / 2 }
                        : { x: c.line - lane, z: s, h: c.dir > 0 ? 0 : Math.PI };
}

// ---------------------------------------------------------------- helicopters + weather
// Helicopters fly patrol ellipses. Their rotor pushes ~2 t of air per second straight down:
// the downwash (momentum theory, v ≈ 2·√(T/2ρA) ≈ 17 m/s under the disk) is part of the wind field.
export const HELI = { mass: 3200, rotorR: 7.5 };
HELI.vi = Math.sqrt(HELI.mass * G / (2 * RHO * Math.PI * HELI.rotorR ** 2)); // induced velocity at the disk

function makeHelis(world, r, count = 6) {
  return Array.from({ length: count }, () => {
    const c = v3((r() * 2 - 1) * 1300, 0, (r() * 2 - 1) * 1300);
    const h = {
      c, a: 350 + r() * 450, b: 300 + r() * 400, alt: 90 + r() * 110, speed: 28 + r() * 14,
      phase: r() * Math.PI * 2, dir: r() < 0.5 ? 1 : -1,
      body: world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()),
    };
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.4, 1.5, 5.5).setCollisionGroups(grp(AIRCRAFT, 0xffff)), h.body);
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.6, 3).setTranslation(0, 0.6, -8).setCollisionGroups(grp(AIRCRAFT, 0xffff)), h.body);
    return h;
  });
}
export function heliPose(h, t) {
  const w = h.dir * h.speed / ((h.a + h.b) / 2), th = h.phase + w * t;
  const p = v3(h.c.x + h.a * Math.cos(th), h.alt + 8 * Math.sin(th * 3), h.c.z + h.b * Math.sin(th));
  const vel = v3(-h.a * Math.sin(th) * w, 0, h.b * Math.cos(th) * w);
  return { p, vel, heading: headingOf(vel) };
}

export class Weather {
  constructor(r) {
    const a = r() * Math.PI * 2, s = 3 + r() * 4;
    this.base = v3(Math.cos(a) * s, 0, Math.sin(a) * s);
    this.gustPhase = r() * 100;
  }
  // wind vector at point p (without helicopters/fires): stronger with height (log profile), gusty
  ambient(p, t) {
    const prof = clamp(Math.log(Math.max(p.y, 1) / 0.5) / Math.log(80 / 0.5), 0.2, 1.3);
    const g = this.gustPhase;
    return v3(
      this.base.x * prof + 2.2 * Math.sin(0.31 * t + 0.011 * p.z + g) + 1.1 * Math.sin(1.7 * t + 0.05 * p.x),
      0.6 * Math.sin(0.9 * t + 0.02 * (p.x + p.z)),
      this.base.z * prof + 2.2 * Math.sin(0.27 * t + 0.013 * p.x + g * 1.3) + 1.1 * Math.sin(1.3 * t + 0.05 * p.z),
    );
  }
}
// downwash of one helicopter at point p (heliPos = rotor hub)
export function downwash(hp, p) {
  const depth = hp.y - p.y;
  if (depth < -3 || depth > 90) return 0;
  const R = HELI.rotorR * (1 + Math.max(0, depth) / 45);  // the column spreads as it falls
  const rr = Math.hypot(p.x - hp.x, p.z - hp.z);
  if (rr > R * 1.4) return 0;
  const edge = rr < R ? 1 : (1.4 - rr / R) / 0.4;
  return 2 * HELI.vi * (HELI.rotorR / R) ** 2 * Math.exp(-Math.max(0, depth) / 60) * edge;
}

// ---------------------------------------------------------------- the drone
// A 2.2 kg X-quad. Each part is a collider with its own mass; each rotor is its own thrust
// source with motor lag, health and battery sag; the flight controller mixes per-rotor thrust.
const ARM = 0.21;
export const DIFFICULTY = {
  easy:   { label: 'Easy',   speed: 1.00, radar: 330, camera: 280, spread: 1.3, reaction: 0.9 },
  normal: { label: 'Normal', speed: 1.10, radar: 400, camera: 330, spread: 0.95, reaction: 0.6 },
  hard:   { label: 'Hard',   speed: 1.20, radar: 460, camera: 380, spread: 0.7, reaction: 0.4 },
  brutal: { label: 'Brutal', speed: 1.25, radar: 520, camera: 420, spread: 0.5, reaction: 0.25 },
};
export const AIRFRAME = {
  maxThrust: 20,        // N per rotor at full charge (thrust/weight ≈ 3.7)
  propR: 0.13,          // m
  motorTau: 0.035,      // s, motor+prop spin-up time constant
  kq: 0.016,            // m, yaw reaction torque per newton of thrust
  cdaH: 0.077,          // m², effective drag area sideways (sets top speed ≈ 28 m/s at 60° tilt)
  cdaV: 0.12,           // m², drag area up/down (props + frame from above)
  batteryWh: 111,       // 6S 5000 mAh
  avionicsW: 18,
  eta: 0.62,            // motor+ESC+prop efficiency against ideal momentum-theory power
  maxTilt: 60 * Math.PI / 180,
  muzzle: 280,          // m/s
  rpm: 600,             // rounds per minute
  ammo: 400,
};
const ROTORS = [ // local position (forward +Z, left +X), spin (+1 = CCW from above)
  { p: v3(+ARM, 0.03, +ARM), spin: +1 },
  { p: v3(-ARM, 0.03, +ARM), spin: -1 },
  { p: v3(-ARM, 0.03, -ARM), spin: +1 },
  { p: v3(+ARM, 0.03, -ARM), spin: -1 },
];
// mixer: [collective, τx, τy, τz] = M · T  ->  T = M⁻¹ · [...]
const MIX = (() => {
  const M = [ROTORS.map(() => 1), ROTORS.map(r => -r.p.z), ROTORS.map(r => -r.spin * AIRFRAME.kq), ROTORS.map(r => r.p.x)];
  const n = 4, A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) { // Gauss-Jordan
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c]; for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map(row => row.slice(n));
})();

export class Drone {
  constructor(world, { pos, heading = 0, team, speed = 1, name }) {
    this.world = world; this.team = team; this.name = name;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z)
      .setRotation(yawQuat(heading)).setCanSleep(false).setCcdEnabled(true));
    const g = grp(DRONE, WORLD | DRONE | AIRCRAFT);
    const part = (desc, mass) => world.createCollider(desc.setMass(mass).setCollisionGroups(g).setFriction(0.8).setRestitution(0.2), this.body);
    part(RAPIER.ColliderDesc.cuboid(0.09, 0.03, 0.12), 0.55);                                // frame + electronics
    part(RAPIER.ColliderDesc.cuboid(0.035, 0.012, 0.035).setTranslation(ARM / 2, 0, ARM / 2), 0.05); // arms (as mass)
    part(RAPIER.ColliderDesc.cuboid(0.035, 0.012, 0.035).setTranslation(-ARM / 2, 0, ARM / 2), 0.05);
    part(RAPIER.ColliderDesc.cuboid(0.035, 0.012, 0.035).setTranslation(-ARM / 2, 0, -ARM / 2), 0.05);
    part(RAPIER.ColliderDesc.cuboid(0.035, 0.012, 0.035).setTranslation(ARM / 2, 0, -ARM / 2), 0.05);
    part(RAPIER.ColliderDesc.cuboid(0.07, 0.025, 0.05).setTranslation(0, -0.058, -0.01), 0.7); // battery, slung under the frame
    part(RAPIER.ColliderDesc.cuboid(0.04, 0.04, 0.05).setTranslation(0, -0.06, 0.13), 0.25);   // gun + camera pod
    for (const r of ROTORS) part(RAPIER.ColliderDesc.cylinder(0.012, AIRFRAME.propR).setTranslation(r.p.x, r.p.y, r.p.z), 0.08); // motor + prop
    this.mass = this.body.mass();
    // principal inertia comes in the principal frame, not the body frame: for a flat quad the
    // biggest one is yaw, the other two are roll/pitch
    const I = this.body.principalInertia(), s = [I.x, I.y, I.z].sort((a, b) => a - b);
    this.inertia = v3((s[0] + s[1]) / 2, s[2], (s[0] + s[1]) / 2);
    this.cdaH = AIRFRAME.cdaH / speed ** 2; // a sleeker airframe: top speed scales with 1/√(drag)
    this.rotors = ROTORS.map(r => ({ ...r, w: 0, thrust: 0, health: 1 }));
    this.kT = AIRFRAME.maxThrust / 1000 ** 2; // thrust = kT·ω², ω_max = 1000 rad/s
    this.battery = { wh: AIRFRAME.batteryWh, leakW: 0, powerW: 0 };
    this.hull = 100; this.alive = true; this.ammo = AIRFRAME.ammo; this.cooldown = 0; this.sensorDamage = 1;
    this.velI = v3(); this.aim = fwdOf(heading); this.firing = false; this.cmd = null;
    this.lastImpact = 0; this.rand = Math.random;
  }

  get pos() { return this.body.translation(); }
  get vel() { return this.body.linvel(); }
  get q() { return this.body.rotation(); }
  get up() { return rot(this.q, v3(0, 1, 0)); }
  get heading() { return headingOf(rot(this.q, v3(0, 0, 1))); }
  get soc() { return clamp(this.battery.wh / AIRFRAME.batteryWh, 0, 1); }
  part(local) { return add(this.pos, rot(this.q, local)); }
  get muzzle() { return this.part(v3(0, -0.06, 0.2)); }
  rotorWorld(i) { return this.part(this.rotors[i].p); }

  // ---------- flight controller: velocity command -> tilt -> attitude -> per-rotor thrust ----------
  // cmd = { v: desired horizontal velocity (world), vz: desired climb rate, heading: desired yaw }
  control(cmd, dt) {
    const v = this.vel, m = this.mass, q = this.q, up = this.up;
    // 1. horizontal: velocity loop with a little integral (holds position against wind)
    const ev = v3(cmd.v.x - v.x, 0, cmd.v.z - v.z);
    this.velI = mul(add(this.velI, mul(ev, dt)), 0.999);
    if (len(this.velI) > 6) this.velI = mul(norm(this.velI), 6);
    let a = add(mul(ev, 1.6), mul(this.velI, 0.35));
    const aMax = G * Math.tan(AIRFRAME.maxTilt);
    if (len(a) > aMax) a = mul(norm(a), aMax);
    // 2. vertical
    const evz = cmd.vz - v.y;
    this.vzI = clamp((this.vzI ?? 0) * 0.999 + evz * dt, -4, 4);
    const az = clamp(3.2 * evz + 1.2 * this.vzI, -0.85 * G, 14);
    const F = v3(m * a.x, m * (G + az), m * a.z);
    let upD = norm(F);
    if (upD.y < Math.cos(AIRFRAME.maxTilt)) { const h = norm(flat(upD)); upD = add(mul(h, Math.sin(AIRFRAME.maxTilt)), v3(0, Math.cos(AIRFRAME.maxTilt), 0)); }
    const collective = Math.max(0, dot(F, up));
    // 3. attitude: rotate current up onto desired up; yaw toward the commanded heading
    const qi = conj(q);
    const eAtt = rot(qi, cross(up, upD));
    const eYaw = wrapPi(cmd.heading - this.heading);
    const w = rot(qi, this.body.angvel());
    const I = this.inertia, KP = 150, KD = 20;
    const tau = v3(I.x * (KP * eAtt.x - KD * w.x), I.y * (6 * eYaw - 4 * w.y), I.z * (KP * eAtt.z - KD * w.z));
    // 4. mixer; if a rotor saturates, give up yaw authority first (keeping level matters more)
    let T = this.mix(collective, tau);
    if (T.some((t, i) => t < 0 || t > this.tMax(i))) T = this.mix(collective, v3(tau.x, 0, tau.z));
    this.cmdThrust = T.map((t, i) => clamp(t, 0, this.tMax(i)));
    this.cmd = cmd;
  }
  mix(c, tau) { const b = [c, tau.x, tau.y, tau.z]; return MIX.map(row => row[0] * b[0] + row[1] * b[1] + row[2] * b[2] + row[3] * b[3]); }
  tMax(i) { return AIRFRAME.maxThrust * this.rotors[i].health * (0.82 + 0.18 * this.soc) * (this.battery.wh > 0 ? 1 : 0); }

  // ---------- physics: motors spin up, each rotor pushes at its own position, air drags ----------
  applyForces(wind, dt) {
    const b = this.body, q = this.q, up = this.up;
    b.resetForces(true); b.resetTorques(true);
    let power = AIRFRAME.avionicsW + this.battery.leakW, yawTorque = 0, total = v3();
    const area = Math.PI * AIRFRAME.propR ** 2;
    // air pouring down through the discs (climbing, or sitting in downwash) unloads the props:
    // momentum theory, thrust falls as inflow grows relative to the hover induced velocity (~6 m/s)
    // (edgewise flow in forward flight doesn't count: that actually helps a prop)
    const inflow = Math.max(0, (this.vel.y - wind.y) * up.y);
    const inflowK = 1 / (1 + inflow / (2 * 6.2));
    this.rotors.forEach((r, i) => {
      const want = this.alive ? (this.cmdThrust?.[i] ?? 0) : 0;
      const wTarget = r.health > 0.05 ? Math.sqrt(want / (this.kT * Math.max(r.health, 0.05))) : 0;
      r.w += (wTarget - r.w) * Math.min(1, dt / AIRFRAME.motorTau);
      r.thrust = this.battery.wh > 0 ? this.kT * r.health * r.w * r.w * inflowK : 0;
      const f = mul(up, r.thrust);
      b.addForceAtPoint(f, this.part(r.p), true);
      total = add(total, f);
      yawTorque += -r.spin * AIRFRAME.kq * r.thrust;
      power += r.thrust ** 1.5 / Math.sqrt(2 * RHO * area) / AIRFRAME.eta;
    });
    b.addTorque(mul(up, yawTorque), true);
    // aerodynamic drag on velocity relative to the air (this is how wind and downwash push you)
    const vr = sub(this.vel, wind), vh = flat(vr);
    const drag = add(mul(vh, -0.5 * RHO * this.cdaH * len(vh)), v3(0, -0.5 * RHO * AIRFRAME.cdaV * Math.abs(vr.y) * vr.y, 0));
    b.addForce(drag, true);
    // a little rotational air damping, and turbulence that scales with how rough the air is
    b.addTorque(mul(b.angvel(), -0.0015), true);
    const rough = this.turbulence ?? 0;
    if (rough > 0.5) b.addTorque(v3((this.rand() - 0.5) * rough * 0.02, (this.rand() - 0.5) * rough * 0.01, (this.rand() - 0.5) * rough * 0.02), true);
    total = add(total, drag);
    this.battery.powerW = power;
    this.battery.wh = Math.max(0, this.battery.wh - power * dt / 3600);
    this.predictedV = add(this.vel, mul(add(mul(total, 1 / this.mass), v3(0, -G, 0)), dt));
  }

  // velocity change the forces don't explain = we hit something
  checkImpact(t) {
    if (!this.predictedV) return 0;
    const dv = len(sub(this.vel, this.predictedV));
    if (dv < 4 || t - this.lastImpact < 0.15) return 0;
    this.lastImpact = t;
    this.damage((dv - 4) * 9, 'impact');
    for (const r of this.rotors) r.health = Math.max(0, r.health - (dv - 4) * 0.09 * (0.5 + this.rand()));
    return dv;
  }

  damage(amount, why) {
    this.hull = Math.max(0, this.hull - amount);
    if (this.hull <= 0 && this.alive) { this.alive = false; this.deathCause = why; }
  }

  get agl() {
    const p = this.pos;
    const hit = this.world.castRay(new RAPIER.Ray(p, v3(0, -1, 0)), 500, true, undefined, SEE_SOLID, undefined, this.body);
    return hit ? hit.timeOfImpact : p.y;
  }
}

// ---------------------------------------------------------------- sensors
// Radar (360°, needs line of sight, loses low targets in ground clutter), an EO/IR camera
// (narrow, long, needs line of sight), and a microphone array (short, through walls, bearing
// only). Every drone has the same kit; difficulty only changes the hunters' ranges.
export class Sensors {
  constructor(owner, { radar = 400, camera = 330, acoustic = 90 } = {}) {
    this.owner = owner; this.range = { radar, camera, acoustic };
    this.tracks = new Map(); // target -> { pos, vel, t, src, err }
    this.next = { radar: 0, camera: 0, acoustic: 0 };
    this.lookDir = fwdOf(0);
  }
  los(a, b) {
    const d = sub(b, a), L = len(d);
    const hit = this.owner.world.castRay(new RAPIER.Ray(a, mul(d, 1 / L)), L, true, undefined, SEE_SOLID, undefined, this.owner.body);
    return !hit || hit.timeOfImpact > L - 0.6;
  }
  update(targets, t, r) {
    const me = this.owner.pos, dmg = this.owner.sensorDamage;
    for (const tg of targets) {
      if (!tg.alive && tg.hull <= 0 && tg.pos.y < 1) continue;
      const tp = tg.pos, d = dist(me, tp);
      const seen = (src, err) => {
        const old = this.tracks.get(tg), noise = v3((r() - 0.5) * err, (r() - 0.5) * err * 0.5, (r() - 0.5) * err);
        const pos = add(tp, noise);
        const vel = old && t - old.t < 1.5 ? add(mul(old.vel, 0.6), mul(sub(pos, old.pos), 0.4 / Math.max(t - old.t, 0.05))) : v3();
        this.tracks.set(tg, { pos, vel, t, src, err });
      };
      if (t >= this.next.radar && d < this.range.radar * dmg) {
        const agl = tp.y; // clutter: low targets hide against the ground and buildings
        const p = clamp((agl - 4) / 30, 0.12, 1) * (1 - (d / (this.range.radar * dmg)) ** 4);
        if (r() < p && this.los(me, tp)) seen('RADAR', d * 0.012);
      }
      if (t >= this.next.camera && d < this.range.camera * dmg) {
        const dir = norm(sub(tp, me));
        if (dot(dir, this.lookDir) > Math.cos(35 * Math.PI / 180) && r() < 0.95 * (1 - (d / (this.range.camera * dmg)) ** 2) && this.los(me, tp)) seen('CAMERA', d * 0.004);
      }
      if (t >= this.next.acoustic && d < this.range.acoustic * clamp(tg.battery.powerW / 400, 0.4, 1.5)) {
        if (r() < 0.6) seen('ACOUSTIC', d * 0.25);
      }
    }
    if (t >= this.next.radar) this.next.radar = t + 0.25;
    if (t >= this.next.camera) this.next.camera = t + 0.1;
    if (t >= this.next.acoustic) this.next.acoustic = t + 0.3;
  }
  track(tg, t, maxAge = 1.2) { const k = this.tracks.get(tg); return k && t - k.t < maxAge ? k : null; }
}

// ---------------------------------------------------------------- navigation (shared by AI + autopilot)
// Sweep a sphere a bit bigger than the drone along candidate 3D directions; take the one that
// best serves the goal while staying clear. Helicopter downwash columns count as obstacles.
const NAV_DIRS = [];
for (const yaw of [0, 20, -20, 45, -45, 75, -75, 110, -110, 150, -150, 180]) for (const pitch of [0, 25, -20, 55, -45, 85]) {
  if (Math.abs(pitch) === 85 && yaw !== 0) continue;
  NAV_DIRS.push({ yaw: yaw * Math.PI / 180, pitch: pitch * Math.PI / 180 });
}
export class Navigator {
  constructor(drone) { this.d = drone; this.last = null; this.ball = new RAPIER.Ball(0.9); this.scan = null; this.scanAt = -1; }
  clearance(from, dir, range) {
    const hit = this.d.world.castShape(from, { x: 0, y: 0, z: 0, w: 1 }, dir, this.ball, 0, range, false, undefined, SEE_WORLD, undefined, this.d.body);
    return hit ? hit.time_of_impact : range;
  }
  washAlong(from, dir, range, helis) { // strongest downwash along the path
    let worst = 0;
    for (const hp of helis) for (let s = 5; s <= range; s += 10) worst = Math.max(worst, downwash(hp, add(from, mul(dir, s))));
    return worst;
  }
  // goal: world point; speed: wanted m/s; returns a flight-controller command
  steer(goal, speed, t, { helis = [], minAgl = 6, heading = null } = {}) {
    const d = this.d, p = d.pos, v = d.vel, sp = len(v);
    const to = sub(goal, p), gd = len(to), want = norm(to);
    const range = clamp(sp * 3 + 15, 25, 120);
    const aBrake = 0.75 * G * Math.tan(AIRFRAME.maxTilt);
    if (!this.scan || t - this.scanAt > 1 / 15) { // think at 15 Hz
      const baseH = headingOf(flat(want).x || flat(want).z ? want : fwdOf(d.heading));
      let best = null;
      for (const c of NAV_DIRS) {
        const h = baseH + c.yaw, cp = Math.cos(c.pitch);
        const dir = v3(Math.sin(h) * cp, Math.sin(c.pitch), Math.cos(h) * cp);
        const clear = this.clearance(p, dir, range);
        const wash = this.washAlong(p, dir, Math.min(clear, 60), helis);
        let score = dot(dir, want) * Math.min(clear, gd) + 0.12 * clear
          + (this.last ? 3 * dot(dir, this.last) : 0) - wash * 1.5 - (clear < 8 ? 60 : 0);
        if (p.y < minAgl + 2 && dir.y < 0) score -= 40; // don't dive into the street
        if (!best || score > best.score) best = { dir, clear, score, wash };
      }
      // momentum goes where I'm moving, not where I want to go: check that line too
      best.clearVel = sp > 3 ? this.clearance(p, mul(v, 1 / sp), range) : range;
      this.scan = best; this.scanAt = t; this.last = best.dir;
    }
    const { dir, clear, clearVel } = this.scan;
    // stopping distance = reaction (tilting back takes ~0.35 s) + v²/2a
    const stopOK = c => Math.max(0, Math.sqrt(aBrake * aBrake * 0.35 * 0.35 + 2 * aBrake * Math.max(0, c - 6)) - aBrake * 0.35);
    const vMax = Math.min(speed, stopOK(clear), stopOK(clearVel) + 4, Math.sqrt(2 * aBrake * 0.6 * gd) + 1);
    let vz = dir.y * vMax;
    const agl = p.y; // city ground is at 0; rooftops are handled by the sweep
    if (agl < minAgl) vz = Math.max(vz, (minAgl - agl) * 1.5);
    return { v: mul(flat(dir), vMax), vz: clamp(vz, -8, 10), heading: heading ?? (sp > 2 ? headingOf(v) : d.heading), clear, wash: this.scan.wash };
  }
}

// ---------------------------------------------------------------- the hunter's brain
// TRANSIT to the server it was told about → CHASE when a sensor has you → SEARCH (climb high,
// go to where you were heading, spiral out) when it loses you. Shoots with a lead solution.
export class Hunter {
  constructor(game, drone, diff) {
    this.g = game; this.d = drone; this.diff = diff;
    this.nav = new Navigator(drone);
    this.sensors = new Sensors(drone, { radar: diff.radar, camera: diff.camera });
    this.mode = 'TRANSIT'; this.thought = 'Heading to the server the operator flagged.';
    this.lkp = null; this.searchT = 0; this.seenAt = -99; this.burst = 0;
  }
  think(t, dt) {
    const g = this.g, d = this.d, me = d.pos, target = g.player;
    if (!d.alive) { this.mode = 'DOWN'; this.thought = 'Lost power.'; d.firing = false; return d.control({ v: v3(), vz: -5, heading: d.heading }, dt); }
    this.sensors.update([target], t, g.r);
    const trk = this.sensors.track(target, t, 1.0);
    const helis = g.helis.map(h => h.pose.p);
    let cmd, fire = false, aimAt = null;
    if (trk) {
      if (this.mode !== 'CHASE') this.reactUntil = t + this.diff.reaction;
      this.mode = 'CHASE'; this.lkp = trk; this.seenAt = t;
      const rel = sub(trk.pos, me), r = len(rel);
      // intercept: aim where you'll be; close fast when far, hold a firing standoff when near
      const tti = r / Math.max(len(d.vel) + 5, 15);
      const pred = add(trk.pos, mul(trk.vel, Math.min(tti, 3)));
      const stand = r < 140 ? add(trk.pos, add(mul(norm(flat(sub(me, trk.pos))), 70), v3(0, 18, 0))) : pred;
      cmd = this.nav.steer(stand, 60, t, { helis, minAgl: 4, heading: headingOf(rel) });
      this.sensors.lookDir = norm(rel);
      if (r < 260 && t > this.reactUntil && trk.src !== 'ACOUSTIC') { aimAt = trk; fire = true; }
      this.thought = `${trk.src} contact, ${Math.round(r)} m. ${fire ? 'Engaging.' : r < 140 ? 'Holding firing position.' : 'Intercepting.'}`;
    } else if (this.lkp) {
      if (this.mode !== 'SEARCH') { this.mode = 'SEARCH'; this.searchT = t; }
      const since = t - this.seenAt;
      // where would you be now if you kept going? Go there high, then spiral out
      const guess = add(this.lkp.pos, mul(flat(this.lkp.vel), Math.min(since, 8)));
      const alt = Math.max(guess.y + 60, 140);
      const onTop = len(flat(sub(guess, me))) < 60;
      const R = onTop ? Math.min(40 + (t - this.searchT) * 6, 450) : 0, a = (t - this.searchT) * 0.35;
      const goal = v3(guess.x + R * Math.cos(a), alt, guess.z + R * Math.sin(a));
      cmd = this.nav.steer(goal, 60, t, { helis, minAgl: 20 });
      this.sensors.lookDir = norm(add(flat(sub(guess, me)), v3(0, -0.6 * len(flat(sub(guess, me))) - 30, 0)));
      if (len(flat(sub(guess, me))) < 5) this.sensors.lookDir = v3(0, -1, 0);
      this.thought = me.y < alt - 20 ? `Lost you ${Math.round(since)} s ago. Climbing to ${Math.round(alt)} m to look down.` : `Searching around your last track (radius ${Math.round(R)} m).`;
    } else {
      this.mode = 'TRANSIT';
      const goal = add(g.server, v3(0, 60, 0));
      cmd = this.nav.steer(goal, 60, t, { helis, minAgl: 25 });
      this.sensors.lookDir = norm(sub(g.server, me));
      this.thought = `Heading to the flagged server, ${Math.round(dist(me, g.server))} m out.`;
    }
    if (cmd.wash > 3) this.thought += ' Steering clear of helicopter downwash.';
    d.control(cmd, dt);
    // gun: lead the target, compensate drop; fire in bursts
    d.firing = false;
    if (fire && aimAt) {
      const sol = leadSolution(d.muzzle, d.vel, aimAt.pos, aimAt.vel);
      if (sol) {
        d.aim = sol;
        this.burst -= dt;
        if (this.burst < -0.6) this.burst = 0.9;
        d.firing = this.burst > 0 && this.sensors.los(me, aimAt.pos);
      }
    } else d.aim = fwdOf(d.heading);
  }
}

// where to point a gun so a round (muzzle speed + shooter velocity, gravity) meets the target
export function leadSolution(from, shooterV, tp, tv) {
  let tt = dist(from, tp) / AIRFRAME.muzzle;
  let aimP = tp;
  for (let k = 0; k < 4; k++) {
    aimP = add(add(tp, mul(sub(tv, shooterV), tt)), v3(0, 0.5 * G * tt * tt, 0));
    tt = dist(from, aimP) / AIRFRAME.muzzle;
  }
  return tt < 2 ? norm(sub(aimP, from)) : null;
}

// ---------------------------------------------------------------- the player's autopilot (tests + demo)
// Runs from the hunter's last known position, low, using buildings to break line of sight.
export class Evader {
  constructor(game) { this.g = game; this.nav = new Navigator(game.player); this.jink = 0; this.dir = v3(1, 0, 0); }
  command(t) {
    const g = this.g, me = g.player.pos;
    const trk = g.playerSensors.track(g.hunters[0]?.d, t, 3);
    if (trk) this.dir = norm(flat(sub(me, trk.pos)));
    if (t > this.jink) { this.jink = t + 3 + g.r() * 3; this.side = (g.r() - 0.5) * 0.8; }
    const away = norm(add(this.dir, mul(rightOf(headingOf(this.dir)), this.side ?? 0)));
    const goal = add(me, add(mul(away, 120), v3(0, 22 - me.y, 0)));
    const cmd = this.nav.steer(goal, 60, t, { helis: g.helis.map(h => h.pose.p), minAgl: 8 });
    return { ...cmd, fire: false };
  }
}

// ---------------------------------------------------------------- the game
export class Game {
  static async create(opts) { await ready; return new Game(opts); }
  constructor({ seed = 1, difficulty = 'normal', hunters = 1 } = {}) {
    this.r = rng(seed); this.seed = seed;
    this.diff = { key: difficulty, ...DIFFICULTY[difficulty] };
    this.world = new RAPIER.World(v3(0, -G, 0));
    this.world.timestep = DT;
    this.city = buildCity(this.world, this.r);
    this.cars = makeCars(this.r);
    this.helis = makeHelis(this.world, this.r);
    this.weather = new Weather(this.r);
    // the server: on the roof of the tallest tower near the centre
    const towers = this.city.buildings.filter(b => b.kind === 'tower').sort((a, b) => (b.hy - Math.hypot(b.x, b.z) / 8) - (a.hy - Math.hypot(a.x, a.z) / 8));
    const tower = towers[0]; // tall and central
    const roof = tower.y + tower.hy;
    this.serverTower = tower;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.9, 0.35).setTranslation(tower.x, roof + 0.9, tower.z).setCollisionGroups(grp(WORLD, 0xffff)));
    this.server = v3(tower.x, roof + 0.9, tower.z);
    this.player = new Drone(this.world, { pos: v3(tower.x + 2.5, roof + 0.3, tower.z), team: 'player', name: 'You' });
    this.playerSensors = new Sensors(this.player);
    this.hunters = Array.from({ length: hunters }, (_, i) => {
      const a = this.r() * Math.PI * 2 + i * 2.1, R = 380 + this.r() * 80; // close enough to matter, far enough to take off
      const p = v3(this.server.x + R * Math.cos(a), 150 + this.r() * 40, this.server.z + R * Math.sin(a));
      const d = new Drone(this.world, { pos: p, heading: headingOf(sub(this.server, p)), team: 'hunter', speed: this.diff.speed, name: `Hunter ${i + 1}` });
      return new Hunter(this, d, this.diff);
    });
    this.drones = [this.player, ...this.hunters.map(h => h.d)];
    for (const d of this.drones) d.rand = this.r;
    this.rounds = [];
    this.time = 0; this.status = 'play'; this.events = [];
    this.stats = { shots: 0, hits: 0, taken: 0, flown: 0 };
    this.pose();
  }

  pose() { for (const h of this.helis) h.pose = heliPose(h, this.time); }

  windAt(p) {
    let w = this.weather.ambient(p, this.time);
    this.lastTurb = 0;
    for (const h of this.helis) { const dw = downwash(h.pose.p, p); if (dw) { w = add(w, v3((this.r() - 0.5) * dw * 0.3, -dw, (this.r() - 0.5) * dw * 0.3)); this.lastTurb += dw; } }
    for (const f of this.city.fires) { // hot air rises above fires
      const rr = Math.hypot(p.x - f.x, p.z - f.z);
      if (rr < 25 && p.y > f.y && p.y < f.y + 150) w = add(w, v3(0, 5 * (1 - rr / 25), 0));
    }
    return w;
  }

  // closest nearest-hunter distance (only hunters still flying count)
  get escapeDist() {
    const live = this.hunters.filter(h => h.d.alive);
    return live.length ? Math.min(...live.map(h => dist(h.d.pos, this.player.pos))) : Infinity;
  }

  // One fixed step. input: { v, vz, heading, aim, fire } in world terms (see index.html for keys→input)
  step(input) {
    const t = this.time, dt = DT, events = [];
    this.pose();
    for (const h of this.helis) {
      h.body.setNextKinematicTranslation(h.pose.p);
      h.body.setNextKinematicRotation(yawQuat(h.pose.heading));
    }
    // player
    const P = this.player;
    this.playerSensors.lookDir = input?.aim ?? fwdOf(P.heading);
    this.playerSensors.update(this.hunters.map(h => h.d), t, this.r);
    const inp = input ?? { v: v3(), vz: 0, heading: P.heading }; // no input: hover in place
    P.control({ v: inp.v, vz: inp.vz, heading: inp.heading }, dt);
    P.aim = inp.aim ?? fwdOf(P.heading);
    P.firing = !!inp.fire && P.alive;
    for (const h of this.hunters) h.think(t, dt);
    for (const d of this.drones) { const w = this.windAt(d.pos); d.turbulence = this.lastTurb; d.applyForces(w, dt); this.shoot(d, dt, events); }
    const before = P.pos;
    this.world.step();
    this.time += dt;
    this.stats.flown += dist(before, P.pos);
    // impacts: buildings, ground, helicopters, cars (cars are analytic, check only near the street)
    for (const d of this.drones) {
      if (d.pos.y < 3) for (const c of this.cars) {
        const cp = carPose(c, this.time);
        const ax = c.axis === 'x' ? 2.3 : 1.0, az = c.axis === 'x' ? 1.0 : 2.3;
        if (Math.abs(d.pos.x - cp.x) < ax && Math.abs(d.pos.z - cp.z) < az && d.pos.y < 1.6) {
          d.body.applyImpulse(v3(0, 3, 0), true);
          d.damage(8, 'car');
          events.push({ type: 'impact', who: d, dv: 5 });
          break;
        }
      }
      const dv = d.checkImpact(this.time);
      if (dv) events.push({ type: 'impact', who: d, dv });
    }
    this.flyRounds(dt, events);
    // outcome
    if (this.status === 'play') {
      if (!P.alive || (P.pos.y < 0.6 && P.rotors.every(r => r.health < 0.3))) this.status = 'destroyed';
      else if (P.battery.wh <= 0) this.status = 'battery';
      else if (this.hunters.every(h => !h.d.alive)) this.status = 'hunters-down';
      else if (this.escapeDist >= ESCAPE_DIST) this.status = 'escaped';
      if (this.status !== 'play') events.push({ type: 'end', status: this.status });
    }
    this.events = events;
    return events;
  }

  shoot(d, dt, events) {
    d.cooldown -= dt;
    if (!d.firing || !d.alive || d.ammo <= 0 || d.cooldown > 0) return;
    // the gimbal can only swing so far: ±40° off the nose, -75°..+30° in pitch
    const h = d.heading, a = d.aim;
    let yawOff = clamp(wrapPi(headingOf(a) - h), -0.7, 0.7);
    const pitch = clamp(Math.asin(clamp(a.y, -1, 1)), -1.3, 0.52);
    const spread = (d.team === 'hunter' ? this.diff.spread : 0.5) * Math.PI / 180;
    const hh = h + yawOff + (this.r() - 0.5) * 2 * spread, pp = pitch + (this.r() - 0.5) * 2 * spread;
    const dir = v3(Math.sin(hh) * Math.cos(pp), Math.sin(pp), Math.cos(hh) * Math.cos(pp));
    const m = d.muzzle;
    this.rounds.push({ p: m, v: add(d.vel, mul(dir, AIRFRAME.muzzle)), owner: d, age: 0 });
    d.body.applyImpulseAtPoint(mul(dir, -0.02), m, true); // recoil
    d.ammo--; d.cooldown = 60 / AIRFRAME.rpm;
    if (d === this.player) this.stats.shots++;
    events.push({ type: 'shot', who: d, p: m });
  }

  flyRounds(dt, events) {
    const keep = [];
    for (const b of this.rounds) {
      const p0 = b.p;
      b.v = add(b.v, v3(0, -G * dt, 0));
      const step = mul(b.v, dt), L = len(step), dir = mul(step, 1 / L);
      b.p = add(p0, step); b.age += dt;
      // drones: segment vs part spheres (rotors, body)
      let best = null;
      for (const d of this.drones) {
        if (d === b.owner || (d.hull <= 0 && d.pos.y < 0.5)) continue;
        if (dist(d.pos, p0) > L + 1) continue;
        // hit zones: each spinning prop disc (plus motor) and the frame/battery/pod core
        const parts = [...d.rotors.map((r, i) => ({ c: d.rotorWorld(i), rad: 0.17, rotor: i })), { c: d.part(v3(0, -0.03, 0.02)), rad: 0.2, rotor: -1 }];
        for (const part of parts) {
          const s = clamp(dot(sub(part.c, p0), dir), 0, L);
          if (dist(add(p0, mul(dir, s)), part.c) < part.rad && (!best || s < best.s)) best = { s, d, part };
        }
      }
      const wall = this.world.castRay(new RAPIER.Ray(p0, dir), L, true, undefined, SEE_WORLD);
      if (wall && (!best || wall.timeOfImpact < best.s)) { events.push({ type: 'ricochet', p: add(p0, mul(dir, wall.timeOfImpact)) }); continue; }
      if (best) { this.hit(best.d, best.part, b, events); continue; }
      if (b.age < 3 && b.p.y > 0) keep.push(b);
    }
    this.rounds = keep;
  }

  hit(d, part, b, events) {
    const r = this.r;
    if (part.rotor >= 0) {
      const rot_ = d.rotors[part.rotor];
      rot_.health = Math.max(0, rot_.health - 0.34);
      d.damage(4, 'shot down');
    } else {
      d.damage(14, 'shot down');
      if (r() < 0.25) d.battery.leakW += 60;          // punctured cell: bleeds power
      if (r() < 0.15) d.sensorDamage *= 0.6;          // cracked optics / radar
    }
    d.body.applyImpulseAtPoint(mul(norm(b.v), 0.03), part.c, true);
    if (b.owner === this.player) this.stats.hits++;
    if (d === this.player) this.stats.taken++;
    events.push({ type: 'hit', who: d, p: part.c, rotor: part.rotor });
  }
}
