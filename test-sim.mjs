// Headless test bench: the exact game simulation, no browser. `npm test` (SEEDS=n for more games)
import { Game, DT, v3, len, flat, dist, add, Drone, DIFFICULTY, Evader, heliPose } from './sim.js';

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`); };
const hoverCmd = { v: v3(), vz: 0, heading: 0 };

// park the player somewhere and let it settle into a hover
async function open(opts = {}) {
  const g = await Game.create({ seed: 1, hunters: 0, ...opts });
  return g;
}
function place(g, d, p) { d.body.setTranslation(p, true); d.body.setLinvel(v3(), true); d.body.setAngvel(v3(), true); }

// 1. hover: altitude hold, endurance
{
  const g = await open(), P = g.player;
  place(g, P, v3(1700, 60, 1700)); // above the suburbs
  let errMax = 0, tiltMax = 0;
  for (let i = 0; i * DT < 60; i++) {
    g.step(hoverCmd);
    if (i * DT > 3) { errMax = Math.max(errMax, Math.abs(P.pos.y - 60)); tiltMax = Math.max(tiltMax, Math.acos(P.up.y)); }
  }
  const endurance = P.battery.wh / P.battery.powerW * 60;
  check('hover 60 s in gusty wind', errMax < 1.5 && tiltMax < 0.25, `alt error ≤ ${errMax.toFixed(2)} m, tilt ≤ ${(tiltMax * 57.3).toFixed(1)}°, ${P.battery.powerW.toFixed(0)} W`);
  check('hover endurance ≥ 20 min', endurance > 20, `${endurance.toFixed(1)} min of hover left after the test`);
}

// 2. top speed per difficulty: 1.00 / 1.10 / 1.20 / 1.25 × the player
{
  const g = await open(), out = [];
  g.weather.ambient = () => v3(); // airframe test: still air
  Object.entries(DIFFICULTY).forEach(([k, d], i) => {
    const dr = new Drone(g.world, { pos: v3(-1600, 350, -1300 + i * 250), heading: Math.PI / 2, speed: d.speed });
    dr.rand = g.r; g.drones.push(dr); out.push({ k, d, dr, vmax: 0 });
  });
  for (let i = 0; i * DT < 25; i++) {
    for (const o of out) o.dr.control({ v: v3(90, 0, 0), vz: 0, heading: Math.PI / 2 }, DT);
    g.step(hoverCmd);
    if (i * DT > 12) for (const o of out) o.vmax = Math.max(o.vmax, len(flat(o.dr.vel)));
  }
  const base = out[0].vmax;
  const worst = Math.max(...out.map(o => Math.abs(o.vmax / base - o.d.speed)));
  check('hunter top speed matches difficulty', worst < 0.03, out.map(o => `${o.k} ${o.vmax.toFixed(1)} m/s (${(o.vmax / base).toFixed(2)}×)`).join(', '));
}

// 2b. flight modes: ANGLE tilts in proportion to the stick; ACRO can barrel-roll and come back level
{
  const g = await open(), P = g.player;
  const reset = () => { place(g, P, v3(-1500, 300, -1500)); P.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true); };
  const rows = [];
  for (const stick of [0.25, 0.5, 1]) {
    reset();
    for (let i = 0; i * DT < 10; i++) g.step({ mode: 'angle', tilt: { fwd: stick, right: 0 }, vz: 0, heading: 0 });
    rows.push({ stick, tilt: Math.acos(P.up.y) * 57.3, speed: len(flat(P.vel)), alt: P.pos.y });
  }
  const ok = rows.every(r => Math.abs(r.tilt - r.stick * 60) < 3 && Math.abs(r.alt - 300) < 3) && rows[0].speed < rows[1].speed && rows[1].speed < rows[2].speed;
  check('ANGLE mode: tilt follows the stick', ok, rows.map(r => `stick ${r.stick} → ${r.tilt.toFixed(0)}°, ${r.speed.toFixed(0)} m/s`).join(' | '));
  reset();
  const hover = P.mass * 9.81 / (4 * 20);
  for (let i = 0; i * DT < 1; i++) g.step({ mode: 'acro', rates: { pitch: 0, roll: 0, yaw: 0 }, throttle: hover });
  const y0 = P.pos.y; let minUp = 1;
  for (let i = 0; i * DT < 2 * Math.PI / 4; i++) { g.step({ mode: 'acro', rates: { pitch: 0, roll: 4, yaw: 0 }, throttle: 0.75 }); minUp = Math.min(minUp, P.up.y); }
  for (let i = 0; i * DT < 0.3; i++) g.step({ mode: 'acro', rates: { pitch: 0, roll: 0, yaw: 0 }, throttle: hover });
  check('ACRO mode: barrel roll', minUp < -0.9 && P.up.y > 0.95, `inverted (up.y ${minUp.toFixed(2)}), back level (up.y ${P.up.y.toFixed(2)}), lost ${(y0 - P.pos.y).toFixed(0)} m`);
}

// 3. damage: half a rotor still flies; a lost rotor brings a quad down
{
  const g = await open(), P = g.player;
  place(g, P, v3(1700, 80, 1700));
  P.rotors[0].health = 0.5;
  let errMax = 0;
  for (let i = 0; i * DT < 15; i++) { g.step(hoverCmd); if (i * DT > 4) errMax = Math.max(errMax, Math.abs(P.pos.y - 80)); }
  check('hover with one rotor at 50%', errMax < 3, `alt error ≤ ${errMax.toFixed(2)} m: the mixer re-balances the other three`);
  P.rotors[0].health = 0;
  const y0 = P.pos.y;
  for (let i = 0; i * DT < 4; i++) g.step(hoverCmd);
  check('a destroyed rotor brings it down', y0 - P.pos.y > 15, `fell ${(y0 - P.pos.y).toFixed(0)} m in 4 s (an X-quad can't hold attitude on three)`);
}

