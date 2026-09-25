// Volumetric clouds (ray-marched through a layer at 900–1500 m) and crepuscular rays (a
// screen-space radial blur of the bright sky toward the sun). Both follow the time of day.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const NOISE = `
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }`;

export class Clouds {
  constructor(scene) {
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.6, 0.65, 0.7) },
      uTime: { value: 0 }, uCover: { value: 0.52 }, uWind: { value: new THREE.Vector2(6, 2) }, uFog: { value: new THREE.Color(0.7, 0.74, 0.77) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.BackSide,
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uSun, uSunColor, uAmb, uFog; uniform float uTime, uCover; uniform vec2 uWind;
        varying vec3 vWorld;
        ${NOISE}
        const float Y0 = 900.0, Y1 = 1500.0;
        float density(vec3 p) {
          float h = (p.y - Y0) / (Y1 - Y0);
          float shape = smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.55, h);      // flat bases, rounded tops
          vec3 q = p * 0.0011 + vec3(uWind.x, 0.0, uWind.y) * uTime * 0.0004;
          float d = fbm(q) - (1.0 - uCover);
          return clamp(d * 3.2, 0.0, 1.0) * shape;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
          if (abs(rd.y) < 1e-3) discard;
          float ta = (Y0 - ro.y) / rd.y, tb = (Y1 - ro.y) / rd.y;
          float t0 = max(min(ta, tb), 0.0), t1 = max(ta, tb);
          if (t1 <= 0.0) discard;
          t1 = min(t1, t0 + 7000.0);
          const int STEPS = 48;
          float dt = (t1 - t0) / float(STEPS), T = 1.0, t = t0 + dt * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          vec3 col = vec3(0.0);
          float mu = dot(rd, uSun), phase = 0.55 * (1.0 - 0.7 * 0.7) / pow(1.0 + 0.49 - 1.4 * mu, 1.5) / 12.566 * 12.0 + 0.45; // Henyey-Greenstein: silver lining
          for (int i = 0; i < STEPS; i++) {
            vec3 p = ro + rd * t;
            float d = density(p);
            if (d > 0.01) {
              float sh = 0.0;                                                  // light marched toward the sun
              for (int k = 1; k <= 4; k++) sh += density(p + uSun * float(k) * 70.0);
              vec3 lightC = uSunColor * exp(-sh * 1.1) * phase + uAmb * (0.55 + 0.45 * (p.y - Y0) / (Y1 - Y0));
              float a = 1.0 - exp(-d * dt * 0.02);
              col += T * a * lightC; T *= 1.0 - a;
              if (T < 0.03) break;
            }
            t += dt;
          }
          float haze = 1.0 - exp(-t0 * 0.00022);                               // far clouds melt into the haze
          col = mix(col, uFog * (1.0 - T), haze);
          gl_FragColor = vec4(col, 1.0 - T);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(30000, 620, 30000), mat);
    this.mesh.position.y = 1200; this.mesh.frustumCulled = false; this.mesh.renderOrder = -1;
    scene.add(this.mesh);
  }
  update(camera, t, sunDir, sunColor, ambient, fog, wind, night) {
    const u = this.uniforms;
    this.mesh.position.x = camera.position.x; this.mesh.position.z = camera.position.z;
    u.uTime.value = t; u.uSun.value.copy(sunDir); u.uSunColor.value.copy(sunColor);
    u.uAmb.value.copy(ambient); u.uFog.value.copy(fog); u.uWind.value.set(wind.x, wind.z);
  }
}

// crepuscular rays: take the sky pixels (depth at the far plane) that are bright, and smear them
// outward from the sun's screen position; add the result back on top of the image
export function godRaysPass() {
  return new ShaderPass({
    uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uStrength: { value: 0 }, uColor: { value: new THREE.Color(1, 0.9, 0.75) } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse, tDepth; uniform vec2 uSun; uniform float uStrength; uniform vec3 uColor;
      varying vec2 vUv;
      float sky(vec2 uv) {
        if (texture2D(tDepth, uv).x < 0.99999) return 0.0;                         // something solid is here
        vec3 c = texture2D(tDiffuse, uv).rgb;
        float l = dot(c, vec3(0.3, 0.59, 0.11));                                // HDR: the sun's disc is in the thousands
        return smoothstep(1.5, 12.0, min(l, 12.0));
      }
      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        if (uStrength <= 0.0) { gl_FragColor = base; return; }
        const int N = 56;
        vec2 d = (uSun - vUv) / float(N) * 0.92;
        vec2 uv = vUv; float acc = 0.0, w = 1.0;
        for (int i = 0; i < N; i++) { uv += d; acc += sky(clamp(uv, 0.001, 0.999)) * w; w *= 0.965; }
        acc /= float(N);
        float fall = 1.0 - smoothstep(0.0, 0.85, distance(vUv, uSun));
        gl_FragColor = vec4(base.rgb + uColor * acc * uStrength * fall, base.a);
      }`,
  });
}
