# EXFIL

**You're a quadcopter on a rooftop with stolen data. Hunter drones are coming. Get 700 m clear of every one of them.**

This is a drone escape game in a procedurally generated city about 4 km across. It has downtown towers, midtown blocks, an industrial sector, parks and suburbs, with traffic, patrolling helicopters and burning buildings. Both you and the hunters fly the same physically simulated airframe: per-rotor thrust, motor lag, battery sag, drag, wind, downwash and real damage. Only the hunters' brains are AI.

> Private for now. Screenshots will be added once they're approved.

## Play

```bash
npm install
npm start          # → http://localhost:8080
```

| | |
|---|---|
| Mouse | look and aim (click to capture); hold left button to fire |
| `W A S D` | tilt: a tap gives a little, holding ramps up to 60°. `Shift`: gentle |
| `Q` / `E` | yaw left / right |
| `Space` / `X` | climb / descend (in ACRO: throttle up / down) |
| `F` | flight mode: **ANGLE** · **ACRO** · **ASSIST** |
| `C` (or `V`) | third person / first person (FPV, bolted to the airframe, rolls with it) |
| `H` | posture: **FACE** first (60° max tilt) or **HEAD** first: tips up to ~72° so all power goes to speed, +35% (36 m/s), about 2× the battery drain |
| `G` (hold) | power cut: motors to idle, drop at ~13 m/s while staying level; release to catch yourself (~6 m) |
| `B` | intercepted hunter telemetry: what the hunters are thinking |
| `K` | show / hide the on-screen controls panel |
| `M` / `N` | sound on/off · intercept receiver on/off |
| `-` / `=` | volume (the start screen has Volume and Enemy radio sliders, remembered) |
| `R` | restart the same city (any time, or on the end screen); `Enter` on the end screen: new city |

**Flight modes**, like a real flight controller:
- **ANGLE** (default): the sticks set the tilt angle, so 15° tilt flies ~15 m/s. It self-levels when you let go but doesn't brake, so you glide. Altitude is held unless you climb or descend.
- **ACRO**: the sticks set *rotation rates* (up to 260°/s), with no self-levelling and manual throttle around hover. Barrel rolls, flips, inverted dives: a full roll costs about 11 m of altitude.
- **ASSIST**: GPS-style. The sticks set velocity, and it brakes to a hover when you let go. The hunters fly this way.

Choose a difficulty in the menu:

| Difficulty | Hunters | Hunter speed | Radar | Camera | Gun spread |
|---|---|---|---|---|---|
| Easy | 3 | same as you | 330 m | 280 m | 1.3° |
| Normal | 9 | +10% | 400 m | 330 m | 0.95° |
| Hard | 18 | +20% | 460 m | 380 m | 0.7° |
| Brutal | 27 | +25% | 520 m | 420 m | 0.5° |

They scramble from all around the tower, 350–650 m out.

You win by getting 700 m from every hunter, or by shooting them all down. If your drone can't fly any more (a rotor is gone, too little thrust left, the battery is dead, or the hull is destroyed), you're **downed**. The hunters then fly in to confirm, and you lose when one is within 8 m.

While you're flying, the game takes every key, so browser shortcuts like Ctrl+S don't fire. Nothing is bound to Ctrl, because no web page can block Ctrl+W.

## Look and feel

- **Time of day:** Dawn, Day, Dusk or Night on the start screen, and optionally a **running clock** (1 hour per 2 minutes). The sun, or at night the moon, is the shadow-casting light, so shadows are live and move across the city as the clock runs. Nights have stars, a moon, lit windows, glowing street lamps with light pools on the road, and car head- and taillights.
- **Traffic:** about 14,300 cars in lanes (every road, both directions). Cars in a lane share its speed and keep at least 20 m apart. Full 3D models are drawn within 320 m, simple boxes out to the haze. Updating all of them costs under 1 ms per frame.

