import * as THREE from 'three';
import type { Experience, Hand } from '../../core/types.ts';
import meta from './meta.ts';

// Pinch drops a seed; a seeded fractal tree grows from the ground line. Pinch a branch tip to pull the tree over; it springs back on release.
// Hand motion blows wind, an open palm above a tree makes it bloom.
// Geometry: one prebuilt quad per branch (written once at planting into preallocated buffers); growth and sway run in the vertex shader.
const MAX_TREES = 12;
const SLOTS = MAX_TREES + 3; // room for trees still fading out
const MAX_BR = 1024; // branches per tree (quads); worst case of the generator is ~600
const MAX_PET = 1024; // petals per tree
const MAX_HANDS = 8;
const GROUND = 0.14; // ground line, screen heights from the bottom
const GROW_S = 3;
const FADE_S = 1.5;
const BLOOM_S = 1.4;
const PLANT_COOLDOWN = 0.35;
const TIP_R = 0.07; // branch-tip pick radius (screen heights)
const K = 10; // sway spring stiffness
const C = 1.6; // sway damping (underdamped: trees rock back after a gust)

const PALETTES: [string, string][] = [
  ['#e0482b', '#f4a6a0'], // vermilion / pink
  ['#e8a93a', '#e0482b'], // mustard / vermilion
  ['#f4a6a0', '#c2185b'], // pink / magenta
  ['#3f7d4e', '#9cc45a'], // leaf greens
];

const common = /* glsl */ `
  uniform float aspect, time, flutter, heightPx, ground;
  uniform vec4 tree; // x (0..1), scale (screen heights per local unit), grow 0..1, bend
  // Bend grows with height squared: trunk stays put, tips swing.
  vec2 sway(vec2 p) {
    float h = max(p.y, 0.0) / 3.0;
    float h2 = h * h;
    float o = tree.w * h2 * 0.9 + flutter * h2 * 0.05 * sin(time * 2.1 + p.x * 3.0 + p.y * 1.7 + tree.x * 20.0);
    return vec2(p.x + o, p.y - abs(o) * 0.35 * h);
  }
  vec2 toWorld(vec2 local) { return vec2(tree.x * aspect, ground) + local * tree.y; }
  vec4 toClip(vec2 w) { return vec4(w.x / aspect * 2.0 - 1.0, w.y * 2.0 - 1.0, 0.0, 1.0); }
`;

const branchVert = /* glsl */ `
  ${common}
  attribute vec4 aSeg;    // start.xy, end.xy (local units, root at 0,0)
  attribute vec4 aInfo;   // width start, width end, grow start, grow end
  attribute vec2 aCorner; // along 0/1, side -1/1
  void main() {
    float g = clamp((tree.z - aInfo.z) / max(aInfo.w - aInfo.z, 1e-4), 0.0, 1.0);
    vec2 a = toWorld(sway(aSeg.xy));
    vec2 b = toWorld(sway(mix(aSeg.xy, aSeg.zw, g)));
    vec2 d = b - a;
    float len = length(d);
    vec2 dir = len > 1e-6 ? d / len : vec2(0.0, 1.0);
    float w = step(1e-4, g) * max(mix(aInfo.x, aInfo.y, aCorner.x) * tree.y, 1.3 / heightPx);
    // Push both ends out by part of the width so joints between parent and child close up.
    vec2 p = mix(a, b, aCorner.x) + vec2(-dir.y, dir.x) * aCorner.y * w * 0.5 + dir * (aCorner.x * 2.0 - 1.0) * w * 0.4;
    gl_Position = toClip(p);
  }`;

const branchFrag = /* glsl */ `
  uniform vec3 ink;
  uniform float alpha;
  void main() {
    gl_FragColor = vec4(ink, alpha);
    #include <colorspace_fragment>
  }`;

