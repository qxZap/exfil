// The hunter monitor: every hunter's camera, live, with an animated targeting overlay driven by its
// AI state, and what it's deciding. It rebuilds the same city from the game's seed and replays the
// state the game streams to /stream; it never simulates anything itself.
import * as THREE from 'three';
import { Game } from './sim.js';
import { createWorld } from './world.js';
import { Audio } from './audio.js';
import { RadioNet } from './radio.js';

const $ = id => document.getElementById(id);
const BAR = 44;
const canvas = $('view'), hud = $('hud'), g2 = hud.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.85;
renderer.autoClear = false;
const mainCam = new THREE.PerspectiveCamera(70, 1, 0.1, 6000);
const world = createWorld({ renderer, camera: mainCam });
let W = 0, H = 0;
function resize() {
  W = innerWidth; H = innerHeight - BAR;
  renderer.setSize(W, H); hud.width = W * devicePixelRatio; hud.height = H * devicePixelRatio; hud.style.width = W + 'px'; hud.style.height = H + 'px';
  g2.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  world.resize(W, H);
}
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- voices: the hunters' own radio net
// (browsers only allow sound after a click: the button in the bar turns it on)
const audio = new Audio();
const radioLines = [];
const radio = new RadioNet(audio, (from, text, df) => {
  radioLines.push({ text }); if (radioLines.length > 6) radioLines.shift();
  $('radioLog').innerHTML = radioLines.map(l => `<div>${l.text}</div>`).join('');
});
function startRadio() { audio.start(); $('audioBtn').textContent = 'radio: on'; $('soundHint').style.display = 'none'; }
let swallowClick = false;
addEventListener('pointerdown', e => { if (!audio.ctx) { startRadio(); swallowClick = e.target === canvas || e.target === $('audioBtn'); } }, true);
$('audioBtn').onclick = () => { if (swallowClick) return; audio.muted = !audio.muted; $('audioBtn').textContent = `radio: ${audio.muted ? 'off' : 'on'}`; };

// ---------------------------------------------------------------- live state
let game = null, key = null, snap = null, building = false;
window.monitor = { get key() { return key; }, get snap() { return snap; }, get audio() { return audio; }, get history() { return history; } };
const history = new Map(); // hunter index -> [{ t, text, mode }]
const target = new Map();  // drone -> { p, q } latest pose from the feed
const es = new EventSource('/stream');
es.onopen = () => { $('conn').textContent = 'connected'; $('conn').style.color = 'var(--hud)'; };
es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').style.color = 'var(--warn)'; };
es.onmessage = async e => {
  let s; try { s = JSON.parse(e.data); } catch { return; }
  if (!s || !s.seed || !s.diff || !Array.isArray(s.hunters)) return; // ignore anything that isn't a game snapshot
  const k = `${s.seed}:${s.diff}`;
  if (k !== key && !building) { // a new game: rebuild the same city from its seed
    building = true; $('wait').textContent = 'Building the city…';
    await world.ensureModels();
    game = await Game.create({ seed: s.seed, difficulty: s.diff });
    world.build(game); history.clear(); target.clear(); radio.reset(); radioLines.length = 0; key = k; building = false;
    $('wait').style.display = 'none';
  }
  if (!game || building) return;
  snap = s; apply(s);
};
const clean = t => t.replace(/[\d.]+/g, '#');
function apply(s) {
  game.time = s.t; game.status = s.status; game.ended = s.ended;
  game.link = s.link && game.hunters[s.link.by] ? { by: game.hunters[s.link.by], src: s.link.src, t: s.t - s.link.age, pos: { x: s.link.p[0], y: s.link.p[1], z: s.link.p[2] } } : null;
  const pose = (d, x) => { target.set(d, { p: x.p, q: x.q }); x.w.forEach((w, k) => (d.rotors[k].w = w)); };
  pose(game.player, s.player); game.player.alive = s.player.alive;
  s.hunters.forEach((x, i) => {
    const h = game.hunters[i]; if (!h) return;
    pose(h.d, x);
    h.d.alive = x.alive; h.d.landed = x.landed; h.d.hull = x.hull; h.d.firing = x.firing; h.mode = x.mode; h.thought = x.thought; h.x = x;
    h.sensors.lookDir = { x: x.look[0], y: x.look[1], z: x.look[2] };
    const list = history.get(i) ?? []; // a decision log: every time what it's thinking changes in kind
    if (!list.length || clean(list[list.length - 1].text) !== clean(x.thought)) { list.push({ t: s.t, text: x.thought, mode: x.mode }); if (list.length > 60) list.shift(); }
    else list[list.length - 1].text = x.thought;
    history.set(i, list);
  });
  game.rounds = s.rounds.map(r => ({ p: { x: r[0], y: r[1], z: r[2] }, v: { x: r[3], y: r[4], z: r[5] }, owner: r[6] ? game.player : null }));
  $('info').textContent = `${game.diff.label} · ${s.n} hunters (${s.hunters.filter(h => h.alive).length} up) · t ${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')} · ${s.status}${s.status === 'downed' ? ` (closest ${Math.round(s.closing)} m)` : ''}`;
}

