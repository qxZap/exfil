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
| `W A S D` | fly relative to where you're looking; let go to brake and hover. `Shift`: slow and precise |
| `Space` / `C` | climb / descend |
| `V` | chase cam / nose cam |
| `B` | intercepted hunter telemetry: what the hunters are thinking |

Choose a difficulty and 1–3 hunters in the menu:

| Difficulty | Hunter speed | Radar | Camera | Gun spread |
|---|---|---|---|---|
| Easy | same as you | 330 m | 280 m | 1.3° |
| Normal | +10% | 400 m | 330 m | 0.95° |
| Hard | +20% | 460 m | 380 m | 0.7° |
| Brutal | +25% | 520 m | 420 m | 0.5° |

You win by getting 700 m from every hunter, or by shooting them all down. You lose if you're shot down, fly into something hard enough, or the battery runs flat.

## The drone

It's a 2.0 kg X-quad. Each part is a collider with its own mass: frame, arms, a 0.7 kg battery slung under the frame, the gun and camera pod on the nose, and four motors with props.

- **Four independent rotors.** Thrust = k·ω² × rotor health × battery sag (80–100% as charge drops). The motors have a 35 ms spin-up lag. Each rotor pushes at its own position, and its spin adds yaw reaction torque.
- **Flight controller**, cascaded: velocity loop (with integral, so it holds position in wind) → tilt limited to 60° → attitude loop → a 4×4 mixer that solves per-rotor thrust. When a rotor saturates, it gives up yaw first to keep level.
- **Aerodynamics:** drag relative to the *air*, not the ground. That's how wind, gusts and downwash push you. Air pouring down through the prop discs (when climbing, or in downwash) unloads the props, per momentum theory.
- **Battery:** 111 Wh (6S 5 Ah). Power is ideal momentum-theory power ÷ 62% efficiency, plus avionics. That gives **~30 min of hover** and ~10 min flat out at full speed (630 W).
- **Top speed:** 28 m/s for you. The hunters' airframes have less drag, so their top speed scales exactly with difficulty.
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

## The hunter's brain

- **TRANSIT:** it was told where the server is, not where you are. It flies there at altitude.
- **CHASE:** once a sensor has you, it intercepts at the point where you'll be. Close in, it holds a firing standoff about 70 m out and 18 m above. It fires in bursts using a lead solution (your velocity, its own velocity, bullet drop).
- **SEARCH:** when it loses you, it climbs to at least 140 m to look down over the rooftops, flies to where you'd be if you'd kept going, and spirals outward.
- **Always:**
  - It sweeps its body along about 60 3D directions to find a path that's clear.
  - Helicopter downwash columns count as obstacles.
  - Its speed is capped by its stopping distance, including the time it takes to tilt back, along both its chosen path and its actual momentum.

## Tests

`npm test` runs the same simulation headless (`SEEDS=8 npm test` for more games):

```
PASS  hover 60 s in gusty wind                  alt error ≤ 0.64 m, tilt ≤ 4.7°, 216 W
PASS  hover endurance ≥ 20 min                  29.8 min of hover left after the test
PASS  hunter top speed matches difficulty       easy 28.0 m/s (1.00×), normal 30.8 (1.10×), hard 33.6 (1.20×), brutal 35.0 (1.25×)
PASS  hover with one rotor at 50%               alt error ≤ 0.26 m: the mixer re-balances the other three
PASS  a destroyed rotor brings it down          fell 30 m in 4 s
PASS  downwash under a hovering helicopter      air -10 m/s: pushed down 3.9 m in 2 s
PASS  hunter finds + hits a sitting target      first hit at 16.3 s
PASS  lost track -> climbs and searches         climbed to 185 m to look down
PASS  Easy   8 games vs autopilot player        hunter impacts 0 | escaped 3, destroyed 1, still going 4
PASS  Normal 8 games vs autopilot player        hunter impacts 0 | destroyed 3, still going 5
PASS  Hard   8 games vs autopilot player        hunter impacts 0 | destroyed 5, still going 3
PASS  Brutal 8 games vs autopilot player        hunter impacts 0 | destroyed 6, still going 2
```

The autopilot player is a simple flee-and-stay-low script, so a human who uses the buildings plays much better. Across 32 full games the hunters never flew into anything.

## Not done yet

- Sound.
- Dedicated high-altitude spotter drones that relay your position to the hunters. Hunters already climb high to search, but there's no separate spotter role.
- A "return to base" objective as an alternative way to win.
- Cars only collide at street level (below 3 m) and are simplified.

## Files

| | |
|---|---|
| [`sim.js`](sim.js) | Everything that matters: city, weather, helicopters, drone physics, flight controller, sensors, hunter brain, ballistics, damage |
| [`index.html`](index.html) | Three.js rendering (instanced city with procedural windows), HUD, radar scope, input |
| [`test-sim.mjs`](test-sim.mjs) | Headless test bench and Monte Carlo |
| [`serve.mjs`](serve.mjs) | Zero-dependency static server |
