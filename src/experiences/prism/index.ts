import * as THREE from 'three';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// Faceted Voronoi "stained glass": drifting ambient seeds + every fingertip/pointer as a seed, one fullscreen shader.
// Each cell is a low pyramid (one flat facet per edge) lit by a slowly circling light; dark leading between cells.
// Pinch grabs the nearest cell and drags it (neighbours make way); release springs it home with a small ripple.
const AMBIENT = 60; // 10 x 6 jittered grid
const MAX_SEEDS = 100;
const MAX_HANDS = 8;
const TIPS = [4, 8, 12, 16, 20];
// Raw sRGB values: ShaderMaterial writes gl_FragColor without color-space conversion.
const PALETTE = [0xf2c230, 0xf7dc6f, 0xe89a1c, 0xf4ead2, 0xe0452b, 0x2b4ea2];
const HAND_COLORS = [4, 5]; // vermilion, cobalt; alternates per hand, first two form the bridge
const key = (i: number) => (i + 0.5) / PALETTE.length;

const K = 3; // spring back to home
const C = 2.4; // damping (slightly underdamped: shards overshoot a little)
const SHATTER_R = 0.32;
const GATHER_R = 0.45;
const GRAB_R = 0.25; // pick radius around the pinch point (aspect space)
const PUSH_R = 0.15; // a dragged cell shoves neighbours within this radius

