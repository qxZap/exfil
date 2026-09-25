// Audit: can a hunter really see you when it says so, and does it get round buildings?
// node audit-sight.mjs   (SEEDS=n, SECS=n)
import { Game, DT, v3, dist, sub, len, norm, add, mul, flat, Evader, RAPIER } from './sim.js';

const SEEDS = +process.env.SEEDS || 3, SECS = +process.env.SECS || 90;
const SOLID = ((0xffff << 16) | 1) >>> 0;
// truth: every ray from the hunter to 7 points on/around the player is blocked more than 1 m short
function blocked(g, h, p) {
  const a = h.d.pos;
  for (const o of [v3(), v3(0.3, 0, 0), v3(-0.3, 0, 0), v3(0, 0.3, 0), v3(0, -0.3, 0), v3(0, 0, 0.3), v3(0, 0, -0.3)]) {
    const b = add(p, o), d = sub(b, a), L = len(d);
    const hit = g.world.castRay(new RAPIER.Ray(a, mul(d, 1 / L)), L, true, undefined, SOLID, undefined, h.d.body);
    if (!hit || hit.timeOfImpact > L - 1) return false;
  }
  return true;
}

function instrument(g) {
  const log = { throughWall: [], sightings: 0, clutterRoof: 0, stuck: [], impacts: 0, goals: new Map() };
  for (const h of g.hunters) {
    const orig = h.sensors.tracks.set.bind(h.sensors.tracks);
    h.sensors.tracks.set = (tg, k) => {
      if (k.src === 'CAMERA' || k.src === 'RADAR') {
        log.sightings++;
        if (blocked(g, h, tg.pos)) log.throughWall.push({ t: g.time, h: h.d.name, src: k.src, r: Math.round(dist(h.d.pos, tg.pos)) });
        if (k.src === 'RADAR' && tg.agl < 4 && tg.pos.y > 20) log.clutterRoof++; // low over a roof: should be in clutter
      }
      return orig(tg, k);
    };
    const steer = h.nav.steer.bind(h.nav);
    h.nav.steer = (goal, ...rest) => { log.goals.set(h, goal); return steer(goal, ...rest); };
  }
  return log;
}

// stuck: moved < 8 m in 6 s while its goal is > 40 m away (not holding a slot / confirming)
function watchStuck(g, log) {
  const hist = new Map();
  return () => {
    for (const h of g.hunters) {
      if (!h.d.alive || h.mode === 'CONFIRM' || h.mode === 'LANDING') { hist.delete(h); continue; }
      const goal = log.goals.get(h); if (!goal) continue;
      const q = hist.get(h) ?? []; q.push({ t: g.time, p: h.d.pos }); while (q.length && g.time - q[0].t > 6) q.shift(); hist.set(h, q);
      if (g.time - q[0].t > 5.9 && dist(q[0].p, h.d.pos) < 8 && dist(h.d.pos, goal) > 40 && !h._stuckLogged) {
        h._stuckLogged = true;
        log.stuck.push({ t: Math.round(g.time), h: h.d.name, mode: h.mode, p: [h.d.pos.x, h.d.pos.y, h.d.pos.z].map(Math.round), goal: Math.round(dist(h.d.pos, goal)), clear: h.nav.scan?.clear?.toFixed(1) });
      }
      if (dist(q[0].p, h.d.pos) > 20) h._stuckLogged = false;
    }
  };
}

