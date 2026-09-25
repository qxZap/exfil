// The enemy radio net, intercepted. Nobody helps you: all you hear is the hunters talking to each
// other, and what they say is what their AI is actually doing (contact, lost contact, searching,
// engaging, a wingman down, low battery, confirming the kill). Every transmission also gives you a
// direction-finding (DF) bearing to the hunter that keyed the mic, even if you can't see it.
import { dist } from './sim.js';

const compass = (from, to) => Math.round(((Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI) + 360) % 360) % 360;
const digits = n => String(n).padStart(3, '0').split('').map(d => `d${d}`);
const rangeTokens = m => m >= 1000 ? ['thousand'] : [`d${Math.max(1, Math.round(m / 100))}`, 'hundred'];
const TEXT = {
  hunter: 'Hunter', radar_contact: 'radar contact', visual: 'visual contact', acoustic: 'acoustic contact, bearing only', bearing: 'bearing',
  range: 'range', hundred: 'hundred', thousand: 'one thousand plus', converge: 'all units converge', copy: 'copy', roger: 'roger',
  wilco: 'wilco, moving', engaging: 'engaging', check_fire: 'check fire, friendly in line', lost: 'lost contact',
  searching: 'searching last known', climbing: 'climbing to search altitude', enroute: 'en route to the rooftop',
  target_down: 'target is down, moving to confirm', confirmed: 'confirmed. package recovered.', is_down: 'is down',
  taking_fire: 'taking fire', im_hit: "I'm hit", low_battery: 'low battery, landing', new_lead: 'I have the lead', out: 'out',
  going_dark: 'no joy, going wide',
};
const say = tokens => tokens.map(t => t === ',' ? ',' : /^d\d$/.test(t) ? (t === 'd9' ? 'niner' : t[1]) : /^n\d+$/.test(t) ? t.slice(1) : TEXT[t] ?? t)
  .join(' ').replace(/ ,/g, ',').replace(/(\d) (?=\d)/g, '$1');

export class RadioNet {
  constructor(audio, log) { this.audio = audio; this.log = log; this.reset(); }
  reset() { this.queue = []; this.busyUntil = 0; this.df = []; this.st = new Map(); this.lead = null; this.linkLive = false; this.lostAt = null; this.said = new Set(); }

  tx(hunter, tokens, { key = null, priority = false } = {}) {
    if (key) { if (this.said.has(key)) return; this.said.add(key); }
    const item = { hunter, tokens: ['hunter', `n${hunter.i + 1}`, ',', ...tokens], at: performance.now() / 1000, mode: hunter.mode };
    priority ? this.queue.unshift(item) : this.queue.push(item);
    if (this.queue.length > 4) this.queue.length = 4; // radio discipline: old chatter gets dropped
  }

  update(game, now) {
    const P = game.player, t = game.time, H = game.hunters, live = H.filter(h => h.d.alive);
    const st = h => { if (!this.st.has(h)) this.st.set(h, { mode: h.mode, hull: h.d.hull, alive: h.d.alive, fired: false }); return this.st.get(h); };
    // the first two hunters check in on the way to the roof
    if (t > 2) live.slice(0, 2).forEach((h, k) => this.tx(h, k ? ['copy', ',', 'enroute'] : ['enroute'], { key: `enroute${k}` }));
    // a hunter takes the lead on the shared track: contact report
    const link = game.link && t - game.link.t < 1.0 ? game.link : null;
    if (link && link.by !== this.lead && link.by.d.alive) {
      const h = link.by, src = { RADAR: 'radar_contact', CAMERA: 'visual', ACOUSTIC: 'acoustic' }[link.src] ?? 'radar_contact';
      const r = dist(h.d.pos, P.pos);
      this.tx(h, [this.linkLive ? 'new_lead' : src, ',', 'bearing', ...digits(compass(h.d.pos, P.pos)), ',', 'range', ...rangeTokens(r), ',', 'converge'], { priority: !this.linkLive });
      const mate = live.filter(x => x !== h).sort((a, b) => dist(a.d.pos, h.d.pos) - dist(b.d.pos, h.d.pos))[0];
      if (mate && !this.linkLive) this.tx(mate, ['wilco']);
      this.lead = h; this.linkLive = true; this.lostAt = null;
    }
    // the net loses you
    if (!link && this.linkLive) { this.linkLive = false; this.lostAt = t; if (this.lead?.d.alive) this.tx(this.lead, ['lost', ',', 'searching']); this.lead = null; }
    if (this.lostAt !== null && t - this.lostAt > 6) {
      const h = live.find(x => x.mode === 'SEARCH'); if (h) this.tx(h, ['climbing']); this.lostAt = null;
    }
    for (const h of H) {
      const s = st(h);
      if (h.d.firing && !s.fired) { s.fired = true; this.tx(h, ['engaging']); }
      if (h.mode !== 'CHASE') s.fired = false;
      if (h.d.hull < s.hull && h.d.alive && !s.hitSaid) { s.hitSaid = true; this.tx(h, ['im_hit'], { priority: true }); }
      if (s.alive && !h.d.alive) {
        if (h.d.landed) this.tx(h, ['low_battery']);
        else { const m = live.sort((a, b) => dist(a.d.pos, h.d.pos) - dist(b.d.pos, h.d.pos))[0]; if (m) this.tx(m, ['hunter', `n${h.i + 1}`, 'is_down', ',', 'taking_fire'], { priority: true }); }
      }
      if (/line of fire/.test(h.thought) && !(s.checkAt > t - 20)) { s.checkAt = t; this.tx(h, ['check_fire']); }
      s.hull = h.d.hull; s.alive = h.d.alive; s.mode = h.mode;
    }
    // endgame
    if (game.status === 'downed') { const c = live.find(h => h.mode === 'CONFIRM'); if (c) this.tx(c, ['target_down'], { key: 'down', priority: true }); }
    if (game.ended && (game.status === 'destroyed' || game.status === 'battery')) { const c = live[0]; if (c) this.tx(c, ['confirmed', ',', 'out'], { key: 'confirmed', priority: true }); }
    if (game.status === 'escaped') { const c = live[0]; if (c) this.tx(c, ['going_dark', ',', 'out'], { key: 'escaped', priority: true }); }
    // key the next transmission when the channel is free; you get a DF bearing on whoever keyed it
    this.df = this.df.filter(d => now - d.at < 6);
    if (this.queue.length && now > this.busyUntil) {
      const m = this.queue.shift();
      // stale chatter is never sent: too old, or the hunter has moved on to something else
      if (now - m.at > 7 || (m.tokens.includes('enroute') && m.hunter.mode !== 'TRANSIT')) return;
      if (game.status !== 'play' && !m.tokens.some(k => ['target_down', 'confirmed', 'going_dark'].includes(k))) return; // once it's decided, only the endgame calls
      if (!m.hunter.d.alive && !m.hunter.d.landed && m.tokens[3] !== 'hunter') return;
      const d = dist(m.hunter.d.pos, P.pos), err = (Math.random() - 0.5) * 2 * (3 + d / 120);
      const quality = Math.max(0.15, 1 - d / 1600);
      const dur = this.audio.transmit(m.tokens, { quality }) ?? 2;
      this.busyUntil = now + dur + 0.6;
      const brg = (compass(P.pos, m.hunter.d.pos) + err + 360) % 360;
      this.df.push({ bearing: brg, at: now, name: m.hunter.d.name });
      this.log('INTERCEPT', `${say(m.tokens)}`, `DF ${String(Math.round(brg)).padStart(3, '0')}°`);
    }
  }
}
