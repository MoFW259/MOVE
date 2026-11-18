import * as THREE from 'three';
import type { Experience, Point3 } from '../../core/types.ts';
import meta from './meta.ts';

// Body silhouette as flat pop-art tiles; hand openness sets tile size, fingertips light their tile and ripple outward.
// Pinch picks a tile up (it lifts and follows, its hole refills), release drops it into the grid with a colour pop.
const MAX_BLOBS = 16;
const MAX_TIPS = 40;
const MAX_GRAB = 6; // floating tiles / refilling holes / drop pops / hover highlights
const TIPS = [4, 8, 12, 16, 20];
const IDLE_BLOBS = 3;
const MIN_CELL = 0.014; // screen-height units: fist
const MAX_CELL = 0.11; // open palm
const REFILL_S = 1.4;
const DROP_S = 4; // a dropped tile stays this long before melting back into the pattern

// Four Warhol-style palettes: background, figure A, figure B, fingertip highlight.
const PALETTES = [
  0xe6007e, 0xffe100, 0x00c2c7, 0xfff6e0,
  0x00a6a6, 0xff3d7f, 0xffd23f, 0xffffff,
  0xffd400, 0xff2d55, 0x2643ff, 0xfffbe8,
  0x3a2bff, 0xff8a00, 0x3dff9a, 0xfff2f8,
];

const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4());