const petalVert = /* glsl */ `
  ${common}
  uniform float bloom;
  attribute vec4 aTip; // tip.xy, offset.xy (local units)
  attribute vec4 aPet; // delay, size (local units), color mix, grow time of its branch end
  varying float vSize, vMix;
  void main() {
    float s = clamp((bloom - aPet.x) / 0.3, 0.0, 1.0);
    float pop = (s + sin(s * 3.14159265) * 0.4) * step(aPet.w, tree.z + 1e-4);
    gl_Position = toClip(toWorld(sway(aTip.xy) + aTip.zw * pop));
    vSize = aPet.y * tree.y * heightPx * pop;
    vMix = aPet.z;
    gl_PointSize = vSize;
  }`;

const petalFrag = /* glsl */ `
  uniform vec3 c1, c2;
  uniform float alpha;
  varying float vSize, vMix;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = 1.0 - smoothstep(0.5 - 1.5 / max(vSize, 1.0), 0.5, r);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(mix(c1, c2, vMix), a * alpha);
    #include <colorspace_fragment>
  }`;

// Pinch cursor: 0 seed forming between the fingers, 1 ring tightening around a branch tip, 2 holding a tip.
const markerVert = /* glsl */ `
  attribute vec2 aState; // pinch strength, mode
  varying vec2 vState;
  varying float vSize;
  void main() {
    vState = aState;
    vSize = position.z;
    gl_PointSize = position.z;
    gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
  }`;

const markerFrag = /* glsl */ `
  uniform vec3 ink, accent;
  varying vec2 vState;
  varying float vSize;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float aa = 3.0 / max(vSize, 1.0);
    float s = vState.x, mode = vState.y;
    float dotR = mode < 0.5 ? 0.15 + 0.4 * s : mode < 1.5 ? 0.14 : 0.42;
    float ringR = mode < 0.5 ? -1.0 : mode < 1.5 ? mix(0.9, 0.5, s) : 0.8;
    float a = max(1.0 - smoothstep(dotR - aa, dotR, r), 1.0 - smoothstep(0.06, 0.06 + aa, abs(r - ringR)));
    a *= mode < 0.5 ? s : 1.0;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(mode < 0.5 ? ink : accent, a);
    #include <colorspace_fragment>
  }`;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface HandState { pinch: boolean; next: number; seen: number; tree: number; tip: number } // tree/tip: held branch tip or -1