// ---------------------------------------------------------------- layout + input
let layout = 9, focus = null, shadows = false, rr = 0;
for (const l of world.csm.lights) l.castShadow = false; // off by default here: many views
document.querySelectorAll('#layouts button').forEach(b => b.onclick = () => { layout = +b.dataset.n; focus = null; document.querySelectorAll('#layouts button').forEach(x => x.classList.toggle('sel', x === b)); });
$('shadowsBtn').onclick = () => { shadows = !shadows; for (const l of world.csm.lights) l.castShadow = shadows; $('shadowsBtn').textContent = `shadows: ${shadows ? 'on' : 'off'}`; };
addEventListener('keydown', e => { if (e.key === 'Escape') focus = null; });
let tiles = [];
canvas.addEventListener('click', e => {
  if (swallowClick) { swallowClick = false; return; } // that click just turned the radio on
  if (focus !== null) { focus = null; return; }
  const t = tiles.find(t => e.clientX >= t.x && e.clientX < t.x + t.w && e.clientY - BAR >= t.y && e.clientY - BAR < t.y + t.h);
  if (t) focus = t.i;
});
const MODE_ORDER = { CHASE: 0, CONFIRM: 1, SEARCH: 2, LANDING: 3, TRANSIT: 4, DOWN: 5 };
const MODE_COL = { CHASE: '#ff4a4a', CONFIRM: '#b07cff', SEARCH: '#ffb020', TRANSIT: '#9dffc6', LANDING: '#8f9aa6', DOWN: '#555' };
const boardW = () => Math.min(360, Math.max(260, W * 0.24));
function pickTiles() {
  if (focus !== null) { const panel = Math.min(420, W * 0.34); return [{ i: focus, x: 0, y: 0, w: W - panel, h: H, big: true }]; }
  const P = game.player.pos;
  const order = game.hunters.map((h, i) => i).sort((a, b) => {
    const A = game.hunters[a], B = game.hunters[b];
    return (MODE_ORDER[A.mode] ?? 9) - (MODE_ORDER[B.mode] ?? 9) || Math.hypot(A.d.pos.x - P.x, A.d.pos.z - P.z) - Math.hypot(B.d.pos.x - P.x, B.d.pos.z - P.z);
  }).slice(0, layout);
  const GW = W - boardW(), n = order.length, cols = Math.ceil(Math.sqrt(n * GW / H / 1.6)), rows = Math.ceil(n / cols), tw = GW / cols, th = H / rows;
  return order.map((i, k) => ({ i, x: (k % cols) * tw, y: Math.floor(k / cols) * th, w: tw, h: th }));
}