- **Sky and light:** a physically based sky (Rayleigh/Mie scattering) with a low sun through haze. It is also baked into an environment map, so glass and metal reflect it. ACES tone mapping and distance haze.
- **Shadows:** four cascades, sharp at your drone and still present 900 m out, with normal-offset biasing (no striping on walls).
- **Procedural facades from world position** (no textures): floors and slab lines, window grids that vary per building (ribbon glass to punched windows), reflective glass, lit rooms, blown-out panes, weathering, gravel roofs, and shopfronts with awnings at street level.
- **Streets:** worn asphalt, sidewalks, dashed centre lines, and patchy ground with scorch marks.
- **Rooftop clutter:** AC units, water towers and masts with blinking aviation lights. These are real colliders.
- **Street lights:** real colliders every 60 m.
- **Cars:** 7 models (sedan, SUV, van, truck, delivery, taxi, the odd police car).
- **Pedestrians:** about 520 people walk the sidewalks around you or stand about. When a drone comes in low or rounds hit near the street, they run away from it, then calm down.
- **Performance:** everything repeated is GPU-instanced. The whole city is about 850 draw calls with 27 hunters, at 220+ FPS on an RTX 4080.

## Sound

All of it is synthesized live with Web Audio (no sound files) and driven by the simulation:

- **Your rotors:** four tones at each motor's blade-pass frequency (ω·2/2π, ~160 Hz at hover). Each gets louder with its thrust, and each has an ESC whine at 7 pole pairs. Prop wash rises with total thrust. Throttle up, sprint, cut power (G), or lose a rotor, and you hear it.
- **Hunters:** the nearest 8 get a 3D-positioned (HRTF) voice pitched from their own motors, with **Doppler** from closing speed.
- **Helicopters:** 3D positioned, with a low rotor slap at the ~19 Hz blade-pass rate and turbine whine.
- **Gunfire:**
  - Your gun: a sharp crack with a thump.
  - Hunters' guns: 3D positioned and **delayed by distance ÷ 343 m/s**, duller and more echoing the further away.
  - Near misses: rounds passing within 5 m of you snap (supersonic crack).
  - Ricochets whine, hits on your airframe clank, and impacts thud.
- **Environment:** wind that grows with your airspeed through the air, a city hum that fades as you climb, and a war going on around you. That means artillery booms and distant machine-gun bursts echoing off the city (convolution reverb), and sirens drifting across town.
- **Enemy radio, intercepted:** nobody helps you. All you hear is the hunters' own net, and what they say is what their AI is actually doing:
  - contact reports with sensor, bearing and range ("Hunter 9, radar contact, bearing 1-niner-3, range 4 hundred, all units converge"), and "wilco" from wingmen;
  - "lost contact, searching last known", then "climbing to search altitude";
  - "engaging" and "check fire, friendly in line";
  - "I'm hit", and "Hunter 7 is down, taking fire";
  - "low battery, landing";
  - "target is down, moving to confirm" and "confirmed".
- **How the radio sounds:** the voice is real recorded speech (a CC0 Piper voice, 65 clips), stitched live through a **CB-radio chain**: 400 Hz high-pass, 2.6 kHz low-pass, mid "honk", overdrive, carrier hiss, squelch burst and "kssht" tail. Distant transmitters are weaker, with more hiss and fading.
- **Direction finding:** every transmission gives you a **DF bearing** toward the hunter who keyed the mic, drawn on your radar for 6 s with realistic error (worse at range). You can find them by listening, even when your sensors can't see them.

## The drone

It's a 2.0 kg X-quad. Each part is a collider with its own mass: frame, arms, a 0.7 kg battery slung under the frame, the gun and camera pod on the nose, and four motors with props.