export default (): Experience => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.4 : 1;

  let renderer: THREE.WebGLRenderer;
  let aspect = 1;
  let time = 0;
  let frameNo = 0;
  let plantCount = 0;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // unused: shaders write clip space directly

  const ink = new THREE.Color(meta.ink);
  const shared = {
    aspect: { value: 1 },
    time: { value: 0 },
    flutter: { value: motion },
    heightPx: { value: 1 },
    ground: { value: GROUND },
    ink: { value: ink },
  };

  // Paper, soil band and ground line in one full-screen pass.
  const groundGeo = new THREE.PlaneGeometry(2, 2);
  const groundMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, paper: { value: new THREE.Color(meta.bg) }, soil: { value: new THREE.Color('#e2d9c2') } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform vec3 paper, soil, ink;
      uniform float heightPx, ground;
      void main() {
        float y = gl_FragCoord.y / heightPx;
        vec3 c = y < ground ? soil : paper;
        c = mix(c, ink, 1.0 - smoothstep(0.75, 1.75, abs(y - ground) * heightPx));
        // Static paper grain (per pixel, never animated).
        c += (fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.02;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.frustumCulled = false;
  groundMesh.renderOrder = -1;
  scene.add(groundMesh);

  // Quad corners and indices are identical for every tree.
  const corners = new Float32Array(MAX_BR * 8);
  const indices = new Uint16Array(MAX_BR * 6);
  for (let i = 0; i < MAX_BR; i++) {
    corners.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
    const v = i * 4;
    indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6); // CCW: side -1 is right of the branch direction
  }

  // Tree slots (struct of arrays).
  const active = new Uint8Array(SLOTS);
  const fading = new Uint8Array(SLOTS);
  const landed = new Uint8Array(SLOTS);
  const born = new Float64Array(SLOTS);
  const tx = new Float32Array(SLOTS);
  const seedY = new Float32Array(SLOTS), seedV = new Float32Array(SLOTS);
  const growT = new Float32Array(SLOTS);
  const alpha = new Float32Array(SLOTS);
  const bend = new Float32Array(SLOTS), bendV = new Float32Array(SLOTS), windT = new Float32Array(SLOTS);
  const bloom = new Float32Array(SLOTS);
  const grabbed = new Uint8Array(SLOTS), grabBend = new Float32Array(SLOTS); // held by a pinch, bend it is pulled to
  const npCount = new Uint16Array(SLOTS); // branch tips (petal anchors) per tree

  const segAttr: THREE.BufferAttribute[] = [];
  const infoAttr: THREE.BufferAttribute[] = [];
  const tipAttr: THREE.BufferAttribute[] = [];
  const petAttr: THREE.BufferAttribute[] = [];
  const branchGeo: THREE.BufferGeometry[] = [];
  const petalGeo: THREE.BufferGeometry[] = [];
  const branchMesh: THREE.Mesh[] = [];
  const petalPts: THREE.Points[] = [];
  const treeU: { value: THREE.Vector4 }[] = [];
  const alphaU: { value: number }[] = [];
  const bloomU: { value: number }[] = [];
  const c1U: { value: THREE.Color }[] = [];
  const c2U: { value: THREE.Color }[] = [];
  const materials: THREE.ShaderMaterial[] = [];

  for (let s = 0; s < SLOTS; s++) {
    const tree = { value: new THREE.Vector4() };
    const al = { value: 0 };
    const bl = { value: 0 };
    const c1 = { value: new THREE.Color() };
    const c2 = { value: new THREE.Color() };
    treeU.push(tree);
    alphaU.push(al);
    bloomU.push(bl);
    c1U.push(c1);
    c2U.push(c2);

    const g = new THREE.BufferGeometry();
    segAttr.push(new THREE.BufferAttribute(new Float32Array(MAX_BR * 16), 4));
    infoAttr.push(new THREE.BufferAttribute(new Float32Array(MAX_BR * 16), 4));
    g.setAttribute('aSeg', segAttr[s]);
    g.setAttribute('aInfo', infoAttr[s]);
    g.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    // three needs a position attribute to know the vertex count; it is unused by the shader.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BR * 12), 3));
    const bm = new THREE.ShaderMaterial({
      uniforms: { ...shared, tree, alpha: al },
      vertexShader: branchVert,
      fragmentShader: branchFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, bm);
    mesh.frustumCulled = false;
    mesh.visible = false;
    branchGeo.push(g);
    branchMesh.push(mesh);

    const pg = new THREE.BufferGeometry();
    tipAttr.push(new THREE.BufferAttribute(new Float32Array(MAX_PET * 4), 4));
    petAttr.push(new THREE.BufferAttribute(new Float32Array(MAX_PET * 4), 4));
    pg.setAttribute('aTip', tipAttr[s]);
    pg.setAttribute('aPet', petAttr[s]);
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PET * 3), 3));
    const pm = new THREE.ShaderMaterial({
      uniforms: { ...shared, tree, alpha: al, bloom: bl, c1, c2 },
      vertexShader: petalVert,
      fragmentShader: petalFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const pts = new THREE.Points(pg, pm);
    pts.frustumCulled = false;
    pts.visible = false;
    petalGeo.push(pg);
    petalPts.push(pts);
    materials.push(bm, pm);
    scene.add(mesh, pts);
  }

  // Falling seeds: x (0..1), y (screen heights from bottom), point size px.
  const seedPos = new Float32Array(SLOTS * 3);
  const seedAttr = new THREE.BufferAttribute(seedPos, 3).setUsage(THREE.DynamicDrawUsage);
  const seedGeo = new THREE.BufferGeometry();
  seedGeo.setAttribute('position', seedAttr);
  const seedMat = new THREE.ShaderMaterial({
    uniforms: { ink: shared.ink },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = position.z; }',
    fragmentShader: /* glsl */ `
      uniform vec3 ink;
      void main() {
        if (length(gl_PointCoord - 0.5) > 0.5) discard;
        gl_FragColor = vec4(ink, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, // sort after the (transparent) trees so seeds fall in front
    depthTest: false,
    depthWrite: false,
  });
  const seeds = new THREE.Points(seedGeo, seedMat);
  seeds.frustumCulled = false;
  seeds.renderOrder = 1e6;
  scene.add(seeds);

  // Pinch cursors, one per hand: x (0..1), y (screen heights from bottom), point size px; state = strength, mode.
  const markerPos = new Float32Array(MAX_HANDS * 3), markerState = new Float32Array(MAX_HANDS * 2);
  const markerPosAttr = new THREE.BufferAttribute(markerPos, 3).setUsage(THREE.DynamicDrawUsage);
  const markerStateAttr = new THREE.BufferAttribute(markerState, 2).setUsage(THREE.DynamicDrawUsage);
  const markerGeo = new THREE.BufferGeometry();
  markerGeo.setAttribute('position', markerPosAttr);
  markerGeo.setAttribute('aState', markerStateAttr);
  const markerMat = new THREE.ShaderMaterial({
    uniforms: { ink: shared.ink, accent: { value: new THREE.Color(PALETTES[0][0]) } },
    vertexShader: markerVert,
    fragmentShader: markerFrag,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const markers = new THREE.Points(markerGeo, markerMat);
  markers.frustumCulled = false;
  markers.renderOrder = 1e6 + 1;
  scene.add(markers);

  // Generator write cursors (module-level so the recursion needs no closures per call).
  let rnd = mulberry32(1);
  let nb = 0, np = 0;
  let seg!: Float32Array, info!: Float32Array, tip!: Float32Array, pet!: Float32Array;
  let spread = 0.5, ratio = 0.74, maxDepth = 8, tripleP = 0.2;

  function branch(x: number, y: number, ang: number, len: number, w: number, depth: number, t0: number) {
    if (nb >= MAX_BR) return;
    const ex = x + Math.sin(ang) * len, ey = y + Math.cos(ang) * len;
    const w1 = w * 0.7, t1 = t0 + len;
    for (let c = 0; c < 4; c++) {
      const o = (nb * 4 + c) * 4;
      seg[o] = x; seg[o + 1] = y; seg[o + 2] = ex; seg[o + 3] = ey;
      info[o] = w; info[o + 1] = w1; info[o + 2] = t0; info[o + 3] = t1;
    }
    nb++;
    const prune = depth > 3 && rnd() < 0.07;
    if (depth >= maxDepth || prune) {
      // Tip: one main petal plus sometimes a smaller companion.
      const n = rnd() < 0.45 ? 2 : 1;
      for (let k = 0; k < n && np < MAX_PET; k++, np++) {
        const a = rnd() * Math.PI * 2, r = k === 0 ? rnd() * 0.03 : 0.04 + rnd() * 0.05;
        tip[np * 4] = ex; tip[np * 4 + 1] = ey; tip[np * 4 + 2] = Math.cos(a) * r; tip[np * 4 + 3] = Math.sin(a) * r;
        pet[np * 4] = rnd() * 0.7; pet[np * 4 + 1] = (k === 0 ? 0.09 : 0.05) + rnd() * 0.06;
        pet[np * 4 + 2] = rnd() < 0.3 ? 1 : 0; pet[np * 4 + 3] = t1;
      }
      return;
    }
    const n = depth < 2 && rnd() < tripleP ? 3 : 2;
    const sp = spread * (0.7 + rnd() * 0.6);
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * (n === 3 ? sp * 0.8 : sp);
      // Slight pull back toward vertical keeps crowns upright.
      const a = ang * 0.9 + off + (rnd() - 0.5) * 0.35;
      branch(ex, ey, a, len * ratio * (0.8 + rnd() * 0.35), w1, depth + 1, t1);
    }
  }

  function build(s: number, seed: number) {
    rnd = mulberry32(seed);
    nb = np = 0;
    seg = segAttr[s].array as Float32Array;
    info = infoAttr[s].array as Float32Array;
    tip = tipAttr[s].array as Float32Array;
    pet = petAttr[s].array as Float32Array;
    spread = 0.35 + rnd() * 0.35;
    ratio = 0.68 + rnd() * 0.1;
    maxDepth = 7 + (rnd() < 0.5 ? 1 : 0);
    tripleP = rnd() * 0.35;
    const trunk = 0.8 + rnd() * 0.4;
    branch(0, 0, (rnd() - 0.5) * 0.15, trunk, 0.09, 0, 0);
    // Normalize growth timing so the longest root-to-tip path ends at 1.
    let tMax = 1e-6;
    for (let i = 0; i < nb * 16; i += 4) tMax = Math.max(tMax, info[i + 3]);
    for (let i = 0; i < nb * 16; i += 4) { info[i + 2] /= tMax; info[i + 3] /= tMax; }
    for (let i = 0; i < np * 4; i += 4) pet[i + 3] /= tMax;
    segAttr[s].needsUpdate = infoAttr[s].needsUpdate = tipAttr[s].needsUpdate = petAttr[s].needsUpdate = true;
    branchGeo[s].setDrawRange(0, nb * 6);
    petalGeo[s].setDrawRange(0, np);
    npCount[s] = np;
    const pal = PALETTES[Math.floor(rnd() * PALETTES.length)];
    c1U[s].value.set(pal[0]);
    c2U[s].value.set(pal[1]);
    treeU[s].value.y = 0.12 + rnd() * 0.06;
  }

  function plant(x: number, yTop: number, seed: number, grown: boolean) {
    let live = 0, oldest = -1;
    for (let s = 0; s < SLOTS; s++) {
      if (!active[s] || fading[s]) continue;
      live++;
      if (oldest < 0 || born[s] < born[oldest]) oldest = s;
    }
    if (live >= MAX_TREES) fading[oldest] = 1;
    let slot = -1;
    for (let s = 0; s < SLOTS && slot < 0; s++) if (!active[s]) slot = s;
    if (slot < 0) for (let s = 0; s < SLOTS; s++) if (fading[s] && (slot < 0 || alpha[s] < alpha[slot])) slot = s;
    if (slot < 0) return;

    build(slot, seed);
    active[slot] = 1;
    fading[slot] = 0;
    born[slot] = plantCount++;
    tx[slot] = Math.min(0.97, Math.max(0.03, x));
    seedY[slot] = Math.max(GROUND, 1 - yTop);
    seedV[slot] = 0;
    landed[slot] = grown ? 1 : 0;
    growT[slot] = grown ? GROW_S : 0;
    alpha[slot] = grown ? 1 : 0;
    bend[slot] = bendV[slot] = windT[slot] = 0;
    grabbed[slot] = 0;
    bloom[slot] = 0;
    // Later trees draw on top.
    branchMesh[slot].renderOrder = born[slot] * 2;
    petalPts[slot].renderOrder = born[slot] * 2 + 1;
  }

  // Idle scene: two grown trees.
  plant(0.32, 0, 7, true);
  plant(0.7, 0, 23, true);

  const handState = new Map<string, HandState>();
  const pruneHand = (st: HandState, id: string) => {
    if (st.seen === frameNo) return;
    if (st.tree >= 0) grabbed[st.tree] = 0;
    handState.delete(id);
  };
  let hands: Hand[] = [];

  // Nearest grown branch tip to world point (wx, wy) (x in aspect units, y heights from bottom), within TIP_R.
  let pickS = -1, pickI = 0, pickX = 0, pickY = 0;
  const pickTip = (wx: number, wy: number) => {
    pickS = -1;
    let bd = TIP_R;
    for (let s = 0; s < SLOTS; s++) {
      if (!active[s] || fading[s] || !landed[s] || grabbed[s]) continue;
      const tp = tipAttr[s].array, pt = petAttr[s].array, sc = treeU[s].value.y, grown = treeU[s].value.z;
      for (let i = 0; i < npCount[s]; i++) {
        if (pt[i * 4 + 3] > grown) continue;
        // Same sway as the shader (minus flutter).
        const lx = tp[i * 4], ly = tp[i * 4 + 1], k = Math.max(ly, 0) / 3, o = bend[s] * k * k * 0.9;
        const x = tx[s] * aspect + (lx + o) * sc, y = GROUND + (ly - Math.abs(o) * 0.35 * k) * sc;
        const d = Math.hypot(x - wx, y - wy);
        if (d < bd) {
          bd = d;
          pickS = s;
          pickI = i;
          pickX = x;
          pickY = y;
        }
      }
    }
    return pickS >= 0;
  };

  return {
    id: 'trees',
    title: meta.title,
    hint: { text: '손가락으로 집어 씨앗을 심고, 가지 끝을 집어 당겨 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dtRaw) {
      const dt = Math.min(dtRaw, 0.05);
      time += dt;
      frameNo++;
      shared.time.value = time;
      hands = input.hands;
      const nh = Math.min(hands.length, MAX_HANDS);

      let nm = 0;
      const markerSize = Math.max(22, shared.heightPx.value * 0.045);
      for (let i = 0; i < nh; i++) {
        const h = hands[i];
        let st = handState.get(h.id);
        if (!st) handState.set(h.id, (st = { pinch: false, next: 0, seen: 0, tree: -1, tip: -1 }));
        st.seen = frameNo;
        const p = h.gestures.pinch;
        const wx = h.pinchPoint.x * aspect, wy = 1 - h.pinchPoint.y;
        if (st.tree >= 0 && (!p || !active[st.tree] || fading[st.tree])) {
          grabbed[st.tree] = 0; // release: the sway spring snaps it back
          st.tree = -1;
        }
        // Default cursor: a seed forming between the fingers as they close.
        let mode = 0, mx = h.pinchPoint.x, my = wy, ms = p ? 0 : h.pinchStrength;
        if (st.tree < 0) {
          const hit = pickTip(wx, wy);
          if (p && !st.pinch) {
            if (hit) {
              st.tree = pickS;
              st.tip = pickI;
              grabbed[pickS] = 1;
            } else if (time >= st.next) {
              plant(h.pinchPoint.x, h.pinchPoint.y, (Math.random() * 4294967296) >>> 0, false);
              st.next = time + PLANT_COOLDOWN;
            }
          } else if (hit && !p) {
            // Hovering a branch tip: a ring that tightens as the fingers close.
            mode = 1;
            mx = pickX / aspect;
            my = pickY;
            ms = 0.3 + 0.7 * h.pinchStrength;
          }
        }
        if (st.tree >= 0) {
          // Solve the shader's sway for the bend that puts the held tip under the pinch point.
          const s = st.tree, tp = tipAttr[s].array;
          const lx = tp[st.tip * 4], k = Math.max(tp[st.tip * 4 + 1], 0) / 3;
          const need = ((wx - tx[s] * aspect) / treeU[s].value.y - lx) / (0.9 * Math.max(k * k, 0.05));
          grabBend[s] = Math.max(-2.2, Math.min(2.2, need));
          mode = 2;
          ms = 1;
        }
        st.pinch = p;
        markerPos[nm * 3] = mx;
        markerPos[nm * 3 + 1] = my;
        markerPos[nm * 3 + 2] = markerSize;
        markerState[nm * 2] = ms;
        markerState[nm * 2 + 1] = mode;
        nm++;
      }
      handState.forEach(pruneHand);
      markerGeo.setDrawRange(0, nm);
      markerPosAttr.needsUpdate = markerStateAttr.needsUpdate = true;

      for (let s = 0; s < SLOTS; s++) {
        seedPos[s * 3 + 2] = 0;
        if (!active[s]) continue;

        if (!landed[s]) {
          seedV[s] -= 2.2 * dt;
          seedY[s] += seedV[s] * dt;
          if (seedY[s] <= GROUND) landed[s] = 1;
          else {
            seedPos[s * 3] = tx[s];
            seedPos[s * 3 + 1] = seedY[s];
            seedPos[s * 3 + 2] = Math.max(4, shared.heightPx.value * 0.008);
          }
          alpha[s] = 1;
        } else growT[s] += dt;

        if (fading[s]) {
          alpha[s] -= dt / FADE_S;
          if (alpha[s] <= 0) {
            active[s] = fading[s] = 0;
            branchMesh[s].visible = petalPts[s].visible = false;
            continue;
          }
        }

        // Wind: gentle ambient breeze plus gusts from nearby hands' horizontal motion; swipes blow harder.
        let target = (0.12 * Math.sin(time * 0.5 + tx[s] * 2) + 0.06 * Math.sin(time * 1.3 + tx[s] * 5)) * motion;
        const scale = treeU[s].value.y;
        for (let i = 0; i < nh; i++) {
          const h = hands[i];
          const dx = (h.cursor.x - tx[s]) * aspect;
          target += h.velocity.x * 0.5 * motion * Math.exp(-dx * dx * 6) * (h.gestures.swipe ? 1.8 : 1);
          // Open palm held above this tree's crown → bloom.
          if (h.gestures.open && landed[s]) {
            const palm = h.kind === 'tracked' ? h.landmarks[9] : h.cursor;
            const px = (palm.x - tx[s]) * aspect, py = 1 - palm.y - GROUND;
            if (Math.abs(px) < scale * 1.8 && py > 0 && py < scale * 4.5) bloom[s] = Math.min(1, bloom[s] + dt / BLOOM_S);
          }
        }
        target = Math.max(-1.6, Math.min(1.6, target));
        windT[s] += (target - windT[s]) * Math.min(1, dt * 8);
        if (grabbed[s]) {
          const b = bend[s] + (grabBend[s] - bend[s]) * (1 - Math.exp(-dt * 18));
          bendV[s] = Math.max(-20, Math.min(20, (b - bend[s]) / Math.max(dt, 1e-3)));
          bend[s] = b;
        } else {
          bendV[s] += (K * (windT[s] - bend[s]) - C * bendV[s]) * dt;
          bend[s] += bendV[s] * dt;
        }

        const x = Math.min(growT[s] / GROW_S, 1);
        treeU[s].value.set(tx[s], scale, landed[s] ? 1 - (1 - x) * (1 - x) : 0, bend[s]);
        alphaU[s].value = alpha[s];
        bloomU[s].value = bloom[s];
        branchMesh[s].visible = landed[s] === 1;
        petalPts[s].visible = bloom[s] > 0;
      }
      seedAttr.needsUpdate = true;

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      aspect = width / height;
      shared.aspect.value = aspect;
      shared.heightPx.value = height;
    },
    dispose() {
      for (const g of branchGeo) g.dispose();
      for (const g of petalGeo) g.dispose();
      for (const m of materials) m.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      seedGeo.dispose();
      seedMat.dispose();
      markerGeo.dispose();
      markerMat.dispose();
    },
  };
};
