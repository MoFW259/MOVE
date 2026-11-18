import * as THREE from 'three';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// Open palm (or a hovering mouse) grows a black hole that lenses a procedural sky; pinch near a hole grabs it,
// release throws it (it keeps lensing as it drifts and slows); pinch on empty sky seeds a new one; a fist collapses.
const MAX = 8;
const SHOCK_LIFE = 1.5;
const COLLAPSE_MIN = 0.3;
const MAX_SPEED = 2.5; // uv/s

interface HandState { attached: Hole | null; held: Hole | null; prevPinch: boolean; prevFist: boolean; seen: boolean; pointer: boolean }
// x, y in GL uv; glow: 0 idle … 1 hovered and fully pinching, 2 held (drives the grip ring).
interface Hole { x: number; y: number; vx: number; vy: number; mass: number; collapsing: boolean; owner: HandState | null; glow: number; target: number }
interface Shock { x: number; y: number; age: number; strength: number }

export default (): Experience => {
  let renderer: THREE.WebGLRenderer;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      aspect: { value: 1 },
      motion: { value: reduced ? 0.3 : 1 },
      holes: { value: Array.from({ length: MAX }, () => new THREE.Vector4()) }, // x, y (GL uv), mass, glow
      shocks: { value: Array.from({ length: MAX }, () => new THREE.Vector4()) }, // x, y (GL uv), age, strength
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform float time, aspect, motion;
      uniform vec4 holes[${MAX}];
      uniform vec4 shocks[${MAX}];
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
        return v;
      }
      vec3 stars(vec2 q, float scale, float density) {
        vec2 g = q * scale, id = floor(g), f = fract(g) - 0.5;
        float h = hash(id);
        if (h < density) return vec3(0.0);
        float d = length(f - (hash2(id) - 0.5) * 0.7);
        float tw = 0.75 + 0.25 * sin(time * motion * (1.0 + 2.0 * h) + h * 60.0);
        vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), hash(id + 3.7));
        return tint * tw * (smoothstep(0.07, 0.0, d) * 1.4 + 0.3 * 0.0006 / (d * d + 0.0006));
      }
      vec3 sky(vec2 q) {
        q += vec2(0.012, 0.004) * time * motion;
        float n = fbm(q * 1.6 + vec2(0.0, time * 0.01 * motion));
        float m = fbm(q * 3.1 - n * 1.5);
        vec3 col = vec3(0.01, 0.012, 0.03);
        col += vec3(0.22, 0.07, 0.30) * smoothstep(0.35, 0.85, n) * 0.8;
        col += vec3(0.05, 0.20, 0.35) * smoothstep(0.45, 0.9, m) * n;
        col += stars(q, 18.0, 0.82) + stars(q + 5.3, 34.0, 0.88) * 0.7 + stars(q - 2.1, 60.0, 0.9) * 0.5;
        return col;
      }

      void main() {
        vec2 ar = vec2(aspect, 1.0);
        vec2 p = (vUv - 0.5) * ar;
        vec2 q = p;
        vec3 glow = vec3(0.0);
        float horizon = 1.0;

        for (int i = 0; i < ${MAX}; i++) {
          float m = holes[i].z;
          if (m < 0.001 && holes[i].w < 0.01) continue;
          vec2 d = p - (holes[i].xy - 0.5) * ar;
          float r = length(d);
          float rh = 0.07 * m;   // event horizon
          float te = 0.15 * m;   // Einstein radius
          // Thin-lens deflection; summed so neighbouring holes merge their distortions.
          q -= d * te * te / max(r * r, rh * rh * 0.25 + 1e-6);
          if (m > 0.001) horizon *= smoothstep(rh * 0.92, rh * 1.04, r); // a fresh seed (m = 0) has no horizon yet
          float a = atan(d.y, d.x);
          float spin = time * 2.5 * motion;
          float streak = 0.55 + 0.45 * sin(a * 3.0 + 14.0 * r / max(rh, 1e-4) - spin) * sin(a * 5.0 - 9.0 * r / max(rh, 1e-4) - spin * 0.7);
          float doppler = 1.0 + 0.6 * cos(a - spin * 0.3);
          float x = (r - rh * 1.7) / (rh * 0.55 + 1e-4), y = (r - rh * 1.08) / (rh * 0.06 + 1e-4);
          float disk = exp(-x * x) * streak * doppler;
          float photon = exp(-y * y);
          glow += (mix(vec3(1.0, 0.35, 0.08), vec3(1.0, 0.85, 0.55), photon) * (disk * 0.9 + photon * 1.4)) * smoothstep(0.0, 0.2, m);
          // Grip ring: appears on hover, tightens onto the horizon as the fingers close, brightens when held.
          float gl = holes[i].w, ga = min(gl, 1.0), held = clamp(gl - 1.0, 0.0, 1.0);
          float rr = mix(2.8, 1.35, ga) * max(rh, 0.012);
          float gz = (r - rr) / (rr * 0.06 + 0.002);
          glow += vec3(0.55, 0.78, 1.0) * exp(-gz * gz) * ga * (0.45 + 0.55 * held);
        }

        for (int i = 0; i < ${MAX}; i++) {
          float s = shocks[i].w;
          if (s < 0.001) continue;
          float age = shocks[i].z;
          vec2 d = p - (shocks[i].xy - 0.5) * ar;
          float r = length(d);
          float x = (r - age * 0.75) / (0.035 + age * 0.04);
          float g = exp(-x * x);
          float fade = pow(1.0 - age / ${SHOCK_LIFE.toFixed(1)}, 2.0) * s;
          q -= d / max(r, 1e-4) * g * fade * 0.07 * (0.4 + 0.6 * motion);
          glow += vec3(0.45, 0.6, 1.0) * g * fade * 0.35 * (0.5 + 0.5 * motion);
        }

        vec3 col = sky(q) * horizon + glow * horizon;
        col = 1.0 - exp(-col * 1.3);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const u = material.uniforms;
  const hands = new Map<string, HandState>();
  const holes: Hole[] = [];
  const shocks: Shock[] = Array.from({ length: MAX }, () => ({ x: 0, y: 0, age: SHOCK_LIFE, strength: 0 }));
  let nextShock = 0;

  const shock = (x: number, y: number, strength: number) => {
    const s = shocks[nextShock];
    s.x = x;
    s.y = y;
    s.age = 0;
    s.strength = strength;
    nextShock = (nextShock + 1) % MAX;
  };
  const detach = (h: Hole) => {
    const o = h.owner;
    if (o?.held === h) o.held = null;
    if (o?.attached === h) o.attached = null;
    h.owner = null;
  };
  const collapse = (h: Hole) => {
    detach(h);
    h.collapsing = true;
    shock(h.x, h.y, h.mass);
  };
  const release = (h: Hole) => {
    detach(h);
    // A soft ring on letting go; faster throws ring harder.
    shock(h.x, h.y, (0.2 + 0.15 * Math.hypot(h.vx, h.vy)) * Math.max(h.mass, 0.3));
  };
  const create = (x: number, y: number, owner: HandState) => {
    if (holes.length >= MAX) {
      const old = holes.find((h) => !h.owner && !h.collapsing);
      if (old) collapse(old);
    }
    const h: Hole = { x, y, vx: 0, vy: 0, mass: 0, collapsing: false, owner, glow: 0, target: 0 };
    holes.push(h);
    return h;
  };
  // Nearest grabbable hole within its pick radius (grows with mass); holes owned by other hands are skipped.
  const nearest = (x: number, y: number, self: HandState) => {
    let best: Hole | null = null, bd = Infinity;
    for (const h of holes) {
      if (h.collapsing || (h.owner && h.owner !== self)) continue;
      const d = Math.hypot((h.x - x) * u.aspect.value, h.y - y);
      if (d < 0.07 + 0.16 * h.mass && d < bd) (best = h), (bd = d);
    }
    return best;
  };
  // Ease a hole toward (x, y), keeping a smoothed velocity so a release can throw it.
  const follow = (h: Hole, x: number, y: number, rate: number, dt: number) => {
    const k = 1 - Math.exp(-dt * rate), sv = Math.min(1, dt * 12), idt = 1 / Math.max(dt, 1e-3);
    const nx = h.x + (x - h.x) * k, ny = h.y + (y - h.y) * k;
    h.vx += ((nx - h.x) * idt - h.vx) * sv;
    h.vy += ((ny - h.y) * idt - h.vy) * sv;
    const sp = Math.hypot(h.vx, h.vy);
    if (sp > MAX_SPEED) (h.vx *= MAX_SPEED / sp), (h.vy *= MAX_SPEED / sp);
    h.x = nx;
    h.y = ny;
  };

  return {
    id: 'blackhole',
    title: meta.title,
    hint: { text: '손바닥을 펴 블랙홀을 키우고, 집어서 던져 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      u.time.value += dt;
      for (const st of hands.values()) st.seen = false;
      for (const h of holes) h.target = 0;

      for (const hand of input.hands) {
        const pointer = hand.kind === 'pointer';
        let st = hands.get(hand.id);
        if (!st) hands.set(hand.id, (st = { attached: null, held: null, prevPinch: false, prevFist: false, seen: false, pointer }));
        st.seen = true;
        const palm = pointer ? hand.cursor : hand.landmarks[9] ?? hand.cursor;
        const px = palm.x, py = 1 - palm.y, qx = hand.pinchPoint.x, qy = 1 - hand.pinchPoint.y;
        // Pointers report fist with every press; only a tracked fist collapses.
        const fist = !pointer && hand.gestures.fist;
        const pinch = hand.gestures.pinch && !fist;
        // A hovering mouse plays the open palm; an "OK" hand that reads as open and pinch counts as pinch.
        const open = !pinch && (pointer || hand.gestures.open);

        if (!open && st.attached) detach(st.attached); // palm closed: the hole drifts off with the hand's momentum
        if (fist && !st.prevFist) {
          const h = st.held ?? nearest(px, py, st);
          if (h) collapse(h);
        }
        if (pinch && !st.prevPinch && !st.held) {
          const h = nearest(qx, qy, st) ?? create(qx, qy, st);
          detach(h);
          h.owner = st;
          st.held = h;
        }
        if (st.held && !pinch) release(st.held);

        if (st.held) {
          follow(st.held, qx, qy, 25, dt);
          st.held.mass += (1 - st.held.mass) * (1 - Math.exp(-dt * 0.8));
          st.held.target = 2;
        } else {
          if (open) {
            st.attached ??= create(px, py, st);
            follow(st.attached, px, py, 12, dt);
            st.attached.mass += (1 - st.attached.mass) * (1 - Math.exp(-dt * 1.2));
          }
          // Anticipation: the hole under the pinch point shows its grip ring, tightening as the fingers close.
          const h = nearest(qx, qy, st);
          if (h) h.target = Math.max(h.target, 0.25 + 0.75 * hand.pinchStrength);
        }
        st.prevPinch = pinch;
        st.prevFist = fist;
      }

      for (const [id, st] of hands) {
        if (st.seen) continue;
        // A lifted touch throws what it held; a mouse leaving collapses its hover hole; a lost tracked hand lets go.
        if (st.held) release(st.held);
        if (st.attached) {
          if (st.pointer && st.attached.mass > COLLAPSE_MIN) collapse(st.attached);
          else detach(st.attached);
        }
        hands.delete(id);
      }

      const friction = Math.exp(-dt * 0.5), decay = Math.exp(-dt * 0.12), gk = 1 - Math.exp(-dt * 14);
      for (let j = holes.length - 1; j >= 0; j--) {
        const h = holes[j];
        if (!h.owner) {
          h.x += h.vx * dt;
          h.y += h.vy * dt;
          h.vx *= friction;
          h.vy *= friction;
          // Soft bounce off the screen edges so a throw stays in view.
          if ((h.x < 0 && h.vx < 0) || (h.x > 1 && h.vx > 0)) h.vx *= -0.7;
          if ((h.y < 0 && h.vy < 0) || (h.y > 1 && h.vy > 0)) h.vy *= -0.7;
          h.mass = h.collapsing ? Math.max(0, h.mass - dt * 3) : h.mass * decay;
        }
        h.glow += (h.target - h.glow) * gk;
        if (!h.owner && h.mass < (h.collapsing ? 0.001 : 0.03)) holes.splice(j, 1);
      }

      // Newest first, so a fresh hole is visible even while an evicted one is still collapsing.
      let i = 0;
      for (let j = holes.length - 1; j >= 0 && i < MAX; j--) u.holes.value[i++].set(holes[j].x, holes[j].y, holes[j].mass, holes[j].glow);
      for (; i < MAX; i++) u.holes.value[i].set(0, 0, 0, 0);
      shocks.forEach((s, j) => {
        s.age = Math.min(SHOCK_LIFE, s.age + dt);
        u.shocks.value[j].set(s.x, s.y, s.age, s.age < SHOCK_LIFE ? s.strength : 0);
      });

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      u.aspect.value = width / height;
    },
    dispose() {
      scene.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
      material.dispose();
    },
  };
};
