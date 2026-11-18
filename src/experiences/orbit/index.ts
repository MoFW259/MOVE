import * as THREE from 'three';
import { Grabber, type Grabbable } from '../../core/grab.ts';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// Orrery. Pinch a planet to pick it up (its orbit freezes), carry it anywhere in 3D, let go to throw it; while held, a dashed
// line previews the orbit the release would give. A slow release settles into a near-circular orbit right there, fast throws
// make ellipses, dropping it into the sun feeds the sun. Pinch the sun to drag the whole system; two hands on it scale/twist it.
// Physics runs in system-local units (sun at origin, radius 1); `sys` carries the sun's position/rotation/scale into world.

const GM = 12;
const PP = 0.05; // planet–planet gravity per unit mass (mild)
const EPS2 = 0.25; // planet–planet softening
const SUN_R = 1;
const R_ESC = 22;
const A_MAX = 8; // max semi-major axis after a throw, keeps orbits mostly in view
const THROW = 0.25; // hand speed (world/s) → orbital speed
const SUB = 6;
const TRAIL_N = 200;
const TRAIL_DT = 0.05;
const PREVIEW_N = 240;
const PREVIEW_DT = 0.06;
const MAX_CURSORS = 8;
const BURSTS = 8;
const DEAD_S = 0.7;
const SPAWN_S = 0.9;
const BURST_S = 1.1;
const FIT_X = 8.8; // local radius kept in view horizontally at scale 1
const FIT_Y = 5.5;
const ELEV = 0.55;
const FOV = 40;

const ROCK = 0, LAVA = 1, OCEAN = 2, ICE = 3, GAS = 4;
interface Def { r: number; size: number; kind: number; c: [string, string, string]; ring?: string }
const DEFS: Def[] = [
  { r: 1.9, size: 0.17, kind: ROCK, c: ['#8a7f78', '#d8c3a8', '#3e3430'] },
  { r: 2.6, size: 0.23, kind: LAVA, c: ['#2a100c', '#ff5a1a', '#ffd27a'] },
  { r: 3.4, size: 0.27, kind: OCEAN, c: ['#1d4e9e', '#5aa35f', '#f2f5ff'] },
  { r: 4.3, size: 0.21, kind: ICE, c: ['#cfeeff', '#79acd6', '#ffffff'] },
  { r: 5.2, size: 0.42, kind: GAS, c: ['#d39a5e', '#f3dcb2', '#8e4f2c'], ring: '#e8cfa0' },
  { r: 6.1, size: 0.33, kind: GAS, c: ['#6aa6cc', '#d6eef7', '#36689a'], ring: '#a9cde4' },
  { r: 7.0, size: 0.19, kind: ROCK, c: ['#7a4fb0', '#cfa2f0', '#2b1a40'] },
];

const noise = /* glsl */ `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
`;