- **Four independent rotors.** Thrust = k·ω² × rotor health × battery sag (80–100% as charge drops). The motors have a 35 ms spin-up lag. Each rotor pushes at its own position, and its spin adds yaw reaction torque.
- **Flight controller**, cascaded: velocity loop (with integral, so it holds position in wind; ASSIST) or stick angle (ANGLE) or body rates (ACRO) → attitude loop → a 4×4 mixer that solves per-rotor thrust about the drone's **real centre of mass** (the nose pod shifts it forward). About 15% of thrust is kept in reserve so attitude control never runs out. When motors saturate, yaw is scaled down to whatever authority is left, not dropped. Yaw uses rate feedforward, so turns don't lag.
- **Aerodynamics:** drag relative to the *air*, not the ground. That's how wind, gusts and downwash push you. Air pouring down through the prop discs (when climbing, or in downwash) unloads the props, per momentum theory.
- **Battery:** 111 Wh (6S 5 Ah). Power is ideal momentum-theory power ÷ 62% efficiency, plus avionics. That gives **~30 min of hover** and ~10 min flat out at full speed (630 W).
- **Top speed:** 27 m/s (97 km/h) at 60° tilt for you. The hunters' airframes have less drag, so their top speed scales exactly with difficulty.
- **Damage:**
  - Hit zones are each prop disc and the core. Three hits kill a rotor.
  - A body hit can puncture a cell, which bleeds power, or crack the optics, which cuts sensor range.
  - Impacts are detected physically, as a change in velocity the forces don't explain, and damage the hull and the rotors.
  - With one rotor at 50% the mixer compensates. Lose a rotor entirely and an X-quad goes down, as real ones do.

## The city and its air

- **Buildings and terrain:** about 8,500 buildings and 5,000 trees, all solid. The world has about 18,600 static colliders and builds in about 60 ms.
- **Cars:** 360 cars drive the road grid. Fly at street level and you can hit one.
- **Helicopters:** 6 fly patrol loops. Their rotor downwash comes from momentum theory (≈17 m/s under a 3.2 t helicopter). It spreads and decays with depth, is turbulent, and pushes drones down and around.
- **Wind:** base wind that gets stronger with height (log profile), plus gusts.
- **Fires:** some buildings burn. Hot air rises above them, and the smoke drifts downwind.

## Sensors: same kit on both sides

| Sensor | Range | Needs line of sight | Notes |
|---|---|---|---|
| Radar | 330–520 m (hunters), 400 m (you) | yes | 360°, but loses low targets in ground clutter: fly under ~30 m to fade out |
| EO/IR camera | 280–420 m | yes | 70° cone, points where you look (hunters: at the target or search area) |
| Microphone array | ~90 m | **no** | bearing-ish only, louder when motors work harder |

Your HUD shows only what *your* sensors know, including a heading-up radar scope. A radar warning receiver tells you when a hunter has you (**RADAR TRACK**, **OPTICAL LOCK**, **HEARD**, **UNDER FIRE**).

## The hunters' brains

They fly as a swarm:

- **Shared data link:** when any hunter's sensors have you, all of them know where you are.
- **TRANSIT:** they were told where the server is, not where you are, so each flies to its own slot around the roof.
- **CHASE:** they intercept at the point where you'll be. Close in, each takes its **own slot** around you (spread by the golden angle over three rings and several heights), so the swarm surrounds you instead of queueing. They fire in bursts using a lead solution (your velocity, their own, bullet drop).
- **SEARCH:** when the link loses you, they climb to at least 140 m to look down over the rooftops, go to where you'd be if you'd kept going, and **fan out** in expanding circles at different heights.
- **CONFIRM:** once you're downed, the *nearest* hunter flies in, low and slow, to within 8 m. The rest hold in a stack above the rooftops.
- **Sprint and battery:** hunters fly HEAD first (the same +35%) when the goal is far and they have more than 40% charge. At 10% they land rather than fall.
- **Always:**
  - **Clearance:** each hunter sweeps its body along about 60 3D directions to find a clear path. Helicopter downwash counts as an obstacle, and so do wingmen: where they are now *and* where they'll be in 0.8 s.
  - **Personal space:** each keeps its distance from wingmen, earlier when closing fast, and never gets pushed into a wall by it.
  - **Friendly fire:** they hold fire when a wingman is in the line of fire.
  - **Speed:** capped by stopping distance, planned with the braking the airframe really achieves (~8.6 m/s²), along both the chosen path and the actual momentum.