// ---------------------------------------------------------------- rendering
const cams = new Map();
const tmpQ = new THREE.Quaternion();
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!game || !snap) return;
  // glide every drone toward its latest reported pose (the feed is ~10 Hz)
  const a = 1 - Math.exp(-dt * 14);
  for (const [d, x] of target) {
    const p = d.body.translation(), q = d.body.rotation();
    d.body.setTranslation({ x: p.x + (x.p[0] - p.x) * a, y: p.y + (x.p[1] - p.y) * a, z: p.z + (x.p[2] - p.z) * a }, false);
    tmpQ.set(q.x, q.y, q.z, q.w).slerp(new THREE.Quaternion(x.q[0], x.q[1], x.q[2], x.q[3]), a);
    d.body.setRotation({ x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w }, false);
  }
  for (const b of game.rounds) { b.p.x += b.v.x * dt; b.p.y += b.v.y * dt; b.p.z += b.v.z * dt; }
  game.time += dt;
  const P = game.player.pos;
  mainCam.position.set(P.x, P.y + 60, P.z); // traffic detail follows the action
  world.update(game, dt, snap.hour);
  if (audio.ctx) audio.ctx.listener && radio.update(game, now / 1000);
  tiles = pickTiles();
  // render: the expanded view every frame; in the grid a few views per frame, round-robin
  renderer.setScissorTest(true);
  const per = focus !== null ? 1 : Math.max(2, Math.ceil(tiles.length / 3));
  for (let k = 0; k < Math.min(per, tiles.length); k++) {
    const tile = tiles[(rr + k) % tiles.length], h = game.hunters[tile.i];
    const cam = cams.get(tile.i) ?? (cams.set(tile.i, new THREE.PerspectiveCamera(62, 1, 0.3, 6000)), cams.get(tile.i));
    const c = h.d.part({ x: 0, y: -0.07, z: 0.22 }), L = h.sensors.lookDir;
    cam.position.set(c.x, c.y, c.z); cam.aspect = tile.w / tile.h; cam.updateProjectionMatrix();
    cam.lookAt(c.x + L.x * 50, c.y + L.y * 50, c.z + L.z * 50);
    const own = world.droneMeshes[game.drones.indexOf(h.d)]; if (own) own.visible = false;
    world.view(cam, { raysOn: false });
    renderer.setViewport(tile.x, H - tile.y - tile.h, tile.w, tile.h); renderer.setScissor(tile.x, H - tile.y - tile.h, tile.w, tile.h);
    renderer.clear(); renderer.render(world.scene, cam);
    if (own) own.visible = true;
  }
  rr = (rr + per) % Math.max(1, tiles.length);
  renderer.setScissorTest(false);
  // overlays
  g2.clearRect(0, 0, W, H);
  for (const tile of tiles) { overlay(tile, now / 1000); scope(tile); }
  if (focus === null) board();
  if (focus !== null) panel(focus, now / 1000);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- targeting overlay (per view)