const bodyVert = /* glsl */ `
  uniform float spin;
  varying vec3 vObj, vN, vView;
  void main() {
    float c = cos(spin), s = sin(spin);
    vObj = vec3(c * position.x + s * position.z, position.y, -s * position.x + c * position.z);
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const planetFrag = /* glsl */ `
  uniform vec3 c1, c2, c3, sunView;
  uniform float kind, seed, time, glow;
  varying vec3 vObj, vN, vView;
  ${noise}
  void main() {
    vec3 q = normalize(vObj);
    vec3 col, emit = vec3(0.0);
    float spec = 0.0;
    if (kind < 0.5) { // cratered rock
      float n = fbm(q * 3.0 + seed);
      col = mix(c3, mix(c1, c2, smoothstep(0.35, 0.7, n)), 0.35 + 0.65 * n);
      float cr = noise(q * 9.0 + seed * 1.7);
      col *= 0.72 + 0.4 * smoothstep(0.42, 0.62, cr) - 0.18 * smoothstep(0.7, 0.78, cr);
    } else if (kind < 1.5) { // lava: dark crust, glowing cracks
      float n = fbm(q * 3.5 + seed + vec3(0.0, time * 0.04, 0.0));
      float crack = 1.0 - smoothstep(0.0, 0.05, abs(n - 0.5));
      col = c1 * (0.7 + 0.8 * n);
      emit = mix(c2, c3, crack * crack) * crack * (0.75 + 0.25 * sin(time * 1.1 + n * 12.0));
    } else if (kind < 2.5) { // ocean world with clouds
      float n = fbm(q * 2.4 + seed);
      float land = smoothstep(0.5, 0.53, n);
      col = mix(c1, c2 * (0.65 + 0.6 * fbm(q * 9.0 + seed)), land);
      spec = (1.0 - land) * 0.5;
      col = mix(col, c3, smoothstep(0.78, 0.9, abs(q.y)));
      col = mix(col, c3, smoothstep(0.55, 0.78, fbm(q * 4.0 + vec3(time * 0.015, 0.0, 0.0) + seed + 9.0)) * 0.75);
    } else if (kind < 3.5) { // ice
      col = mix(c2, c1, fbm(q * vec3(2.0, 7.0, 2.0) + seed));
      col = mix(col, c3, smoothstep(0.62, 0.66, noise(q * 11.0 + seed)) * 0.5);
      spec = 0.35;
    } else { // banded gas giant
      float lat = q.y + 0.1 * (fbm(q * 3.0 + seed + vec3(time * 0.02, 0.0, 0.0)) - 0.5);
      col = mix(c1, c2, 0.5 + 0.5 * sin(lat * 19.0 + seed));
      col = mix(col, c3, (0.5 + 0.5 * sin(lat * 6.0 + seed * 2.0)) * 0.45);
    }
    vec3 N = normalize(vN), V = normalize(-vView), L = normalize(sunView - vView), H = normalize(L + V);
    float diff = max((dot(N, L) + 0.12) / 1.12, 0.0);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 c = col * (0.05 + 1.1 * diff) + spec * pow(max(dot(N, H), 0.0), 40.0) * diff + emit;
    c += mix(c2, vec3(1.0, 0.85, 0.6), 0.5) * rim * (0.25 * diff + glow * 0.9);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`;

const sunFrag = /* glsl */ `
  uniform vec3 cA, cB, cC;
  uniform float time, heat;
  varying vec3 vObj, vN, vView;
  ${noise}
  void main() {
    vec3 q = normalize(vObj);
    float n = fbm(q * 5.0 + vec3(0.0, time * 0.08, time * 0.05));
    float n2 = fbm(q * 12.0 - vec3(time * 0.1));
    vec3 col = mix(cA, cB, smoothstep(0.3, 0.7, n));
    col = mix(col, cC, smoothstep(0.55, 0.85, n2) * 0.6);
    float mu = max(dot(normalize(vN), normalize(-vView)), 0.0);
    col *= (0.6 + 0.6 * pow(mu, 0.4)) * heat;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

const ringVert = /* glsl */ `
  varying float vR;
  varying vec3 vN, vView;
  void main() {
    vR = length(position.xy);
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const ringFrag = /* glsl */ `
  uniform vec3 color, sunView;
  uniform float inner, outer, seed;
  varying float vR;
  varying vec3 vN, vView;
  void main() {
    float u = (vR - inner) / (outer - inner);
    float band = 0.55 + 0.45 * sin(u * 38.0 + seed) * sin(u * 11.0 + seed * 3.0);
    float gap = 1.0 - 0.7 * smoothstep(0.55, 0.6, u) * (1.0 - smoothstep(0.63, 0.68, u));
    float a = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.85, 1.0, u)) * band * gap;
    float lit = 0.35 + 0.65 * abs(dot(normalize(vN), normalize(sunView - vView)));
    gl_FragColor = vec4(color * lit, a * 0.85);
    #include <colorspace_fragment>
  }`;

// Trails and previews: aFade 0 at the head … 1 at the tail.
const lineVert = /* glsl */ `
  attribute float aFade;
  varying float vF;
  void main() { vF = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const trailFrag = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vF;
  void main() {
    gl_FragColor = vec4(color, pow(1.0 - vF, 1.6) * opacity);
    #include <colorspace_fragment>
  }`;

const previewFrag = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vF;
  void main() {
    if (fract(vF * 48.0) > 0.55) discard;
    gl_FragColor = vec4(color, (1.0 - vF) * opacity);
    #include <colorspace_fragment>
  }`;

const quadVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// 3D pinch cursor: the ring tightens as the fingers close, a dot fills in when pinched/holding.
const cursorFrag = /* glsl */ `
  uniform vec3 color;
  uniform float strength, held, hover, opacity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float rr = mix(0.85, 0.42, strength);
    float ring = 1.0 - smoothstep(0.0, 0.07 + 0.05 * held, abs(d - rr));
    float dotA = (1.0 - smoothstep(0.16, 0.22, d)) * max(strength * strength, held);
    float a = max(ring * (0.4 + 0.6 * max(hover, strength)), dotA) * opacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(color, a);
    #include <colorspace_fragment>
  }`;

const burstFrag = /* glsl */ `
  uniform vec3 color;
  uniform float t;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float ring = exp(-pow((d - t) / 0.07, 2.0));
    float core = exp(-d * d * 10.0) * (1.0 - t);
    float a = (ring * 0.9 + core) * (1.0 - t) * (1.0 - t);
    gl_FragColor = vec4(color, a);
    #include <colorspace_fragment>
  }`;

const starVert = /* glsl */ `
  attribute float aSize, aPhase;
  uniform float time, pr, twinkle;
  varying float vA, vT;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * pr;
    vA = 0.6 + 0.4 * sin(time * (0.3 + aPhase * 0.5) * twinkle + aPhase * 40.0);
    vT = aPhase;
  }`;

const starFrag = /* glsl */ `
  varying float vA, vT;
  void main() {
    float a = (1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5))) * vA;
    gl_FragColor = vec4(mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.82, 0.62), step(0.8, vT)), a);
    #include <colorspace_fragment>
  }`;

interface Planet extends Grabbable {
  object: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteMaterial;
  color: THREE.Color;
  home: number;
  size: number;
  user: number; // two-hand scale applied by the visitor
  spin: number;
  pos: THREE.Vector3; // local
  vel: THREE.Vector3;
  acc: THREE.Vector3;
  prev: THREE.Vector3; // local position last frame, for the held velocity estimate
  velEst: THREE.Vector3;
  alive: boolean;
  dead: number;
  spawn: number;
  hover: number;
  hoverTarget: number;
  held: boolean;
  grabScale: number;
  grabUser: number;
  trailPos: Float32Array;
  trailAttr: THREE.BufferAttribute;
  trailGeo: THREE.BufferGeometry;
  trailMat: THREE.ShaderMaterial;
  trailCount: number;
  trailClock: number;
  preview: THREE.Line;
  previewPos: Float32Array;
  previewAttr: THREE.BufferAttribute;
  previewGeo: THREE.BufferGeometry;
}

interface Burst { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t: number; size: number }
interface Cursor { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }

const fadeAttr = (n: number) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i / (n - 1);
  return new THREE.BufferAttribute(a, 1);
};

