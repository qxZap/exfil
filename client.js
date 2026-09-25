// EXFIL client: rendering, HUD, input. All game logic lives in sim.js.
import * as THREE from 'three';
import { Audio } from './audio.js';
import { RadioNet } from './radio.js';
import { createWorld } from './world.js';
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
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 6000);

const world = createWorld({ renderer, camera });
const { scene, csm, clouds, rays, composer, crowd, spark, ensureModels } = world;
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); world.resize(innerWidth, innerHeight); });

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
// ---------------------------------------------------------------- game state
let game, settings = { difficulty: 'normal', seed: 0, hour: 15.5, clock: false, hourNow: 15.5 }, running = false;
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
  world.build(game);
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
  // time of day (optionally the clock runs: 1 hour per 2 minutes)
  if (settings.clock && running) settings.hourNow += dtReal * 30 / 3600;
  world.update(game, dtReal, settings.hourNow);
  perf.cars = world.perf.cars; perf.crowd = world.perf.crowd;
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
  world.view(camera);
  if (running || game.status !== 'play') { audio.update(game, camera, dtReal, { cut: held('g') }); radio.update(game, performance.now() / 1000); }
  hud();
  { const t0 = performance.now(); world.render(); perf.render = perf.render * 0.95 + (performance.now() - t0) * 0.05; }
}
requestAnimationFrame(frame);

// a city behind the menu
(async () => { $('loading').textContent = 'LOADING MODELS…'; $('loading').style.display = 'grid'; await ensureModels(); $('loading').style.display = 'none'; $('loading').textContent = 'BUILDING CITY…';
  game = await Game.create({ seed: 1, difficulty: 'easy' }); world.build(game);
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
window.exfil = { get game() { return game; }, input, start, settings, renderer, crowd, audio, radio, perf, scene, camera, csm, clouds, rays, composer };