export default (): Experience => {
  let renderer!: THREE.WebGLRenderer;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.5 : 1;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      seeds: { value: Array.from({ length: MAX_SEEDS }, () => new THREE.Vector4()) }, // x, y (aspect space, y up), color key, glow
      count: { value: 0 },
      pal: { value: PALETTE.map((h) => new THREE.Color().setHex(h, THREE.NoColorSpace)) },
      aspect: { value: 1 },
      px: { value: 1 / 1080 },
      time: { value: 0 },
      bridge: { value: new THREE.Vector4() }, // A.xy, B.xy
      bridgeOn: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform vec4 seeds[${MAX_SEEDS}];
      uniform int count;
      uniform vec3 pal[${PALETTE.length}];
      uniform float aspect, px, time, bridgeOn;
      uniform vec4 bridge;
      varying vec2 vUv;
      float hash(float n) { return fract(sin(n * 91.7 + 3.1) * 43758.5453); }
      void main() {
        vec2 p = vUv * vec2(aspect, 1.0);
        float best = 1e9;
        vec4 s = vec4(0.0);
        int bi = 0;
        for (int i = 0; i < ${MAX_SEEDS}; i++) {
          if (i >= count) break;
          vec2 d = seeds[i].xy - p;
          float dd = dot(d, d);
          if (dd < best) { best = dd; s = seeds[i]; bi = i; }
        }
        // Exact distance to the cell border (nearest bisector) and that edge's outward direction.
        float edge = 1e9;
        vec2 en = vec2(0.0);
        for (int i = 0; i < ${MAX_SEEDS}; i++) {
          if (i >= count) break;
          if (i == bi) continue;
          vec2 r = seeds[i].xy - s.xy;
          float l = length(r);
          if (l < 1e-5) continue;
          vec2 n = r / l;
          float e = 0.5 * l - dot(p - s.xy, n);
          if (e < edge) { edge = e; en = n; }
        }

        vec3 col = pal[int(s.z * ${PALETTE.length}.0)];
        // Bridge: cells whose seed lies along the line between the first two hands blend A -> B.
        vec2 ab = bridge.zw - bridge.xy;
        float t = clamp(dot(s.xy - bridge.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        float bw = bridgeOn * smoothstep(0.16, 0.05, length(s.xy - bridge.xy - ab * t));
        col = mix(col, mix(pal[${HAND_COLORS[0]}], pal[${HAND_COLORS[1]}], t), bw * 0.9);

        // Roof-shaped cell: each edge owns a flat facet tilted toward it, plus a per-cell tilt.
        vec2 tilt = vec2(hash(float(bi)), hash(float(bi) + 7.3)) - 0.5;
        vec3 N = normalize(vec3(en * 0.8 + tilt * 0.7, 1.0));
        float la = time * 0.15;
        vec3 L = normalize(vec3(cos(la) * 0.7, 0.45 + sin(la) * 0.35, 1.0));
        col *= 0.55 + 0.5 * dot(N, L);
        vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
        col += vec3(1.0, 0.97, 0.88) * pow(max(dot(N, H), 0.0), 60.0) * 0.3;

        // Hand cells (and flying shards) glow.
        col = mix(col, vec3(1.0, 0.96, 0.84), s.w * 0.22) + s.w * 0.18 * smoothstep(0.09, 0.0, sqrt(best));

        float lw = max(2.0 * px, 0.0018);
        col = mix(vec3(0.07, 0.06, 0.05), col, smoothstep(lw, lw + 1.5 * px, edge));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const scene = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const u = material.uniforms;
  const seeds = u.seeds.value as THREE.Vector4[];

  // Ambient seeds: home (0..1, y up), drift frequency/phase, displacement + velocity in aspect space.
  const hx = new Float32Array(AMBIENT), hy = new Float32Array(AMBIENT);
  const fq = new Float32Array(AMBIENT), ph = new Float32Array(AMBIENT), ck = new Float32Array(AMBIENT);
  const dx = new Float32Array(AMBIENT), dy = new Float32Array(AMBIENT);
  const vx = new Float32Array(AMBIENT), vy = new Float32Array(AMBIENT);
  for (let i = 0; i < AMBIENT; i++) {
    hx[i] = ((i % 10) + 0.15 + 0.7 * Math.random()) / 10;
    hy[i] = (Math.floor(i / 10) + 0.15 + 0.7 * Math.random()) / 6;
    fq[i] = (0.12 + Math.random() * 0.2) * motion;
    ph[i] = Math.random() * Math.PI * 2;
    const r = Math.random(); // mostly yellows/cream, rare vermilion/cobalt accents
    ck[i] = key(r < 0.3 ? 0 : r < 0.5 ? 1 : r < 0.7 ? 2 : r < 0.86 ? 3 : r < 0.93 ? 4 : 5);
  }

  const state = new Map<string, { pinch: boolean; held: number }>(); // held: ambient seed index or -1
  const seen = new Set<string>();
  const shatters = new Float32Array(MAX_HANDS * 3); // x, y, strength
  const gathers = new Float32Array(MAX_HANDS * 2);
  const holds = new Float32Array(MAX_HANDS * 2);
  const heldBy = new Uint8Array(AMBIENT);
  const htx = new Float32Array(AMBIENT), hty = new Float32Array(AMBIENT); // held seed's target (pinch point)
  const hover = new Float32Array(AMBIENT);
  // Nearest free ambient seed to (x, y) in aspect space (last frame's positions), -1 if none within GRAB_R.
  const pick = (x: number, y: number) => {
    let best = -1, bd = GRAB_R;
    for (let i = 0; i < AMBIENT; i++) {
      if (heldBy[i]) continue;
      const d = Math.hypot(seeds[i].x - x, seeds[i].y - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  let time = 0;

  return {
    id: 'prism',
    title: meta.title,
    hint: { text: '유리 조각을 손가락으로 집어 끌어 보세요, 놓으면 제자리로 튕겨 돌아가요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      const h = Math.min(dt, 1 / 20);
      time += h;
      u.time.value = time * motion;
      const aspect = u.aspect.value as number;
      let ns = 0, ng = 0, nhold = 0, n = AMBIENT;
      hover.fill(0);

      // Hands: fingertip seeds after the ambient ones; pinch grabs/drags a cell, open palm gathers.
      // Pointer hands have all 21 landmarks = cursor, so landmark 9 works for both kinds.
      seen.clear();
      const hands = input.hands;
      const nh = Math.min(hands.length, MAX_HANDS);
      for (let hi = 0; hi < nh; hi++) {
        const hand = hands[hi];
        const g = hand.gestures;
        seen.add(hand.id);
        let st = state.get(hand.id);
        if (!st) state.set(hand.id, (st = { pinch: false, held: -1 }));
        const lm = hand.landmarks;
        const ppx = hand.pinchPoint.x * aspect, ppy = 1 - hand.pinchPoint.y;
        if (g.pinch && !st.pinch) {
          st.held = pick(ppx, ppy);
          if (st.held >= 0) heldBy[st.held] = 1;
        } else if (!g.pinch && st.pinch && st.held >= 0) {
          // Release: the cell carries the hand's velocity into its spring; neighbours get a small ripple.
          heldBy[st.held] = 0;
          vx[st.held] = Math.max(-3, Math.min(3, hand.velocity.x * aspect));
          vy[st.held] = Math.max(-3, Math.min(3, -hand.velocity.y));
          st.held = -1;
          shatters[ns * 3] = ppx;
          shatters[ns * 3 + 1] = ppy;
          shatters[ns++ * 3 + 2] = 0.35;
        }
        st.pinch = g.pinch;
        const held = st.held;
        if (held >= 0) {
          htx[held] = holds[nhold * 2] = ppx;
          hty[held] = holds[nhold * 2 + 1] = ppy;
          nhold++;
          hover[held] = 1.8;
        } else {
          // Anticipation: the cell under the fingers lights up as they close.
          const i = pick(ppx, ppy);
          if (i >= 0) hover[i] = Math.max(hover[i], 0.35 + 1.05 * hand.pinchStrength);
        }
        const gather = hand.kind === 'tracked' && g.open && !g.pinch && !g.fist;
        if (gather) {
          gathers[ng * 2] = lm[9].x * aspect;
          gathers[ng * 2 + 1] = 1 - lm[9].y;
          ng++;
        }
        const glow = g.pinch || gather ? 1 : 0.55;
        const c = key(HAND_COLORS[hi % HAND_COLORS.length]);
        if (hand.kind === 'pointer') {
          if (held < 0 && n < MAX_SEEDS) seeds[n++].set(hand.cursor.x * aspect, 1 - hand.cursor.y, c, glow);
        } else {
          // While holding, thumb and index make way for the held cell.
          for (const t of TIPS) if (n < MAX_SEEDS && (held < 0 || (t !== 4 && t !== 8))) seeds[n++].set(lm[t].x * aspect, 1 - lm[t].y, c, glow);
        }
      }
      for (const id of state.keys()) {
        if (seen.has(id)) continue;
        const held = state.get(id)!.held;
        if (held >= 0) heldBy[held] = 0;
        state.delete(id);
      }
      u.count.value = n;

      if (nh >= 2) {
        const a = hands[0].landmarks[9], b = hands[1].landmarks[9];
        (u.bridge.value as THREE.Vector4).set(a.x * aspect, 1 - a.y, b.x * aspect, 1 - b.y);
      }
      u.bridgeOn.value += ((nh >= 2 ? 1 : 0) - u.bridgeOn.value) * Math.min(h * 3, 1);

      // Ambient seeds: drift around home, spring back from displacement, burst on ripples, pulled by gathers, shoved by drags.
      const kHold = 1 - Math.exp(-h * 25), kPush = 1 - Math.exp(-h * 12);
      for (let i = 0; i < AMBIENT; i++) {
        const bx = hx[i] * aspect + 0.035 * Math.sin(time * fq[i] + ph[i]);
        const by = hy[i] + 0.035 * Math.cos(time * fq[i] * 1.3 + ph[i] * 2);
        if (heldBy[i]) {
          dx[i] += (htx[i] - bx - dx[i]) * kHold;
          dy[i] += (hty[i] - by - dy[i]) * kHold;
          seeds[i].set(bx + dx[i], by + dy[i], ck[i], hover[i]);
          continue;
        }
        // Dragged cells shove neighbours aside (positional, so it stays stable at any frame rate).
        for (let k = 0; k < nhold; k++) {
          const ox = bx + dx[i] - holds[k * 2], oy = by + dy[i] - holds[k * 2 + 1];
          const d = Math.hypot(ox, oy);
          if (d >= PUSH_R || d < 1e-4) continue;
          const p = ((PUSH_R - d) * kPush) / d;
          dx[i] += ox * p;
          dy[i] += oy * p;
        }
        const x = bx + dx[i], y = by + dy[i];
        for (let k = 0; k < ns; k++) {
          const ox = x - shatters[k * 3], oy = y - shatters[k * 3 + 1];
          const d = Math.hypot(ox, oy);
          if (d >= SHATTER_R) continue;
          const s = (3.2 * shatters[k * 3 + 2] * motion * (1 - d / SHATTER_R)) / Math.max(d, 1e-4);
          vx[i] += ox * s;
          vy[i] += oy * s;
        }
        let ax = -K * dx[i] - C * vx[i], ay = -K * dy[i] - C * vy[i];
        for (let k = 0; k < ng; k++) {
          const ox = gathers[k * 2] - x, oy = gathers[k * 2 + 1] - y;
          const d = Math.hypot(ox, oy);
          if (d >= GATHER_R || d < 1e-4) continue;
          // Strong mid-range pull that fades near the palm so shards ring it instead of collapsing.
          const f = (2.4 * (1 - d / GATHER_R) * Math.min(1, Math.max(0, (d - 0.04) / 0.05))) / d;
          ax += ox * f;
          ay += oy * f;
        }
        vx[i] += ax * h;
        vy[i] += ay * h;
        dx[i] += vx[i] * h;
        dy[i] += vy[i] * h;
        seeds[i].set(bx + dx[i], by + dy[i], ck[i], Math.max(hover[i], Math.min(Math.hypot(vx[i], vy[i]) * 0.25, 0.45)));
      }

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      u.aspect.value = width / height;
      u.px.value = 1 / height;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
};