## Tests

`npm test` runs the same simulation headless (`SEEDS=8 npm test` for more games):

```
PASS  hover 60 s in gusty wind                  alt error ≤ 0.72 m, tilt ≤ 4.9°, 216 W
PASS  hover endurance ≥ 20 min                  29.9 min of hover left after the test
PASS  hunter top speed matches difficulty       easy 27.0 m/s (1.00×), normal 29.7 (1.10×), hard 32.4 (1.20×), brutal 33.7 (1.25×)
PASS  ANGLE mode: tilt follows the stick        stick 0.25 → 15° | 0.5 → 30° | 1 → 60°
PASS  ACRO mode: barrel roll                    inverted (up.y -1.00), back level (up.y 1.00), lost 11 m
PASS  hover with one rotor at 50%               alt error ≤ 0.30 m: the mixer re-balances the other three
PASS  a destroyed rotor brings it down          fell 25 m in 4 s
PASS  downwash under a hovering helicopter      air -10 m/s: pushed down 3.9 m in 2 s
PASS  hunter finds + hits a sitting target      first hit at 18.4 s
PASS  lost track -> climbs and searches         climbed to 185 m to look down
PASS  downed (rotor shot off) -> hunter confirms  hunter came within 8 m, then game over
PASS  downed (battery dead) -> hunter confirms    hunter came within 8 m, then game over
PASS  Easy / Normal / Hard / Brutal (3/9/18/27 hunters)   0 crashes, 0 friendly fire, wingmen ≥ 10 m apart
```

The autopilot player is a simple flee-and-stay-low script, so a human who uses the buildings plays much better. Across 32 full games the hunters never flew into anything.

## Not done yet

- Dedicated high-altitude spotter drones. The swarm already shares every sighting and climbs high to search, but no hunter is a dedicated spotter.
- A "return to base" objective as an alternative way to win.
- Cars only collide at street level (below 3 m) and are simplified.

## Credits

3D models are in `assets/models`, with the full list in [`assets/models/CREDITS.md`](assets/models/CREDITS.md):

- Radio voice: Piper `en_US-joe-medium` (CC0), 65 generated clips in `assets/radio`.
- "Drone" by NateGazzard (https://poly.pizza/m/DNbUoMtG3H), licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Modified: rotor nodes re-pivoted to their hub centres.
- Helicopter by kazuma (CC0), modified so the main rotor is a separate node.
- Cars, trees, street lights and water towers by Kenney (www.kenney.nl), CC0.

## Files

| | |
|---|---|
| [`sim.js`](sim.js) | Everything that matters: city, weather, helicopters, drone physics, flight controller, sensors, hunter brain, ballistics, damage |
| [`index.html`](index.html) | Page, HUD layout, menus |
| [`client.js`](client.js) | Rendering (sky, cascaded shadows, procedural facade shaders, instancing), HUD, radar scope, input |
| [`models.js`](models.js) | Loads the glTF models; bakes them for instancing; live clones with spinning rotors |
| [`people.js`](people.js) | The pedestrian crowd |
| [`audio.js`](audio.js) | Synthesized sound: rotors, Doppler, gunfire at the speed of sound, wind, city, war, radio |
| [`radio.js`](radio.js) | The intercepted enemy radio net and direction finding |
| [`test-sim.mjs`](test-sim.mjs) | Headless test bench and Monte Carlo |
| [`serve.mjs`](serve.mjs) | Zero-dependency static server |
