// The radio net: your operator ("OPS") talks you through the escape, and you can overhear the
// hunters' own net. Reads the game state every frame and decides what's worth saying.
import { dist } from './sim.js';

const words = n => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n] ?? String(n);

export class RadioNet {
  constructor(audio, log) { this.audio = audio; this.log = log; this.reset(); }
  reset() { this.said = new Set(); this.queue = []; this.busyUntil = 0; this.tracked = false; this.lostAt = null; this.milestone = 0; this.alive = null; this.linkBy = null; }

  say(from, text, { voice = from === 'OPS', key = null, priority = false } = {}) {
    if (key) { if (this.said.has(key)) return; this.said.add(key); }
    const item = { from, text, voice };
    priority ? this.queue.unshift(item) : this.queue.push(item);
  }

  update(game, now) {
    const P = game.player, t = game.time;
    if (t > 1.5) this.say('OPS', `Exfil, ops. Data's on the drive. ${game.hunters.length} hunters scrambled to your roof. Get seven hundred metres clear of all of them.`, { key: 'brief' });
    // are they on you?
    const onYou = game.hunters.some(h => h.d.alive && h.sensors.track(P, t, 1.0));
    if (onYou && !this.tracked) {
      this.say('OPS', this.said.has('first-track') ? 'They have you again. Break line of sight.' : 'They have you. Break line of sight, get down into the streets.', { key: this.said.has('first-track') ? null : 'first-track' });
      this.said.add('first-track'); this.lostAt = null;
    }
    if (!onYou && this.tracked) this.lostAt = t;
    if (this.lostAt !== null && t - this.lostAt > 4) { this.say('OPS', "You're off their scopes. Stay low and keep moving."); this.lostAt = null; }
    this.tracked = onYou;
    // the hunters' net: overheard, garbled
    if (game.link && game.link.by !== this.linkBy && t - game.link.t < 0.5) {
      this.linkBy = game.link.by;
      const b = Math.round(((Math.atan2(P.pos.x - game.link.by.d.pos.x, P.pos.z - game.link.by.d.pos.z) * 180 / Math.PI) + 360) % 360);
      this.say('HUNTER NET', `${game.link.by.d.name}: contact, bearing ${b}, ${Math.round(dist(P.pos, game.link.by.d.pos))} metres. All units converge.`, { voice: false });
    }
    // progress (ops can see it on their map)
    const clear = game.escapeDist;
    if (this.milestone === 0) this.milestone = Math.max(1, ...[300, 450, 600].filter(m => clear >= m)); // only progress from where you start counts
    for (const m of [300, 450, 600]) if (clear >= m && this.milestone < m && game.status === 'play' && this.said.has('brief')) { this.milestone = m; this.say('OPS', `${m} metres clear of the nearest hunter. Keep going.`); }
    // damage, battery
    if (P.hull < 100) this.say('OPS', "You're hit. Watch your hull.", { key: 'hit' });
    P.rotors.forEach((r, k) => { if (r.health < 0.5 && r.health > 0) this.say('OPS', `Rotor ${words(k + 1)} is losing thrust. Fly gentle.`, { key: `rotor${k}` }); });
    if (P.battery.leakW) this.say('OPS', "A cell's punctured, you're bleeding power.", { key: 'leak' });
    if (P.soc < 0.3) this.say('OPS', 'Battery thirty percent.', { key: 'bat30' });
    if (P.soc < 0.15) this.say('OPS', 'Battery fifteen percent. Put it down somewhere soon.', { key: 'bat15' });
    // kills
    const alive = game.hunters.filter(h => h.d.alive).length;
    if (this.alive !== null && alive < this.alive && game.status === 'play') this.say('OPS', `Splash one. ${alive} left.`, { priority: true });
    this.alive = alive;
    // helicopter wash
    if (game.helis.some(h => dist(h.pose.p, P.pos) < 60 && h.pose.p.y > P.pos.y)) this.say('OPS', 'Helo overhead, watch the downwash.', { key: `heli${Math.floor(t / 30)}` });
    // endings
    if (game.status === 'downed') this.say('OPS', "Exfil's down. We lost the package.", { key: 'downed', priority: true });
    if (game.status === 'escaped') this.say('OPS', "You're clear. Package is out. Good work.", { key: 'end', priority: true });
    if (game.status === 'hunters-down') this.say('OPS', 'All hunters down. Bring it home.', { key: 'end', priority: true });
    // play the next message when the channel is free
    if (this.queue.length && now > this.busyUntil) {
      const m = this.queue.shift();
      this.audio.radio(m.text, { voice: m.voice });
      this.busyUntil = now + 1.2 + m.text.length * 0.06;
      this.log(m.from, m.text);
    }
  }
}
