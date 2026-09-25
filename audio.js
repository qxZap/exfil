// EXFIL audio: everything is synthesised live with Web Audio (no sound files), driven by the
// simulation: rotor pitch from each motor's real speed, Doppler on passing hunters, gunfire that
// arrives at the speed of sound, supersonic cracks from near misses, wind from airspeed, a city and
// a war going on around you, and radio traffic.
import { dist, len, sub, dot, norm } from './sim.js';

const C = 343; // speed of sound, m/s

export class Audio {
  constructor() { this.ctx = null; this.muted = false; this.voice = true; }

  // must be called from a user gesture (browsers keep audio locked until then)
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new AudioContext();
    this.master = ctx.createGain(); this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // a city-sized echo for distant sounds: a synthetic impulse response (decaying noise)
    this.verb = ctx.createConvolver();
    const len_ = ctx.sampleRate * 2.6, ir = ctx.createBuffer(2, len_, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len_; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len_) ** 3; }
    this.verb.buffer = ir;
    this.verbIn = ctx.createGain(); this.verbIn.gain.value = 0.5;
    this.verbIn.connect(this.verb).connect(this.master);
    // shared noise buffers
    this.white = this.noiseBuffer(2, v => v);
    let last = 0; this.brown = this.noiseBuffer(4, v => (last = (last + 0.02 * v) / 1.02) * 3.5);
    this.buildOwnDrone();
    this.buildAmbience();
    this.voices = []; this.helis = [];
    this.nextWar = ctx.currentTime + 3;
  }

  noiseBuffer(sec, f) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = f(Math.random() * 2 - 1);
    return b;
  }
  loop(buf) { const s = this.ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * buf.duration); return s; }
  panner(ref = 20, rolloff = 1.2, max = 3000) {
    const p = this.ctx.createPanner();
    Object.assign(p, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: rolloff, maxDistance: max });
    return p;
  }
  at(p, x) { const t = this.ctx.currentTime; p.positionX.setTargetAtTime(x.x, t, 0.02); p.positionY.setTargetAtTime(x.y, t, 0.02); p.positionZ.setTargetAtTime(x.z, t, 0.02); }

  // ---------- your own drone: four rotors (blade-pass tone + harmonics), ESC whine, prop wash ----------
  buildOwnDrone() {
    const ctx = this.ctx, out = ctx.createGain(); out.gain.value = 0.5; out.connect(this.master);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; lp.connect(out);
    this.rotors = [0, 1, 2, 3].map(k => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = (k - 1.5) * 6;
      const g = ctx.createGain(); g.gain.value = 0; o.connect(g).connect(lp); o.start();
      const whine = ctx.createOscillator(); whine.type = 'triangle';
      const wg = ctx.createGain(); wg.gain.value = 0; whine.connect(wg).connect(out); whine.start();
      return { o, g, whine, wg };
    });
    const wash = this.loop(this.white), bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    this.washG = ctx.createGain(); this.washG.gain.value = 0; this.washBp = bp;
    wash.connect(bp).connect(this.washG).connect(out);
  }

  // ---------- wind (airspeed + gusts), city hum ----------
  buildAmbience() {
    const ctx = this.ctx;
    const w = this.loop(this.white), bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.6;
    this.windG = ctx.createGain(); this.windG.gain.value = 0; this.windBp = bp;
    w.connect(bp).connect(this.windG).connect(this.master);
    const h = this.loop(this.brown), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    this.cityG = ctx.createGain(); this.cityG.gain.value = 0.25;
    h.connect(lp).connect(this.cityG).connect(this.master);
  }

  // a positional voice for a hunter (or any other drone): tone + wash through a panner
  makeVoice() {
    const ctx = this.ctx, pan = this.panner(15, 1.4, 1500), g = ctx.createGain(); g.gain.value = 0;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = 9;
    const n = this.loop(this.white), bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.8;
    const ng = ctx.createGain(); ng.gain.value = 0.35;
    o.connect(lp); o2.connect(lp); lp.connect(g); n.connect(bp).connect(ng).connect(g); g.connect(pan).connect(this.master);
    o.start(); o2.start();
    return { pan, g, o, o2 };
  }
  makeHeli() { // main rotor slap: low noise, amplitude-modulated at the blade-pass rate (~19 Hz)
    const ctx = this.ctx, pan = this.panner(60, 1.1, 4000);
    const n = this.loop(this.brown), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    const am = ctx.createGain(); am.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 18.5; const lg = ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain); lfo.start();
    const whine = ctx.createOscillator(); whine.type = 'sine'; whine.frequency.value = 1650; const wg = ctx.createGain(); wg.gain.value = 0.02;
    const g = ctx.createGain(); g.gain.value = 1.4;
    n.connect(lp).connect(am).connect(g); whine.connect(wg).connect(g); g.connect(pan).connect(this.master);
    return { pan };
  }

  // ---------- one-shots ----------
  burst({ at = null, dur = 0.05, freq = 1200, q = 0.7, type = 'bandpass', gain = 0.6, delay = 0, verb = 0, tone = 0, toneDecay = 0.08, src = this.white }) {
    const ctx = this.ctx, t0 = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = src;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    s.connect(f).connect(g);
    let out = g;
    if (at) { const p = this.panner(12, 1.2, 4000); p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z; g.connect(p); out = p; }
    out.connect(this.master); if (verb) { const vg = this.ctx.createGain(); vg.gain.value = verb; out.connect(vg).connect(this.verbIn); }
    s.start(t0, Math.random()); s.stop(t0 + dur + 0.05);
    if (tone) { // a pitched body under the noise (thump, clank)
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(tone, t0); o.frequency.exponentialRampToValueAtTime(tone * 0.5, t0 + toneDecay);
      const og = ctx.createGain(); og.gain.setValueAtTime(gain * 0.8, t0); og.gain.exponentialRampToValueAtTime(0.0008, t0 + toneDecay);
      o.connect(og).connect(at ? out : this.master); o.start(t0); o.stop(t0 + toneDecay + 0.05);
    }
  }
  sweep(at, f0, f1, dur, gain, delay = 0) {
    const ctx = this.ctx, t0 = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    const p = this.panner(10, 1.3, 2000); p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z;
    o.connect(g).connect(p).connect(this.master); o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // ---------- the war around you: artillery, distant machine guns, sirens ----------
  war(listener) {
    const r = Math.random(), a = Math.random() * Math.PI * 2, d = 600 + Math.random() * 1800;
    const at = { x: listener.x + Math.cos(a) * d, y: 0, z: listener.z + Math.sin(a) * d }, delay = Math.min(d / C, 3);
    if (r < 0.45) this.burst({ at, dur: 2.2, freq: 110, type: 'lowpass', q: 0.5, gain: 2.2, delay, verb: 1.2, tone: 55, toneDecay: 0.9, src: this.brown });
    else if (r < 0.8) for (let k = 0, n = 6 + Math.floor(Math.random() * 12); k < n; k++) this.burst({ at, dur: 0.06, freq: 900, q: 1.2, gain: 0.5, delay: delay + k * 0.085, verb: 0.8 });
    else { // a siren drifting somewhere in the city
      const ctx = this.ctx, t0 = ctx.currentTime, o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
      o.frequency.value = 760; lfo.frequency.value = 0.35; lg.gain.value = 170; lfo.connect(lg).connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 1.5); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 9);
      const p = this.panner(80, 1, 5000); p.positionX.value = at.x; p.positionY.value = 5; p.positionZ.value = at.z;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
      o.connect(lp).connect(g).connect(p).connect(this.master); lfo.start(t0); o.start(t0); o.stop(t0 + 9); lfo.stop(t0 + 9);
    }
  }

  // ---------- radio: squelch, garbled voice (or text-to-speech), roger beep ----------
  radio(text, { voice = true } = {}) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    this.burst({ dur: 0.12, freq: 1800, q: 1.5, gain: 0.25 }); // squelch open
    const dur = Math.min(0.9 + text.length * 0.055, 5.5);
    if (voice && this.voice && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.12; u.pitch = 0.85; u.volume = 0.9;
      const v = speechSynthesis.getVoices().find(v => /en(-|_)(US|GB)/i.test(v.lang) && /male|david|george|daniel|guy/i.test(v.name)) || speechSynthesis.getVoices().find(v => /^en/i.test(v.lang));
      if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } else { // syllable-chopped band-limited noise with a little drive: sounds like distant radio talk
      const s = ctx.createBufferSource(); s.buffer = this.white;
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 1100; f1.Q.value = 2.5;
      const env = ctx.createGain(); env.gain.value = 0;
      for (let t = 0; t < dur; t += 0.09 + Math.random() * 0.1) env.gain.setTargetAtTime(Math.random() < 0.8 ? 0.25 + Math.random() * 0.3 : 0, t0 + 0.12 + t, 0.02);
      env.gain.setTargetAtTime(0, t0 + 0.12 + dur, 0.03);
      const drive = ctx.createWaveShaper(); drive.curve = Float32Array.from({ length: 256 }, (_, i) => Math.tanh((i / 128 - 1) * 3));
      s.connect(f1).connect(drive).connect(env).connect(this.master); s.start(t0 + 0.1); s.stop(t0 + dur + 0.3);
    }
    const beepAt = t0 + (voice && this.voice ? 0.25 : dur + 0.15);
    const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 1250;
    g.gain.setValueAtTime(0.12, beepAt); g.gain.setValueAtTime(0, beepAt + 0.08);
    o.connect(g).connect(this.master); o.start(beepAt); o.stop(beepAt + 0.1);
  }

  // ---------- per-frame update ----------
  update(game, camera, dt, { cut = false } = {}) {
    if (!this.ctx || !game) return;
    const ctx = this.ctx, t = ctx.currentTime, P = game.player, L = ctx.listener;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, t, 0.05);
    // listener = camera
    const f = camera.getWorldDirection(camera.userData.tmpDir ??= camera.position.clone()), u = camera.up;
    L.positionX.value = camera.position.x; L.positionY.value = camera.position.y; L.positionZ.value = camera.position.z;
    L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z; L.upX.value = u.x; L.upY.value = u.y; L.upZ.value = u.z;
    // own rotors: blade-pass frequency = ω · 2 blades / 2π; loudness with thrust; ESC whine at 7 pole pairs
    P.rotors.forEach((r, k) => {
      const bpf = Math.max(20, r.w * 2 / (2 * Math.PI)), v = this.rotors[k];
      v.o.frequency.setTargetAtTime(bpf, t, 0.02);
      v.g.gain.setTargetAtTime(r.health > 0 ? Math.min(0.09, 0.012 + r.thrust * 0.005) : 0, t, 0.03);
      v.whine.frequency.setTargetAtTime(r.w * 7 / (2 * Math.PI), t, 0.02);
      v.wg.gain.setTargetAtTime(r.health > 0 ? Math.min(0.012, r.w / 1000 * 0.012) : 0, t, 0.03);
    });
    const thrust = P.rotors.reduce((s, r) => s + r.thrust, 0);
    this.washG.gain.setTargetAtTime(Math.min(0.35, thrust * 0.006), t, 0.05);
    this.washBp.frequency.setTargetAtTime(400 + thrust * 12, t, 0.05);
    // wind: airspeed (relative to the moving air) and height
    const air = len(sub(P.vel, game.windAt(P.pos)));
    this.windG.gain.setTargetAtTime(Math.min(0.5, 0.02 + air * air * 0.0006), t, 0.1);
    this.windBp.frequency.setTargetAtTime(250 + air * 28, t, 0.1);
    this.cityG.gain.setTargetAtTime(0.28 * Math.max(0.15, 1 - P.pos.y / 250), t, 0.3);
    // hunters: the nearest eight get a voice each; pitch from their motors, Doppler from closing speed
    const lp = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    const near = game.hunters.map(h => h.d).filter(d => d.alive || d.pos.y > 1).sort((a, b) => dist(a.pos, lp) - dist(b.pos, lp)).slice(0, 8);
    while (this.voices.length < near.length) this.voices.push(this.makeVoice());
    this.voices.forEach((v, i) => {
      const d = near[i];
      if (!d) { v.g.gain.setTargetAtTime(0, t, 0.1); return; }
      const w = d.rotors.reduce((s, r) => s + r.w, 0) / 4, rel = sub(d.pos, lp), r = len(rel) || 1;
      const closing = -dot(sub(d.vel, P.vel), { x: rel.x / r, y: rel.y / r, z: rel.z / r });
      const dop = C / Math.max(C - closing, 50);
      v.o.frequency.setTargetAtTime(w * 2 / (2 * Math.PI) * dop, t, 0.03); v.o2.frequency.setTargetAtTime(w * 2.01 / (2 * Math.PI) * dop, t, 0.03);
      v.g.gain.setTargetAtTime(d.alive ? 0.5 : 0, t, 0.05);
      this.at(v.pan, d.pos);
    });
    // helicopters
    while (this.helis.length < game.helis.length) this.helis.push(this.makeHeli());
    game.helis.forEach((h, i) => this.at(this.helis[i].pan, h.pose.p));
    // near misses: a round that passes within 5 m of you snaps (supersonic crack)
    for (const b of game.rounds) {
      if (b.owner === P || b.cracked) continue;
      const rel = sub(P.pos, b.p), along = dot(rel, norm(b.v));
      if (along < 0 && along > -10 && len(sub(rel, { x: b.v.x / len(b.v) * along, y: b.v.y / len(b.v) * along, z: b.v.z / len(b.v) * along })) < 5) {
        b.cracked = true; this.burst({ at: b.p, dur: 0.035, freq: 3200, type: 'highpass', gain: 0.9 });
      }
    }
    // the war
    if (t > this.nextWar) { this.war(lp); this.nextWar = t + 3 + Math.random() * 9; }
  }

  // ---------- game events ----------
  event(e, game) {
    if (!this.ctx) return;
    const P = game.player, lp = P.pos;
    const delayFor = p => Math.min(dist(p, lp) / C, 3);
    if (e.type === 'shot') {
      if (e.who === P) this.burst({ dur: 0.07, freq: 1500, type: 'highpass', q: 0.5, gain: 0.55, tone: 95, toneDecay: 0.05 });
      else { const d = dist(e.p, lp); this.burst({ at: e.p, dur: 0.08, freq: Math.max(500, 2600 - d * 5), type: 'lowpass', gain: 1.4, delay: delayFor(e.p), verb: Math.min(1, d / 300) }); }
    } else if (e.type === 'hit') {
      if (e.who === P) this.burst({ dur: 0.18, freq: 2600, q: 6, gain: 1.0, tone: 1700, toneDecay: 0.2 });
      else this.burst({ at: e.p, dur: 0.12, freq: 2400, q: 5, gain: 1.2, delay: delayFor(e.p), tone: 1500, toneDecay: 0.15 });
    } else if (e.type === 'ricochet') {
      if (dist(e.p, lp) < 250) this.sweep(e.p, 2600 + Math.random() * 1200, 700, 0.25, 0.25, delayFor(e.p));
    } else if (e.type === 'impact') {
      this.burst({ at: e.who === P ? null : e.who.pos, dur: 0.25, freq: 180, type: 'lowpass', gain: Math.min(1.5, 0.3 + e.dv * 0.08), tone: 70, toneDecay: 0.2, src: this.brown, delay: e.who === P ? 0 : delayFor(e.who.pos) });
    }
  }
}