function project(cam, p, tile) {
  const v = new THREE.Vector3(p.x, p.y, p.z).project(cam);
  return v.z < 1 ? { x: tile.x + (v.x + 1) / 2 * tile.w, y: tile.y + (1 - v.y) / 2 * tile.h, on: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 } : null;
}
function overlay(tile, T) {
  const h = game.hunters[tile.i], x = h.x; if (!x) return;
  const cam = cams.get(tile.i); if (!cam) return; // not rendered yet
  const col = MODE_COL[h.mode] ?? '#9dffc6', cx = tile.x + tile.w / 2, cy = tile.y + tile.h / 2, s = Math.min(tile.w, tile.h);
  const big = !!tile.big, fs = big ? 14 : Math.max(10, Math.min(12, s / 22));
  g2.save(); g2.beginPath(); g2.rect(tile.x, tile.y, tile.w, tile.h); g2.clip();
  g2.strokeStyle = col; g2.fillStyle = col; g2.lineWidth = 1.5; g2.font = `${fs}px ui-monospace, Consolas, monospace`;
  // frame corners
  const m = 8, cl = s * 0.08;
  for (const [ax, ay, dx, dy] of [[tile.x + m, tile.y + m, 1, 1], [tile.x + tile.w - m, tile.y + m, -1, 1], [tile.x + m, tile.y + tile.h - m, 1, -1], [tile.x + tile.w - m, tile.y + tile.h - m, -1, -1]]) {
    g2.beginPath(); g2.moveTo(ax + dx * cl, ay); g2.lineTo(ax, ay); g2.lineTo(ax, ay + dy * cl); g2.stroke();
  }
  if (!x.alive) { // signal lost: static
    g2.fillStyle = 'rgba(0,0,0,.55)'; g2.fillRect(tile.x, tile.y, tile.w, tile.h);
    for (let k = 0; k < 400; k++) { g2.fillStyle = `rgba(200,200,200,${Math.random() * 0.25})`; g2.fillRect(tile.x + Math.random() * tile.w, tile.y + Math.random() * tile.h, 2, 2); }
    g2.fillStyle = x.landed ? '#8f9aa6' : '#ff4a4a'; g2.font = `bold ${fs + 4}px ui-monospace, Consolas`; g2.textAlign = 'center';
    g2.fillText(x.landed ? 'LANDED · BATTERY' : 'SIGNAL LOST', cx, cy); g2.textAlign = 'left';
  } else if (h.mode === 'CHASE' && x.trk) {
    const pt = project(cam, { x: x.trk.p[0], y: x.trk.p[1], z: x.trk.p[2] }, tile);
    const r = Math.hypot(x.trk.p[0] - h.d.pos.x, x.trk.p[1] - h.d.pos.y, x.trk.p[2] - h.d.pos.z);
    if (pt && pt.on) { // target brackets that tighten as the lock settles, lead marker when firing
      const lockT = Math.min(1, ((T * 1.7) % 3) / 1.2), b = Math.max(10, s * 0.09 * (1.6 - 0.6 * lockT) * (x.firing ? 0.8 : 1));
      g2.lineWidth = 2;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g2.beginPath(); g2.moveTo(pt.x + sx * b, pt.y + sy * b * 0.5); g2.lineTo(pt.x + sx * b, pt.y + sy * b); g2.lineTo(pt.x + sx * b * 0.5, pt.y + sy * b); g2.stroke(); }
      g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(pt.x, pt.y); g2.globalAlpha = 0.35; g2.stroke(); g2.globalAlpha = 1;
      g2.fillText(`${x.trk.src} ${Math.round(r)} m`, pt.x + b + 6, pt.y - 4);
      if (x.firing) {
        const lead = project(cam, { x: h.d.pos.x + x.aim[0] * r, y: h.d.pos.y + x.aim[1] * r, z: h.d.pos.z + x.aim[2] * r }, tile);
        if (lead) { g2.beginPath(); g2.moveTo(lead.x, lead.y - 6); g2.lineTo(lead.x + 6, lead.y); g2.lineTo(lead.x, lead.y + 6); g2.lineTo(lead.x - 6, lead.y); g2.closePath(); g2.stroke(); }
        if (Math.sin(T * 18) > 0) { g2.font = `bold ${fs + 3}px ui-monospace, Consolas`; g2.fillText('FIRE', pt.x - b, pt.y + b + fs + 4); }
      }
    } else { g2.textAlign = 'center'; g2.fillText(`${x.trk.src} TRACK · OFF-AXIS · ${Math.round(r)} m`, cx, cy + s * 0.18); g2.textAlign = 'left'; }
    reticle(cx, cy, s, col);
  } else if (h.mode === 'SEARCH') { // rotating sweep and pulsing rings
    const R = s * 0.32, a = T * 2.4;
    g2.globalAlpha = 0.5; g2.beginPath(); g2.arc(cx, cy, R, 0, Math.PI * 2); g2.stroke();
    g2.beginPath(); g2.arc(cx, cy, R * ((T * 0.8) % 1), 0, Math.PI * 2); g2.stroke(); g2.globalAlpha = 1;
    g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g2.stroke();
    g2.globalAlpha = 0.15; g2.beginPath(); g2.moveTo(cx, cy); g2.arc(cx, cy, R, a - 0.6, a); g2.closePath(); g2.fill(); g2.globalAlpha = 1;
    g2.textAlign = 'center'; g2.fillText('SEARCHING', cx, cy + R + fs + 4); g2.textAlign = 'left';
  } else if (h.mode === 'CONFIRM') { // descending chevrons
    for (let k = 0; k < 3; k++) { const y = cy - s * 0.1 + ((T * 40 + k * 22) % 66); g2.beginPath(); g2.moveTo(cx - 14, y - 7); g2.lineTo(cx, y); g2.lineTo(cx + 14, y - 7); g2.stroke(); }
    if (Math.sin(T * 6) > 0) { g2.textAlign = 'center'; g2.font = `bold ${fs + 3}px ui-monospace, Consolas`; g2.fillText('CONFIRM', cx, cy - s * 0.16); g2.textAlign = 'left'; }
    reticle(cx, cy, s, col);
  } else { // transit: heading tape
    const hdg = ((Math.atan2(h.sensors.lookDir.x, h.sensors.lookDir.z) * 180 / Math.PI) + 360) % 360, span = 60, top = tile.y + 26;
    for (let dgr = Math.floor((hdg - span) / 10) * 10; dgr <= hdg + span; dgr += 10) {
      const px = cx + (dgr - hdg) / span * tile.w * 0.35; g2.beginPath(); g2.moveTo(px, top); g2.lineTo(px, top + (dgr % 30 ? 5 : 9)); g2.stroke();
      if (dgr % 30 === 0) { g2.textAlign = 'center'; g2.fillText(String((dgr + 360) % 360).padStart(3, '0'), px, top + 20); g2.textAlign = 'left'; }
    }
    reticle(cx, cy, s, col);
  }
  // header + decision line
  g2.fillStyle = 'rgba(0,0,0,.55)'; g2.fillRect(tile.x, tile.y, tile.w, fs + 8);
  g2.fillStyle = col; g2.font = `bold ${fs}px ui-monospace, Consolas`;
  const title = `${h.d.name.toUpperCase()} · ${h.mode}${x.lead ? ' · LEAD' : ''}${x.sprint ? ' · SPRINT' : ''}`;
  g2.fillText(title, tile.x + 8, tile.y + fs + 2);
  const room = tile.w - 24 - g2.measureText(title).width;
  g2.textAlign = 'right'; g2.font = `${fs}px ui-monospace, Consolas`;
  const spd = Math.round(Math.hypot(x.vel[0], x.vel[1], x.vel[2]) * 3.6), alt = Math.round(h.d.pos.y);
  // as much of the telemetry as fits beside the title
  const stats = [`${spd} km/h · ${alt} m · bat ${Math.round(x.soc * 100)}% · hull ${x.hull}%`, `${spd} km/h · ${alt} m · bat ${Math.round(x.soc * 100)}%`, `${spd} km/h · ${alt} m`, `${spd} km/h`].find(t => g2.measureText(t).width < room);
  if (stats) g2.fillText(stats, tile.x + tile.w - 8, tile.y + fs + 2);
  g2.textAlign = 'left';
  if (!big) { // decision feed: the last few things it decided, newest at the bottom
    const list = (history.get(tile.i) ?? []).slice(-(tile.h > 300 ? 4 : tile.h > 190 ? 3 : 2)), lh = fs + 4;
    const boxH = list.length * lh + 8, y0 = tile.y + tile.h - boxH;
    g2.fillStyle = 'rgba(0,0,0,.62)'; g2.fillRect(tile.x, y0, tile.w, boxH);
    list.forEach((d, k) => {
      const newest = k === list.length - 1, ts = `${Math.floor(d.t / 60)}:${String(Math.floor(d.t % 60)).padStart(2, '0')}`;
      g2.fillStyle = newest ? '#ffffff' : 'rgba(200,210,220,.62)'; g2.font = `${newest ? 'bold ' : ''}${fs}px ui-monospace, Consolas`;
      g2.fillText(ellipsize(`${ts} ${d.text}`, tile.w - (Math.min(tile.w, tile.h) * 0.34 + 24), fs), tile.x + 8, y0 + 4 + (k + 1) * lh - 4);
    });
  }
  g2.strokeStyle = 'rgba(255,255,255,.08)'; g2.strokeRect(tile.x + 0.5, tile.y + 0.5, tile.w - 1, tile.h - 1);
  g2.restore();
}
function reticle(cx, cy, s, col) {
  const r = s * 0.035; g2.strokeStyle = col; g2.globalAlpha = 0.8;
  g2.beginPath(); g2.moveTo(cx - r * 2, cy); g2.lineTo(cx - r * 0.6, cy); g2.moveTo(cx + r * 0.6, cy); g2.lineTo(cx + r * 2, cy);
  g2.moveTo(cx, cy - r * 2); g2.lineTo(cx, cy - r * 0.6); g2.moveTo(cx, cy + r * 0.6); g2.lineTo(cx, cy + r * 2); g2.stroke(); g2.globalAlpha = 1;
}
function ellipsize(t, w, fs) { const n = Math.floor(w / (fs * 0.6)); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

// ---------------------------------------------------------------- expanded view: decision log + telemetry
function panel(i, T) {
  const h = game.hunters[i], x = h.x; if (!x) return;
  const pw = Math.min(420, W * 0.34), px = W - pw;
  g2.fillStyle = 'rgba(8,11,14,.94)'; g2.fillRect(px, 0, pw, H);
  let y = 24; const line = (txt, c = '#e8edf2', f = 12, gap = 17) => { g2.fillStyle = c; g2.font = `${f}px ui-monospace, Consolas`; g2.fillText(txt, px + 14, y); y += gap; };
  line(`${h.d.name.toUpperCase()}`, MODE_COL[h.mode], 18, 24);
  line(`mode ${h.mode}${x.lead ? ' · holds the lead on the data link' : ''}`, MODE_COL[h.mode]);
  line(`now: ${h.thought}`, '#e8edf2', 12, 22);
  const tel = [
    ['speed', `${Math.round(Math.hypot(...x.vel) * 3.6)} km/h${x.sprint ? ' (sprint, head-first)' : ''}`],
    ['altitude', `${Math.round(h.d.pos.y)} m`],
    ['battery', `${Math.round(x.soc * 100)}% · ${x.power} W`], ['hull', `${x.hull}%`],
    ['track', x.trk ? `${x.trk.src}${x.trk.own ? '' : ' (from wingman)'} · ${x.trk.age.toFixed(1)} s old` : 'none'],
    ['clearance ahead', x.clear != null ? `${x.clear} m` : '-'], ['downwash on path', x.wash > 0.5 ? `${x.wash.toFixed(1)} m/s` : 'none'],
    ['gun', x.firing ? 'FIRING (lead solution)' : 'safe'],
  ];
  for (const [k, v] of tel) line(`${k.padEnd(17)} ${v}`, '#b9c3cd');
  const R = Math.min(pw / 2 - 30, 120);
  drawScope(h, x, px + pw / 2, H - R - 16, R);
  const limit = H - 2 * R - 40;
  y += 8; line('DECISIONS', '#9dffc6', 13, 20);
  const list = (history.get(i) ?? []).slice().reverse();
  for (const d of list) {
    if (y > limit) break;
    const words = `${Math.floor(d.t / 60)}:${String(Math.floor(d.t % 60)).padStart(2, '0')}  ${d.mode.padEnd(8)} ${d.text}`;
    for (const chunk of wrap(words, pw - 28, 12)) { if (y > limit) break; line(chunk, MODE_COL[d.mode] ?? '#b9c3cd', 12, 16); }
    y += 3;
  }
}
function wrap(t, w, fs) { const n = Math.floor(w / (fs * 0.6)), out = []; for (let k = 0; k < t.length; k += n) out.push((k ? '         ' : '') + t.slice(k, k + n)); return out; }

// ---------------------------------------------------------------- decision board: every hunter, what it's deciding
function board() {
  const bw = boardW(), bx = W - bw;
  g2.fillStyle = 'rgba(8,11,14,.94)'; g2.fillRect(bx, 0, bw, H);
  g2.fillStyle = '#9dffc6'; g2.font = 'bold 13px ui-monospace, Consolas'; g2.fillText('DECISIONS · every hunter', bx + 12, 20);
  const order = game.hunters.map((h, i) => i).sort((a, b) => (MODE_ORDER[game.hunters[a].mode] ?? 9) - (MODE_ORDER[game.hunters[b].mode] ?? 9) || a - b);
  let y = 40;
  for (const i of order) {
    const h = game.hunters[i], list = history.get(i) ?? [], last = list[list.length - 1];
    if (y > H - 30) { g2.fillStyle = 'rgba(200,210,220,.5)'; g2.font = '11px ui-monospace, Consolas'; g2.fillText(`+ ${order.length - order.indexOf(i)} more`, bx + 12, H - 10); break; }
    const col = h.x?.alive === false ? '#666' : MODE_COL[h.mode] ?? '#9dffc6', ago = last ? Math.max(0, Math.round(game.time - last.t)) : 0;
    g2.fillStyle = col; g2.font = 'bold 12px ui-monospace, Consolas';
    g2.fillText(`${h.d.name.toUpperCase()} · ${h.mode}${h.x?.lead ? ' · LEAD' : ''}`, bx + 12, y);
    g2.fillStyle = 'rgba(200,210,220,.55)'; g2.font = '10px ui-monospace, Consolas'; g2.textAlign = 'right'; g2.fillText(`${ago}s`, W - 10, y); g2.textAlign = 'left';
    g2.fillStyle = '#dfe6ec'; g2.font = '11px ui-monospace, Consolas';
    const lines = wrapWords(h.thought ?? '', bw - 26, 11).slice(0, 2);
    lines.forEach((l, k) => g2.fillText(l, bx + 12, y + 14 + k * 13));
    y += 18 + lines.length * 13 + 6;
    g2.strokeStyle = 'rgba(255,255,255,.06)'; g2.beginPath(); g2.moveTo(bx + 8, y - 8); g2.lineTo(W - 8, y - 8); g2.stroke();
  }
}
function wrapWords(t, w, fs) {
  const n = Math.floor(w / (fs * 0.6)), out = []; let cur = '';
  for (const word of t.split(' ')) { if ((cur + ' ' + word).trim().length > n) { out.push(cur.trim()); cur = word; } else cur += ' ' + word; }
  if (cur.trim()) out.push(cur.trim()); return out;
}

// ---------------------------------------------------------------- each hunter's own radar scope
// Heading-up, centred on the hunter: its radar range, where its camera points, its track on you
// (red = its own sensors, orange = via the data link), its wingmen, the helicopters.
function scope(tile) {
  const h = game.hunters[tile.i], x = h.x; if (!x || !x.alive) return;
  if (tile.big) return; // the expanded view draws a large one in its panel
  const size = Math.min(tile.w, tile.h) * 0.34; if (size < 70) return;
  const R = size / 2 - 4, cx = tile.x + tile.w - size / 2 - 8, cy = tile.y + tile.h - size / 2 - 26;
  drawScope(h, x, cx, cy, R);
}
function drawScope(h, x, cx, cy, R) {
  const range = h.diff.radar, me = h.d.pos, L = h.sensors.lookDir, hd = Math.atan2(L.x, L.z);
  const pt = p => { const dx = p.x - me.x, dz = p.z - me.z, a = Math.atan2(dx, dz) - hd, r = Math.min(1, Math.hypot(dx, dz) / range) * R; return { x: cx - Math.sin(a) * r, y: cy - Math.cos(a) * r, clip: Math.hypot(dx, dz) > range }; };
  g2.save();
  g2.fillStyle = 'rgba(6,9,12,.72)'; g2.beginPath(); g2.arc(cx, cy, R + 3, 0, Math.PI * 2); g2.fill();
  g2.strokeStyle = 'rgba(157,255,198,.3)'; g2.lineWidth = 1;
  for (const k of [1, 2, 3]) { g2.beginPath(); g2.arc(cx, cy, R * k / 3, 0, Math.PI * 2); g2.stroke(); }
  // camera cone (±35°)
  g2.fillStyle = 'rgba(157,255,198,.12)'; g2.beginPath(); g2.moveTo(cx, cy); g2.arc(cx, cy, R, -Math.PI / 2 - 0.61, -Math.PI / 2 + 0.61); g2.closePath(); g2.fill();
  // radar sweep
  const sw = (performance.now() / 1000 * 2.2) % (Math.PI * 2);
  g2.strokeStyle = 'rgba(157,255,198,.45)'; g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(cx + Math.sin(sw) * R, cy - Math.cos(sw) * R); g2.stroke();
  for (const hh of game.helis) { const q = pt(hh.pose.p); if (!q.clip) { g2.fillStyle = '#ffd24a'; g2.fillRect(q.x - 2, q.y - 2, 4, 4); } }
  g2.font = '9px ui-monospace, Consolas';
  for (const w of game.hunters) { if (w === h || !w.x?.alive) continue; const q = pt(w.d.pos); if (!q.clip) { g2.fillStyle = MODE_COL[w.mode] ?? '#9dffc6'; g2.beginPath(); g2.arc(q.x, q.y, 2.2, 0, Math.PI * 2); g2.fill(); if (R > 60) g2.fillText(w.d.name, q.x + 4, q.y + 3); } }
  if (x.trk) { // what THIS hunter believes about the target (its own sensors or the data link), not the truth
    const q = pt({ x: x.trk.p[0], z: x.trk.p[2] }), d = Math.hypot(x.trk.p[0] - me.x, x.trk.p[2] - me.z);
    g2.fillStyle = x.trk.own ? '#ff4a4a' : '#ffaa3c'; g2.beginPath(); g2.arc(q.x, q.y, 4, 0, Math.PI * 2); g2.fill();
    g2.font = '10px ui-monospace, Consolas'; g2.fillText(`TGT ${Math.round(d)}m ${x.trk.own ? x.trk.src : 'link'}`, q.x + 6, q.y - 4);
  }
  g2.fillStyle = 'rgba(157,255,198,.8)'; g2.font = '10px ui-monospace, Consolas';
  g2.fillText(`${range} m`, cx - R + 2, cy + R - 2);
  // the owner: this hunter at the centre, its name on top
  const col = MODE_COL[h.mode] ?? '#9dffc6';
  g2.fillStyle = col; g2.beginPath(); g2.moveTo(cx, cy - 6); g2.lineTo(cx - 4, cy + 4); g2.lineTo(cx + 4, cy + 4); g2.fill();
  g2.font = `bold ${R > 60 ? 11 : 9}px ui-monospace, Consolas`; g2.textAlign = 'center';
  g2.fillText(`${h.d.name.toUpperCase()} RADAR`, cx, cy - R - 6); g2.textAlign = 'left';
  g2.restore();
}