const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

export default (): Experience => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.35 : 1;

  let renderer: THREE.WebGLRenderer;
  let time = 0;
  let az = 0.4;
  let attn = 0;
  let dist = 16;
  let flare = 0;
  let sunHover = 0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050a1e');
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
  const shared = { time: { value: 0 }, sunView: { value: new THREE.Vector3() } };

  // Radial glow shared by halos and corona.
  const G = 64;
  const glowData = new Uint8Array(G * G * 4);
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - G / 2, y + 0.5 - G / 2) / (G / 2));
      const i = (y * G + x) * 4;
      glowData[i] = glowData[i + 1] = glowData[i + 2] = 255;
      glowData[i + 3] = Math.round(255 * Math.pow(1 - r, 2.2));
    }
  }
  const glowTex = new THREE.DataTexture(glowData, G, G);
  glowTex.magFilter = glowTex.minFilter = THREE.LinearFilter;
  glowTex.needsUpdate = true;
  const glowMat = (color: string, opacity: number) =>
    new THREE.SpriteMaterial({ map: glowTex, color, opacity, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

  // Stars.
  const STARS = 900;
  const starPos = new Float32Array(STARS * 3), starSize = new Float32Array(STARS), starPhase = new Float32Array(STARS);
  for (let i = 0; i < STARS; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    starPos.set([s * Math.cos(th) * 150, u * 150, s * Math.sin(th) * 150], i * 3);
    starSize[i] = 0.8 + Math.pow(Math.random(), 4) * 2.6;
    starPhase[i] = Math.random();
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { time: shared.time, pr: { value: 1 }, twinkle: { value: reduced ? 0 : 1 } },
    vertexShader: starVert,
    fragmentShader: starFrag,
    transparent: true,
    depthWrite: false,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  // Sun: the grabbable that carries the whole system.
  const sphereGeo = new THREE.SphereGeometry(1, 48, 32);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: {
      time: shared.time,
      spin: { value: 0 },
      heat: { value: 1 },
      cA: { value: new THREE.Color('#ff5a12') },
      cB: { value: new THREE.Color('#ffa73a') },
      cC: { value: new THREE.Color('#fff0c4') },
    },
    vertexShader: bodyVert,
    fragmentShader: sunFrag,
  });
  const sun = new THREE.Mesh(sphereGeo, sunMat);
  const coronaIn = new THREE.Sprite(glowMat('#ffc266', 0.85));
  const coronaOut = new THREE.Sprite(glowMat('#ff7a2a', 0.35));
  sun.add(coronaIn, coronaOut);
  scene.add(sun);
  const sunItem: Grabbable = { object: sun, radius: 1.2 };

  // System frame: local physics → world. Trails/previews live inside it.
  const sys = new THREE.Group();
  scene.add(sys);
  const inv = new THREE.Matrix4();

  const ringGeos: THREE.RingGeometry[] = [];
  const planets: Planet[] = DEFS.map((d, i) => {
    const color = new THREE.Color(d.c[1]);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        time: shared.time,
        sunView: shared.sunView,
        spin: { value: i * 1.3 },
        kind: { value: d.kind },
        seed: { value: i * 7.31 + 1.3 },
        glow: { value: 0 },
        c1: { value: new THREE.Color(d.c[0]) },
        c2: { value: color },
        c3: { value: new THREE.Color(d.c[2]) },
      },
      vertexShader: bodyVert,
      fragmentShader: planetFrag,
    });
    const object = new THREE.Mesh(sphereGeo, mat);
    const haloMat = glowMat(d.c[1], 0.12);
    const halo = new THREE.Sprite(haloMat);
    object.add(halo);
    if (d.ring) {
      const geo = new THREE.RingGeometry(1.45, 2.4, 96, 1);
      ringGeos.push(geo);
      const ring = new THREE.Mesh(
        geo,
        new THREE.ShaderMaterial({
          uniforms: { color: { value: new THREE.Color(d.ring) }, sunView: shared.sunView, inner: { value: 1.45 }, outer: { value: 2.4 }, seed: { value: i * 3.1 } },
          vertexShader: ringVert,
          fragmentShader: ringFrag,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.set(-Math.PI / 2 + 0.42 - i * 0.12, 0, 0.2);
      object.add(ring);
    }
    scene.add(object);

    const trailPos = new Float32Array(TRAIL_N * 3);
    const trailAttr = new THREE.BufferAttribute(trailPos, 3);
    trailAttr.setUsage(THREE.DynamicDrawUsage);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', trailAttr);
    trailGeo.setAttribute('aFade', fadeAttr(TRAIL_N));
    trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: color }, opacity: { value: 0 } },
      vertexShader: lineVert,
      fragmentShader: trailFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    trail.frustumCulled = false;
    sys.add(trail);

    const previewPos = new Float32Array(PREVIEW_N * 3);
    const previewAttr = new THREE.BufferAttribute(previewPos, 3);
    previewAttr.setUsage(THREE.DynamicDrawUsage);
    const previewGeo = new THREE.BufferGeometry();
    previewGeo.setAttribute('position', previewAttr);
    previewGeo.setAttribute('aFade', fadeAttr(PREVIEW_N));
    const preview = new THREE.Line(
      previewGeo,
      new THREE.ShaderMaterial({
        uniforms: { color: { value: color }, opacity: { value: 0.9 } },
        vertexShader: lineVert,
        fragmentShader: previewFrag,
        transparent: true,
        depthWrite: false,
      }),
    );
    preview.frustumCulled = false;
    preview.visible = false;
    sys.add(preview);

    const p: Planet = {
      object, radius: 0.6, enabled: true, mat, halo, haloMat, color,
      home: d.r, size: d.size, user: 1, spin: 0.25 + ((i * 0.37) % 0.4),
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), acc: new THREE.Vector3(), prev: new THREE.Vector3(), velEst: new THREE.Vector3(),
      alive: true, dead: 0, spawn: SPAWN_S, hover: 0, hoverTarget: 0, held: false, grabScale: 1, grabUser: 1,
      trailPos, trailAttr, trailGeo, trailMat, trailCount: 0, trailClock: 0,
      preview, previewPos, previewAttr, previewGeo,
    };
    placeOnOrbit(p, i * 2.4, 0.06 * Math.sin(i * 1.7));
    return p;
  });

  const items: Grabbable[] = [sunItem, ...planets];
  const grabber = new Grabber(camera, items);

  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const bursts: Burst[] = [];
  for (let i = 0; i < BURSTS; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, t: { value: 1 } },
      vertexShader: quadVert,
      fragmentShader: burstFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(quadGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    bursts.push({ mesh, mat, t: 1, size: 1 });
  }

  const cursors: Cursor[] = [];
  for (let i = 0; i < MAX_CURSORS; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color('#ffd79a') }, strength: { value: 0 }, held: { value: 0 }, hover: { value: 0 }, opacity: { value: 0.9 } },
      vertexShader: quadVert,
      fragmentShader: cursorFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(quadGeo, mat);
    mesh.renderOrder = 10;
    mesh.visible = false;
    scene.add(mesh);
    cursors.push({ mesh, mat });
  }

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const simP = new THREE.Vector3();
  const simV = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const warm = new THREE.Color('#ffcf7a');
  const cursorIdle = new THREE.Color('#ffd79a');
  const cursorHeld = new THREE.Color('#fff4e0');

  function placeOnOrbit(p: Planet, phase: number, incl: number) {
    p.pos.set(Math.cos(phase) * p.home, 0, Math.sin(phase) * p.home);
    const vc = Math.sqrt(GM / p.home);
    // Prograde tangent Y × r, tilted slightly out of the plane.
    p.vel.set(p.pos.z, 0, -p.pos.x).setLength(vc * Math.cos(incl));
    p.vel.y = vc * Math.sin(incl);
  }

  function burst(at: THREE.Vector3, color: THREE.Color, size: number) {
    let b = bursts[0];
    for (const c of bursts) if (c.t > b.t) b = c;
    b.t = 0;
    b.size = size * (reduced ? 0.6 : 1);
    b.mat.uniforms.color.value.copy(color);
    b.mesh.position.copy(at);
    b.mesh.visible = true;
  }

  function kill(p: Planet, intoSun: boolean) {
    p.alive = false;
    p.enabled = false;
    p.dead = 0;
    p.object.visible = false;
    p.trailCount = 0;
    p.trailGeo.setDrawRange(0, 0);
    if (intoSun) {
      flare = reduced ? 0.4 : 1;
      burst(p.object.position, warm, 3.2 * sun.scale.x);
    } else burst(p.object.position, p.color, 2);
  }

  function respawn(p: Planet) {
    p.alive = true;
    p.enabled = true;
    p.spawn = 0;
    p.user = 1;
    p.object.visible = true;
    p.object.quaternion.identity();
    placeOnOrbit(p, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.12);
    p.trailCount = 0;
    p.trailGeo.setDrawRange(0, 0);
    burst(tmp.copy(p.pos).applyMatrix4(sys.matrix), p.color, 1.6 * sun.scale.x);
  }

  // Release velocity: hand speed scaled down; a slow release gets topped up to a circular orbit, energy capped so it stays bound.
  function throwVelocity(pos: THREE.Vector3, raw: THREE.Vector3, out: THREE.Vector3) {
    out.copy(raw).multiplyScalar(THROW);
    const r = Math.max(pos.length(), SUN_R * 1.2);
    const vc = Math.sqrt(GM / r);
    const assist = Math.max(0, 1 - out.length() / vc);
    tmp2.crossVectors(UP, pos);
    if (tmp2.lengthSq() < 1e-6) tmp2.set(1, 0, 0);
    out.addScaledVector(tmp2.normalize(), vc * assist);
    const vmax2 = Math.max(2 * GM / r - GM / A_MAX, (0.25 * GM) / r);
    if (out.lengthSq() > vmax2) out.setLength(Math.sqrt(vmax2));
    return out;
  }

  grabber.onGrab = (item) => {
    if (item === sunItem) return;
    const p = item as Planet;
    p.held = true;
    p.grabScale = p.object.scale.x;
    p.grabUser = p.user;
    p.prev.copy(p.pos);
    p.velEst.set(0, 0, 0);
    p.preview.visible = true;
  };

  grabber.onRelease = (item) => {
    if (item === sunItem) return;
    const p = item as Planet;
    p.held = false;
    p.preview.visible = false;
    p.user = THREE.MathUtils.clamp((p.grabUser * p.object.scale.x) / p.grabScale, 0.6, 2);
    p.pos.copy(p.object.position).applyMatrix4(inv);
    if (p.pos.length() < SUN_R) return kill(p, true);
    throwVelocity(p.pos, p.velEst, p.vel);
    p.trailCount = 0;
    p.trailClock = 0;
  };

  function mass(p: Planet) {
    const k = (p.size * p.user) / 0.3;
    return k * k * k;
  }

  function physics(dt: number) {
    const h = dt / SUB;
    for (let s = 0; s < SUB; s++) {
      for (const p of planets) {
        if (!p.alive) continue;
        const r2 = Math.max(p.pos.lengthSq(), 0.04);
        p.acc.copy(p.pos).multiplyScalar(-GM / (r2 * Math.sqrt(r2)));
      }
      for (let i = 0; i < planets.length; i++) {
        const a = planets[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < planets.length; j++) {
          const b = planets[j];
          if (!b.alive) continue;
          tmp.subVectors(b.pos, a.pos);
          const d2 = tmp.lengthSq() + EPS2;
          const f = PP / (d2 * Math.sqrt(d2));
          a.acc.addScaledVector(tmp, f * mass(b));
          b.acc.addScaledVector(tmp, -f * mass(a));
        }
      }
      for (const p of planets) {
        if (!p.alive || p.held) continue;
        p.vel.addScaledVector(p.acc, h);
        p.pos.addScaledVector(p.vel, h);
      }
    }
  }

  function updatePreview(p: Planet) {
    throwVelocity(p.pos, p.velEst, simV);
    simP.copy(p.pos);
    const pos = p.previewPos;
    simP.toArray(pos, 0);
    let n = 1;
    const h = PREVIEW_DT / 3;
    for (; n < PREVIEW_N; n++) {
      for (let k = 0; k < 3; k++) {
        const r2 = Math.max(simP.lengthSq(), 0.04);
        simV.addScaledVector(simP, (-GM / (r2 * Math.sqrt(r2))) * h);
        simP.addScaledVector(simV, h);
      }
      simP.toArray(pos, n * 3);
      const r = simP.length();
      if (r < SUN_R || r > R_ESC) {
        n++;
        break;
      }
    }
    p.previewGeo.setDrawRange(0, n);
    p.previewAttr.needsUpdate = true;
  }

  function updateTrail(p: Planet, dt: number) {
    const target = p.held || !p.alive ? 0 : 0.8;
    const op = p.trailMat.uniforms.opacity;
    op.value += (target - op.value) * (1 - Math.exp(-(p.held ? 6 : 2) * dt));
    if (p.held || !p.alive) return;
    const a = p.trailPos;
    p.trailClock += dt;
    if (p.trailCount === 0 || p.trailClock >= TRAIL_DT) {
      p.trailClock = 0;
      a.copyWithin(3, 0, (TRAIL_N - 1) * 3);
      p.trailCount = Math.min(p.trailCount + 1, TRAIL_N);
    }
    p.pos.toArray(a, 0); // live head
    p.trailGeo.setDrawRange(0, p.trailCount);
    p.trailAttr.needsUpdate = true;
  }

  function placeCamera() {
    const el = ELEV + 0.05 * Math.sin(time * 0.07) * motion;
    camera.position.set(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), dist * Math.cos(el) * Math.cos(az));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }

  return {
    id: 'orbit',
    title: meta.title,
    hint: { text: '행성을 집어서 던져 궤도를 만들어 보세요', gesture: 'pinch' },
    needs: ['hands'],

    async init(ctx) {
      renderer = ctx.renderer;
      starMat.uniforms.pr.value = renderer.getPixelRatio();
    },

    frame(input, rawDt) {
      const dt = Math.min(rawDt, 1 / 30);
      time += dt;
      shared.time.value = time;

      // Camera drifts while idle and holds still while someone is aiming.
      const busy = grabber.held.size > 0 || grabber.hovered.size > 0 ? 1 : 0;
      attn += (busy - attn) * (1 - Math.exp(-3 * dt));
      az += dt * 0.045 * motion * (1 - attn);
      placeCamera();

      // Grab radii follow the visible size; generous so small planets are easy to catch.
      for (const p of planets) p.radius = Math.max(0.6, p.object.scale.x * 2.4);
      sunItem.radius = 1.2 * sun.scale.x;
      grabber.update(input.hands, dt);

      // System frame from the sun.
      const sunHeld = grabber.isHeld(sunItem);
      sun.scale.setScalar(THREE.MathUtils.clamp(sun.scale.x, 0.5, 2));
      if (!sunHeld) sun.position.multiplyScalar(Math.exp(-2.5 * dt)); // drift back to center
      sys.position.copy(sun.position);
      sys.quaternion.copy(sun.quaternion);
      sys.scale.copy(sun.scale);
      sys.updateMatrix();
      inv.copy(sys.matrix).invert();
      const S = sun.scale.x;

      // Held planets: read their local position from the hand, estimate velocity, preview the throw.
      for (const p of planets) {
        if (!p.held) continue;
        p.pos.copy(p.object.position).applyMatrix4(inv);
        if (dt > 0) p.velEst.lerp(tmp.subVectors(p.pos, p.prev).divideScalar(dt), 0.35);
        p.prev.copy(p.pos);
        updatePreview(p);
      }

      physics(dt);

      for (const p of planets) {
        if (!p.alive) {
          p.dead += dt;
          if (p.dead > DEAD_S) respawn(p);
          continue;
        }
        if (!p.held) {
          const r = p.pos.length();
          if (r < SUN_R) {
            p.object.position.copy(p.pos).applyMatrix4(sys.matrix);
            kill(p, true);
            continue;
          }
          if (r > R_ESC) {
            p.object.position.copy(p.pos).applyMatrix4(sys.matrix);
            kill(p, false);
            continue;
          }
          p.object.position.copy(p.pos).applyMatrix4(sys.matrix);
          p.mat.uniforms.spin.value += p.spin * dt * motion;
        }
        updateTrail(p, dt);
      }

      // Hover anticipation: the closer the fingers, the bigger the halo.
      for (const p of planets) p.hoverTarget = 0;
      let sunTarget = sunHeld ? 1 : 0;
      for (const h of input.hands) {
        const it = grabber.hovered.get(h.id);
        if (!it) continue;
        const v = 0.3 + 0.7 * h.pinchStrength;
        if (it === sunItem) sunTarget = Math.max(sunTarget, v);
        else (it as Planet).hoverTarget = Math.max((it as Planet).hoverTarget, v);
      }
      const k = 1 - Math.exp(-12 * dt);
      for (const p of planets) {
        if (!p.alive) continue;
        p.hover += (p.hoverTarget - p.hover) * k;
        if (p.held) {
          p.haloMat.opacity = 0.8 + 0.12 * Math.sin(time * 6) * motion;
          p.halo.scale.setScalar(5.6);
          p.mat.uniforms.glow.value = 1;
          continue;
        }
        if (p.spawn < SPAWN_S) p.spawn = Math.min(SPAWN_S, p.spawn + dt);
        const grow = easeOutBack(p.spawn / SPAWN_S);
        p.object.scale.setScalar(p.size * p.user * S * grow * (1 + 0.15 * p.hover));
        p.haloMat.opacity = 0.12 + 0.6 * p.hover;
        p.halo.scale.setScalar(3.2 + 2.6 * p.hover);
        p.mat.uniforms.glow.value = p.hover;
      }

      // Sun: corona swells under a hovering pinch and flares when fed.
      sunHover += (sunTarget - sunHover) * k;
      flare *= Math.exp(-1.4 * dt);
      sunMat.uniforms.heat.value = 1 + 0.35 * sunHover + 0.6 * flare;
      coronaIn.scale.setScalar(3.3 * (1 + 0.25 * sunHover + 0.4 * flare));
      coronaOut.scale.setScalar(7.5 * (1 + 0.15 * sunHover + 0.3 * flare) * (1 + 0.03 * Math.sin(time * 0.8) * motion));
      coronaIn.material.opacity = 0.75 + 0.2 * sunHover;

      // 3D pinch cursors.
      for (let i = 0; i < MAX_CURSORS; i++) {
        const c = cursors[i];
        const h = input.hands[i];
        if (!h) {
          c.mesh.visible = false;
          continue;
        }
        const pt = grabber.points.get(h.id);
        if (pt) c.mesh.position.copy(pt);
        else {
          const ray = grabber.rayAt(h.pinchPoint.x, h.pinchPoint.y);
          const t = tmp.subVectors(sun.position, ray.origin).dot(ray.direction);
          c.mesh.position.copy(ray.origin).addScaledVector(ray.direction, Math.max(t, 2));
        }
        const held = grabber.held.has(h.id) ? 1 : 0;
        const hover = grabber.hovered.has(h.id) ? 1 : 0;
        const u = c.mat.uniforms;
        u.strength.value = held ? 1 : h.pinchStrength;
        u.held.value = held;
        u.hover.value = hover;
        u.opacity.value = held || hover ? 0.95 : 0.6;
        u.color.value.copy(held ? cursorHeld : cursorIdle);
        c.mesh.quaternion.copy(camera.quaternion);
        c.mesh.scale.setScalar(camera.position.distanceTo(c.mesh.position) * 0.05);
        c.mesh.visible = true;
      }

      for (const b of bursts) {
        if (b.t >= 1) continue;
        b.t = Math.min(1, b.t + dt / BURST_S);
        b.mat.uniforms.t.value = b.t;
        b.mesh.visible = b.t < 1;
        b.mesh.quaternion.copy(camera.quaternion);
        b.mesh.scale.setScalar(b.size * (0.4 + 0.6 * b.t));
      }

      shared.sunView.value.copy(sun.position).applyMatrix4(camera.matrixWorldInverse);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },

    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      dist = Math.max(FIT_X / (t * Math.max(camera.aspect, 0.75)), FIT_Y / t);
    },

    dispose() {
      scene.traverse((o) => {
        // Sprites share three's module-level quad geometry; it is not ours to free.
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        } else if (o instanceof THREE.Sprite) o.material.dispose();
      });
      glowTex.dispose();
    },
  };
};