export default (): Experience => {
  let renderer: THREE.WebGLRenderer;
  let aspect = 1;
  let time = 0;
  let openness = 0.5;
  let idle = 1;
  let gapNext = 0, dropNext = 0, colorNext = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.4 : 1;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      aspect: { value: 1 },
      resY: { value: 1 },
      cell: { value: 0.05 },
      pop: { value: reduced ? 0.5 : 1 },
      maskTex: { value: null as THREE.Texture | null },
      hasMask: { value: 0 },
      blobCount: { value: 0 },
      tipCount: { value: 0 },
      blobs: { value: vec4s(MAX_BLOBS) }, // centered x, y, radius, weight
      tips: { value: Array.from({ length: MAX_TIPS }, () => new THREE.Vector3()) }, // centered x, y, strength
      grabs: { value: vec4s(MAX_GRAB) }, // floating tile centre x, y, lift 0..1, colour 1|2 (0 = empty)
      gaps: { value: vec4s(MAX_GRAB) }, // hole centre x, y, refill 0..1, active
      drops: { value: vec4s(MAX_GRAB) }, // landed tile centre x, y, age (s), colour 1|2 (0 = empty)
      hovers: { value: Array.from({ length: MAX_GRAB }, () => new THREE.Vector3()) }, // x, y, strength
      // Raw hex values: the shader writes them straight to the sRGB canvas.
      palette: { value: PALETTES.map((h) => new THREE.Color().setHex(h, THREE.LinearSRGBColorSpace)) },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform float time, aspect, resY, cell, hasMask, pop;
      uniform sampler2D maskTex;
      uniform int blobCount, tipCount;
      uniform vec4 blobs[${MAX_BLOBS}];
      uniform vec3 tips[${MAX_TIPS}];
      uniform vec4 grabs[${MAX_GRAB}], gaps[${MAX_GRAB}], drops[${MAX_GRAB}];
      uniform vec3 hovers[${MAX_GRAB}];
      uniform vec3 palette[16];
      varying vec2 vUv;

      // Each quadrant runs the palette cycle with its own offset; slow crossfade, no flashing.
      vec3 pal(float q, int k) {
        float ph = time * 0.12 + q;
        float f = smoothstep(0.8, 1.0, fract(ph));
        int a = int(mod(floor(ph), 4.0));
        int b = int(mod(floor(ph) + 1.0, 4.0));
        return mix(palette[a * 4 + k], palette[b * 4 + k], f);
      }
      float quad(vec2 c) { return (c.x < 0.0 ? 0.0 : 1.0) + (c.y < 0.0 ? 2.0 : 0.0); }
      bool same(vec2 id, vec2 at) { return all(equal(id, floor(at / cell))); }

      void main() {
        vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
        vec2 id = floor(p / cell);
        vec2 c = (id + 0.5) * cell;
        vec2 local = p / cell - id;
        float q = quad(c);
        vec3 bg = pal(q, 0), fa = pal(q, 1), fb = pal(q, 2), hot = pal(q, 3);

        float inside = 0.0;
        if (hasMask > 0.5) inside = step(0.5, texture2D(maskTex, c / vec2(aspect, 1.0) + 0.5).r);
        float field = 0.0;
        for (int i = 0; i < ${MAX_BLOBS}; i++) {
          if (i >= blobCount) break;
          vec2 d = c - blobs[i].xy;
          field += blobs[i].w * blobs[i].z * blobs[i].z / (dot(d, d) + 1e-5);
        }
        inside = max(inside, step(1.0, field));

        float glow = 0.0, ring = 0.0;
        for (int i = 0; i < ${MAX_TIPS}; i++) {
          if (i >= tipCount) break;
          float dc = length(id - floor(tips[i].xy / cell));
          glow = max(glow, tips[i].z * exp(-dc * dc * 1.2));
          float r = fract(time * 0.5 + float(i) * 0.37) * 4.0;
          ring = max(ring, tips[i].z * (1.0 - r / 4.0) * exp(-(dc - r) * (dc - r) * 3.0));
        }

        // Dropped tiles: flash the highlight, settle into their colour, and send one colour ring outward.
        float landed = 0.0;
        vec3 landCol = hot;
        float tileHalf = 0.5, hov = 0.0; // ('half' is a reserved GLSL word)
        for (int i = 0; i < ${MAX_GRAB}; i++) {
          if (drops[i].w > 0.5) {
            float a = drops[i].z;
            float dc = length(id - floor(drops[i].xy / cell));
            if (dc < 0.5) {
              landed = smoothstep(${DROP_S}.0, ${DROP_S - 1}.0, a);
              landCol = mix(drops[i].w < 1.5 ? fa : fb, hot, exp(-a * 5.0));
            }
            float r = a * 9.0;
            ring = max(ring, pop * exp(-a * 1.8) * exp(-(dc - r) * (dc - r) * 1.5));
          }
          // Holes left by picked-up tiles regrow from the centre.
          if (gaps[i].w > 0.5 && same(id, gaps[i].xy)) tileHalf = min(tileHalf, 0.5 * gaps[i].z);
          if (hovers[i].z > 0.0 && same(id, hovers[i].xy)) hov = max(hov, hovers[i].z);
        }

        float s = smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(id.x * 0.55 + id.y * 0.35 + time * 1.1));
        vec3 tile = mix(bg, mix(fa, fb, s), inside);
        tile = mix(tile, mix(fb, fa, s), smoothstep(0.3, 0.5, ring));
        tile = mix(tile, hot, clamp(glow, 0.0, 1.0));
        tile = mix(tile, landCol, landed);
        tile = mix(tile, hot, hov * 0.35);

        float cellPx = cell * resY;
        float cellEdge = 0.5 - max(abs(local.x - 0.5), abs(local.y - 0.5));
        float edge = (cellEdge - 0.5 + tileHalf) * cellPx;
        float gap = max(1.5, cellPx * 0.07);
        // Outside stays flat background with a 1px hairline grid; only silhouette/lit tiles read as squares.
        vec3 base = mix(bg, bg * 0.9, 1.0 - smoothstep(0.5, 1.5, cellEdge * cellPx));
        base = mix(base, bg * 0.6, step(tileHalf, 0.499)); // dark hole while refilling
        vec3 col = mix(base, tile, smoothstep(gap - 0.5, gap + 0.5, edge));
        // Hover: a bright frame inside the tile that thickens as the fingers close.
        float ow = hov * cellPx * 0.18;
        col = mix(col, hot, step(0.001, hov) * step(gap, edge) * (1.0 - smoothstep(gap + ow, gap + ow + 1.0, edge)));

        // Floating tiles: soft drop shadow, then the lifted tile with a bright rim.
        for (int i = 0; i < ${MAX_GRAB}; i++) {
          vec4 g = grabs[i];
          if (g.w < 0.5) continue;
          float sz = cell * (1.0 + 0.25 * g.z);
          vec2 sd = abs(p - g.xy - vec2(0.15, -0.15) * cell * g.z) / sz;
          float shPx = (0.5 - max(sd.x, sd.y)) * sz * resY;
          col = mix(col, col * 0.45, 0.6 * g.z * smoothstep(-6.0, 6.0, shPx));
          vec2 d = abs(p - g.xy) / sz;
          float e = (0.5 - max(d.x, d.y)) * sz * resY;
          float gq = quad(g.xy);
          vec3 gc = mix(g.w < 1.5 ? pal(gq, 1) : pal(gq, 2), pal(gq, 3), 1.0 - step(max(2.0, sz * resY * 0.08), e));
          col = mix(col, gc, smoothstep(-0.5, 0.5, e));
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geometry, material));
  const u = material.uniforms;
  const blobs = u.blobs.value as THREE.Vector4[];
  const tips = u.tips.value as THREE.Vector3[];
  const grabs = u.grabs.value as THREE.Vector4[];
  const gaps = u.gaps.value as THREE.Vector4[];
  const drops = u.drops.value as THREE.Vector4[];
  const hovers = u.hovers.value as THREE.Vector3[];
  const state = new Map<string, { pinch: boolean; grab: number; seen: number }>(); // grab: index into grabs or -1
  let frameNo = 0;

  // Landmark distance in screen-height units (x scaled by aspect).
  const dist = (a: Point3, b: Point3) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  // Centre of the grid tile containing centered coordinate v.
  const snap = (v: number, cell: number) => (Math.floor(v / cell) + 0.5) * cell;
  const drop = (k: number) => {
    const g = grabs[k], cell = u.cell.value as number;
    drops[dropNext].set(snap(g.x, cell), snap(g.y, cell), 0, g.w);
    dropNext = (dropNext + 1) % MAX_GRAB;
    g.set(0, 0, 0, 0);
  };

  return {
    id: 'pixel',
    title: meta.title,
    hint: { text: '타일을 손가락으로 집어 옮기고 놓아 보세요 · 손을 펴고 쥐면 크기가 바뀌어요', gesture: 'pinch' },
    needs: ['segmentation', 'hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      time += dt * motion;
      frameNo++;
      const hands = input.hands;
      const cell = u.cell.value as number;
      const kFollow = 1 - Math.exp(-dt * 25), kLift = 1 - Math.exp(-dt * 12);
      let open = 0, nOpen = 0, freeze = false;
      let nb = 0, nt = 0, nh = 0;
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        const g = h.gestures;
        const x = (h.pinchPoint.x - 0.5) * aspect, y = 0.5 - h.pinchPoint.y;

        // Pinch: pick up the tile under the pinch point; it follows while held and drops into the grid on release.
        let st = state.get(h.id);
        if (!st) state.set(h.id, (st = { pinch: false, grab: -1, seen: 0 }));
        st.seen = frameNo;
        if (g.pinch && !st.pinch) {
          const k = grabs.findIndex((v) => v.w === 0);
          if (k >= 0) {
            const cx = snap(x, cell), cy = snap(y, cell);
            colorNext = colorNext === 1 ? 2 : 1;
            grabs[k].set(cx, cy, 0, colorNext);
            gaps[gapNext].set(cx, cy, 0, 1);
            gapNext = (gapNext + 1) % MAX_GRAB;
            st.grab = k;
          }
        } else if (!g.pinch && st.grab >= 0) {
          drop(st.grab);
          st.grab = -1;
        }
        st.pinch = g.pinch;
        if (st.grab >= 0) {
          const gr = grabs[st.grab];
          gr.x += (x - gr.x) * kFollow;
          gr.y += (y - gr.y) * kFollow;
          gr.z += (1 - gr.z) * kLift;
          freeze = true;
        } else if (nh < MAX_GRAB) {
          hovers[nh++].set(x, y, 0.3 + 0.7 * h.pinchStrength);
        }

        if (h.kind === 'pointer') {
          if (g.pinch) freeze = true;
          const px = (h.cursor.x - 0.5) * aspect, py = 0.5 - h.cursor.y;
          if (nb < MAX_BLOBS) blobs[nb++].set(px, py, 0.18, 1);
          if (nt < MAX_TIPS) tips[nt++].set(px, py, 1);
          continue;
        }
        const lm = h.landmarks;
        const palm = dist(lm[0], lm[9]) + 1e-4;
        // Open palm ≈ spread 2; fist kills it. A closing pinch freezes the size so tiles stay put under the fingers.
        if (g.fist) nOpen++;
        else if (h.pinchStrength > 0.4) freeze = true;
        else {
          const spread = (dist(lm[8], lm[0]) + dist(lm[12], lm[0]) + dist(lm[16], lm[0]) + dist(lm[20], lm[0])) / (4 * palm);
          open += THREE.MathUtils.clamp((spread - 1.1) / 0.7, 0, 1);
          nOpen++;
        }
        if (!input.mask && nb < MAX_BLOBS) blobs[nb++].set((lm[9].x - 0.5) * aspect, 0.5 - lm[9].y, palm * 1.8, 1);
        for (let t = 0; t < TIPS.length && nt < MAX_TIPS; t++) {
          const p = lm[TIPS[t]];
          tips[nt++].set((p.x - 0.5) * aspect, 0.5 - p.y, 1);
        }
      }
      for (let k = nh; k < MAX_GRAB; k++) hovers[k].z = 0;
      for (const [id, st] of state) {
        if (st.seen === frameNo) continue;
        if (st.grab >= 0) drop(st.grab); // hand left while holding: drop where it was
        state.delete(id);
      }
      for (let k = 0; k < MAX_GRAB; k++) {
        if (gaps[k].w > 0 && (gaps[k].z += dt / REFILL_S) >= 1) gaps[k].w = 0;
        if (drops[k].w > 0 && (drops[k].z += dt) >= DROP_S) drops[k].w = 0;
      }

      // Idle: tile size breathes and a few wandering blobs fade in when nobody is there.
      const target = freeze ? openness : nOpen ? open / nOpen : hands.length ? 0.5 : 0.5 + 0.35 * Math.sin(time * 0.35);
      openness += (target - openness) * (1 - Math.exp(-dt * 4));
      idle += ((hands.length ? 0 : 1) - idle) * (1 - Math.exp(-dt * 1.5));
      if (idle > 0.01) {
        for (let k = 0; k < IDLE_BLOBS && nb < MAX_BLOBS; k++) {
          const x = 0.35 * aspect * Math.sin(time * 0.23 + k * 2.4);
          const y = 0.3 * Math.sin(time * 0.31 + k * 1.7);
          blobs[nb++].set(x, y, 0.1 + 0.03 * Math.sin(time * 0.5 + k), idle);
          if (nt < MAX_TIPS) tips[nt++].set(x, y, idle * 0.6);
        }
      }

      u.time.value = time;
      u.cell.value = MIN_CELL + (MAX_CELL - MIN_CELL) * openness;
      u.blobCount.value = nb;
      u.tipCount.value = nt;
      u.maskTex.value = input.mask ?? null;
      u.hasMask.value = input.mask ? 1 : 0;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      aspect = width / height;
      u.aspect.value = aspect;
      u.resY.value = height;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
};