// 4. helicopter downwash pushes you down (and the wind field is real physics, not a script)
{
  const g = await open(), P = g.player, h = g.helis[0];
  h.speed = 0; // hovering helicopter
  const hp = heliPose(h, 0).p;
  place(g, P, add(hp, v3(2, -9, 0)));
  const y0 = P.pos.y; let minY = y0, tilt = 0;
  const wash = g.windAt(P.pos).y;
  for (let i = 0; i * DT < 2; i++) { g.step({ v: v3(), vz: 0, heading: 0 }); minY = Math.min(minY, P.pos.y); tilt = Math.max(tilt, Math.acos(P.up.y)); }
  check('downwash under a hovering helicopter', y0 - minY > 2, `air ${wash.toFixed(1)} m/s: pushed down ${(y0 - minY).toFixed(1)} m in 2 s, knocked to ${(tilt * 57.3).toFixed(0)}° tilt`);
}

// 5. the hunter finds and shoots a hovering target in the open
{
  const g = await open({ hunters: 1 }), P = g.player, H = g.hunters[0];
  place(g, P, v3(g.server.x, g.server.y + 60, g.server.z));
  let firstHit = null;
  for (let i = 0; i * DT < 60 && firstHit === null; i++) {
    const ev = g.step({ v: v3(), vz: 0, heading: 0 });
    if (ev.some(e => e.type === 'hit' && e.who === P)) firstHit = i * DT;
  }
  check('hunter finds + hits a sitting target', firstHit !== null, `first hit at ${firstHit?.toFixed(1) ?? 'never'} s (spawned ${dist(H.d.pos, P.pos).toFixed(0)} m away at the end)`);
}

// 6. lost contact -> climbs to look down, searches where you were heading
{
  const g = await open({ hunters: 1 }), P = g.player, H = g.hunters[0];
  place(g, P, v3(-1800, 3, -1800)); // far away and on the deck: nothing sees it
  H.lkp = { pos: add(H.d.pos, v3(150, -120, 0)), vel: v3(10, 0, 0), t: 0, src: 'RADAR' };
  H.seenAt = 0; H.mode = 'SEARCH'; H.searchT = 0;
  let maxY = 0, modes = new Set();
  for (let i = 0; i * DT < 25; i++) { g.step(hoverCmd); maxY = Math.max(maxY, H.d.pos.y); modes.add(H.mode); }
  check('lost track -> climbs and searches', modes.has('SEARCH') && maxY > 135, `modes ${[...modes].join('/')}, climbed to ${maxY.toFixed(0)} m to look down`);
}

// 6b. can't fly any more -> DOWNED: the hunter comes all the way in, and only then it's over
for (const [label, cripple] of [['rotor shot off', P => { P.rotors[2].health = 0; }], ['battery dead', P => { P.battery.wh = 0; }]]) {
  const g = await open({ hunters: 1 }), P = g.player;
  place(g, P, v3(g.server.x + 60, 40, g.server.z + 60));
  cripple(P);
  let downedAt = null, endAt = null, closest = Infinity;
  for (let i = 0; i * DT < 150 && !g.ended; i++) {
    for (const e of g.step(hoverCmd)) { if (e.type === 'downed') downedAt = g.time; if (e.type === 'end') endAt = g.time; }
    if (downedAt !== null) closest = Math.min(closest, dist(g.hunters[0].d.pos, P.pos));
  }
  check(`downed (${label}) -> hunter confirms`, downedAt !== null && endAt !== null && closest < 8 && g.hunters[0].mode === 'CONFIRM',
    `downed at ${downedAt?.toFixed(1)} s, hunter came within ${closest.toFixed(1)} m, game over at ${endAt?.toFixed(1) ?? 'never'} s (${g.status})`);
}

// 7. Monte Carlo: an autopilot player tries to escape the full swarm for each difficulty
// (3 / 9 / 18 / 27 hunters). No hunter may fly into anything, including each other,
// and none may shoot a wingman.
const SEEDS = +process.env.SEEDS || 3;
for (const diff of Object.keys(DIFFICULTY)) {
  const tally = {};
  let impacts = 0, friendly = 0, closest = Infinity, secs = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = await Game.create({ seed: seed * 7 + diff.length, difficulty: diff });
    const ev = new Evader(g), H = g.hunters.map(h => h.d);
    for (let i = 0; i * DT < 150 && !g.ended; i++) {
      const t = i * DT;
      const evs = g.step(t < 1 ? { v: v3(), vz: 4, heading: 0 } : ev.command(t));
      for (const e of evs) {
        if (e.type === 'impact' && e.who !== g.player) impacts++;
        if (e.type === 'hit' && e.who !== g.player && e.by !== g.player) friendly++;
      }
      if (i % 12 === 0) for (let a = 0; a < H.length; a++) for (let b = a + 1; b < H.length; b++) if (H[a].alive && H[b].alive) closest = Math.min(closest, dist(H[a].pos, H[b].pos));
    }
    secs += g.time;
    tally[g.status] = (tally[g.status] ?? 0) + 1;
  }
  const d = DIFFICULTY[diff];
  check(`${d.label.padEnd(6)} ${String(d.hunters).padStart(2)} hunters × ${SEEDS} games`, impacts === 0 && friendly === 0,
    `crashes ${impacts}, friendly fire ${friendly}, closest wingmen ${closest.toFixed(1)} m | ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')} | avg ${(secs / SEEDS).toFixed(0)} s`);
}

const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