let bad = 0;
const report = (name, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`); };

// 1. real games, player on the evader autopilot
for (let s = 1; s <= SEEDS; s++) {
  const g = await Game.create({ seed: 100 + s, difficulty: 'normal' }), ev = new Evader(g), log = instrument(g), stuck = watchStuck(g, log);
  for (let i = 0; i * DT < SECS && g.status === 'play'; i++) {
    const evs = g.step(ev.command(g.time));
    log.impacts += evs.filter(e => e.type === 'impact' && e.who !== g.player).length;
    if (i % 12 === 0) stuck();
  }
  report(`seed ${100 + s}: no sightings through walls`, !log.throughWall.length, `${log.sightings} camera/radar sightings, ${log.throughWall.length} through walls ${JSON.stringify(log.throughWall.slice(0, 3))}`);
  report(`seed ${100 + s}: no stuck hunters`, !log.stuck.length && !log.impacts, `${log.stuck.length} stuck ${JSON.stringify(log.stuck.slice(0, 3))}, ${log.impacts} hunter impacts, ended ${g.status} at ${g.time.toFixed(0)} s`);
  if (log.clutterRoof) console.log(`      note: ${log.clutterRoof} radar fixes on a target < 4 m over a roof`);
}

// 2. round the block: player hides at street level behind a tall building; the hunter starts on
//    the far side at the same height and is told where the player is (a stale link fix)
{
  const g = await Game.create({ seed: 7, hunters: 1 }), H = g.hunters[0], P = g.player;
  const b = g.city.buildings.filter(b => b.kind === 'tower' && b.hy > 40 && Math.hypot(b.x, b.z) < 900).sort((a, c) => c.hy - a.hy)[0];
  const place = (d, p) => { d.body.setTranslation(p, true); d.body.setLinvel(v3(), true); d.body.setAngvel(v3(), true); };
  const side = Math.max(b.hx, b.hz) + 14;
  place(P, v3(b.x + b.hx + 8, 10, b.z)); place(H.d, v3(b.x - side - 30, 10, b.z));
  H.lkp = { pos: P.pos, vel: v3(), t: 0, src: 'RADAR' }; H.seenAt = 0; H.mode = 'SEARCH'; H.searchT = 0;
  const log = instrument(g), stuck = watchStuck(g, log);
  let firstOwn = null, minR = 1e9;
  for (let i = 0; i * DT < 60 && firstOwn === null; i++) {
    g.step({ v: v3(), vz: 0, heading: 0 });
    if (i % 12 === 0) stuck();
    minR = Math.min(minR, dist(H.d.pos, P.pos));
    const k = H.sensors.tracks.get(P); if (k && (k.src === 'CAMERA' || k.src === 'RADAR')) firstOwn = g.time;
  }
  report('round the block: hunter regains sight', firstOwn !== null && !log.throughWall.length && !log.stuck.length,
    `tower ${Math.round(b.hy * 2)} m tall; own sight after ${firstOwn?.toFixed(1) ?? 'never'} s, closest ${minR.toFixed(0)} m, ${log.stuck.length} stuck, ${log.throughWall.length} through walls`);
}

// 3. hiding works: a player parked in a street canyon with no line of sight is never "seen"
{
  const g = await Game.create({ seed: 3, hunters: 1 }), H = g.hunters[0], P = g.player;
  const log = instrument(g);
  const place = (d, p) => { d.body.setTranslation(p, true); d.body.setLinvel(v3(), true); d.body.setAngvel(v3(), true); };
  const b = g.city.buildings.filter(b => b.kind === 'tower' && b.hy > 50).sort((a, c) => Math.hypot(a.x, a.z) - Math.hypot(c.x, c.z))[0];
  place(P, v3(b.x + b.hx + 5, 6, b.z));
  let blind = 0, seenBlind = 0;
  for (let i = 0; i * DT < 20; i++) {
    place(H.d, v3(b.x - b.hx - 40, 30, b.z + Math.sin(i * DT) * 20)); // hovering behind the tower, 120 m radar
    H.sensors.lookDir = norm(sub(P.pos, H.d.pos));
    g.step({ v: v3(), vz: 0, heading: 0 });
    if (blocked(g, H, P.pos)) { blind++; const k = H.sensors.tracks.get(P); if (k && k.t === g.time - DT && k.src !== 'ACOUSTIC') seenBlind++; }
  }
  report('hidden behind a tower: not seen', blind > 0 && !log.throughWall.length, `${blind} blocked steps, ${log.throughWall.length} sightings through the tower`);
}
console.log(bad ? `\n${bad} audit check(s) failed` : '\nall audit checks passed');
