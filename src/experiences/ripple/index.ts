import * as THREE from 'three';
import type { Experience, Hand } from '../../core/types.ts';
import meta from './meta.ts';

// GPU wave equation at 1/4 resolution, refracting a procedural pool floor. Pinch grabs the surface: a deep dimple
// follows the pinch point (it starts sinking as the fingers close) and release lets it spring back into a ring wave.
// Fingertips and a hovering pointer still stir wakes.
const MAX_DROPS = 48;
const MAX_HANDS = 8;
const TIPS = [4, 8, 12, 16, 20];
const SIM_HZ = 120;
const DAMPING = 0.992; // per step at 120 Hz ≈ 0.985 per 60 Hz frame
const HOLD_R = 0.06; // dimple radius, screen heights
const HOLD_DEPTH = 1.3;

const vertexShader = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

interface HandState { stamp: number; pinch: boolean; tips: Float32Array; depth: number; x: number; y: number }

export default (): Experience => {
  let renderer: THREE.WebGLRenderer;
  let read!: THREE.WebGLRenderTarget;
  let write!: THREE.WebGLRenderTarget;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.5 : 1;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const holds = Array.from({ length: MAX_HANDS }, () => new THREE.Vector4()); // x, y (uv), radius, depth; shared by both passes

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      state: { value: null as THREE.Texture | null },
      texel: { value: new THREE.Vector2() },
      aspect: { value: 1 },
      count: { value: 0 },
      segs: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) }, // a.xy, b.xy in uv
      params: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector2()) }, // radius, strength
      holdCount: { value: 0 },
      holds: { value: holds },
    },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D state;
      uniform vec2 texel;
      uniform float aspect;
      uniform int count, holdCount;
      uniform vec4 segs[${MAX_DROPS}];
      uniform vec2 params[${MAX_DROPS}];
      uniform vec4 holds[${MAX_HANDS}];
      varying vec2 vUv;
      void main() {
        vec2 c = texture2D(state, vUv).rg;
        float sum = texture2D(state, vUv + vec2(texel.x, 0.0)).r + texture2D(state, vUv - vec2(texel.x, 0.0)).r
                  + texture2D(state, vUv + vec2(0.0, texel.y)).r + texture2D(state, vUv - vec2(0.0, texel.y)).r;
        float h = (sum * 0.5 - c.g) * ${DAMPING};
        vec2 k = vec2(aspect, 1.0);
        vec2 p = vUv * k;
        for (int i = 0; i < ${MAX_DROPS}; i++) {
          if (i >= count) break;
          vec2 a = segs[i].xy * k, ab = segs[i].zw * k - a;
          float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
          float d = length(p - a - ab * t), r = params[i].x;
          if (d < r) h += params[i].y * (0.5 + 0.5 * cos(3.14159265 * d / r));
        }
        // Held dimples: pull the surface toward a cosine bowl every step (a constraint, so moving it drags a wake).
        for (int i = 0; i < ${MAX_HANDS}; i++) {
          if (i >= holdCount) break;
          float d = length(p - holds[i].xy * k), r = holds[i].z;
          if (d < r) {
            float prof = 0.5 + 0.5 * cos(3.14159265 * d / r);
            h = mix(h, -holds[i].w * prof, 0.35 * prof);
          }
        }
        gl_FragColor = vec4(clamp(h, -2.0, 2.0), c.r, 0.0, 1.0);
      }`,
  });

  const viewMat = new THREE.ShaderMaterial({
    uniforms: {
      heightTex: { value: null as THREE.Texture | null },
      texel: { value: new THREE.Vector2() },
      aspect: { value: 1 },
      time: { value: 0 },
      holdCount: { value: 0 },
      holds: { value: holds },
    },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D heightTex;
      uniform vec2 texel;
      uniform float aspect, time;
      uniform int holdCount;
      uniform vec4 holds[${MAX_HANDS}];
      varying vec2 vUv;
      float H(vec2 o) { return texture2D(heightTex, vUv + o * texel).r; }
      // Tileable water caustic (Dave_Hoskins / joltz0r), kept soft.
      float caustic(vec2 uv, float t) {
        vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
        vec2 i = p;
        float c = 1.0;
        for (int n = 0; n < 4; n++) {
          float tt = t * (1.0 - 3.5 / float(n + 1));
          i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
        }
        c = 1.17 - pow(c / 4.0, 1.4);
        return pow(abs(c), 8.0);
      }
      vec3 floorColor(vec2 uv) {
        vec3 col = mix(vec3(0.005, 0.03, 0.09), vec3(0.03, 0.22, 0.36), smoothstep(-0.2, 1.2, uv.y));
        col += vec3(0.2, 0.5, 0.55) * 0.3 * caustic(uv * vec2(aspect, 1.0) * 0.8, time * ${(0.25 * motion).toFixed(3)} + 23.0);
        return col;
      }
      void main() {
        float c = H(vec2(0.0));
        float e = H(vec2(1.0, 0.0)), w = H(vec2(-1.0, 0.0)), n = H(vec2(0.0, 1.0)), s = H(vec2(0.0, -1.0));
        vec3 nrm = normalize(vec3(-(e - w) * 3.0, -(n - s) * 3.0, 1.0));
        vec3 col = floorColor(vUv + nrm.xy * 0.05);
        // Converging wavefronts focus light: brighten where the surface is concave.
        col += vec3(0.3, 0.6, 0.7) * clamp(-(e + w + n + s - 4.0 * c) * 2.0, 0.0, 0.4);
        col += vec3(0.15, 0.3, 0.4) * (1.0 - nrm.z) * 2.0;
        vec3 hv = normalize(normalize(vec3(-0.5, 0.7, 1.0)) + vec3(0.0, 0.0, 1.0));
        col += vec3(0.9, 0.95, 1.0) * pow(max(dot(nrm, hv), 0.0), 120.0);
        // Meniscus rim around each held dimple: wide and faint while the fingers close, tight and bright once grabbed.
        vec2 k = vec2(aspect, 1.0);
        for (int i = 0; i < ${MAX_HANDS}; i++) {
          if (i >= holdCount) break;
          float a = clamp(holds[i].w / ${HOLD_DEPTH.toFixed(2)}, 0.0, 1.0);
          float rr = holds[i].z * mix(1.7, 1.05, a);
          float z = (length(vUv * k - holds[i].xy * k) - rr) / (holds[i].z * 0.08);
          col += vec3(0.7, 0.9, 1.0) * exp(-z * z) * a * 0.3;
        }
        float vig = smoothstep(1.3, 0.3, length((vUv - 0.5) * k));
        gl_FragColor = vec4(col * mix(0.6, 1.0, vig), 1.0);
      }`,
  });

  const simScene = new THREE.Scene().add(new THREE.Mesh(geometry, simMat));
  const viewScene = new THREE.Scene().add(new THREE.Mesh(geometry, viewMat));
  const su = simMat.uniforms;
  const vu = viewMat.uniforms;

  // Per-hand state keyed by id: last tip positions (uv) for continuous wakes, and the held dimple. Vanished ids are dropped.
  const state = new Map<string, HandState>();
  let stamp = 0;
  let count = 0;
  let acc = 0;

  const drop = (ax: number, ay: number, bx: number, by: number, radius: number, strength: number) => {
    if (count >= MAX_DROPS || strength === 0) return;
    su.segs.value[count].set(ax, ay, bx, by);
    su.params.value[count].set(radius, -strength * motion); // positive strength pushes the surface down
    count++;
  };

  // Letting go: the dimple is dropped at once so the surface springs back, plus an upward kick for a bigger ring.
  const release = (st: HandState) => {
    drop(st.x, st.y, st.x, st.y, HOLD_R * 1.1, -0.5 * st.depth);
    st.depth = 0;
  };

  const handInput = (hand: Hand, dt: number) => {
    const pointer = hand.kind === 'pointer';
    const n = pointer ? 1 : TIPS.length;
    let st = state.get(hand.id);
    const fresh = !st;
    if (!st) state.set(hand.id, (st = { stamp, pinch: false, tips: new Float32Array(10), depth: 0, x: 0, y: 0 }));
    st.stamp = stamp;
    const pinch = hand.gestures.pinch;
    st.x = hand.pinchPoint.x;
    st.y = 1 - hand.pinchPoint.y;

    // Wakes: fingertips past a speed threshold; a hovering pointer only when moving fast (a press grabs instead).
    const speed = Math.hypot(hand.velocity.x, hand.velocity.y);
    let s = pointer ? (pinch ? 0 : Math.min(Math.max(speed - 0.6, 0) * 0.2, 0.3)) : Math.min(Math.max(speed - 0.15, 0) * 0.25, 0.35);
    s *= Math.min(dt * 60, 2);
    const r = pointer ? 0.018 : 0.014;
    for (let i = 0; i < n; i++) {
      const p = pointer ? hand.cursor : hand.landmarks[TIPS[i]];
      const x = p.x, y = 1 - p.y;
      if (!fresh) drop(st.tips[i * 2], st.tips[i * 2 + 1], x, y, r, s);
      st.tips[i * 2] = x;
      st.tips[i * 2 + 1] = y;
    }

    if (st.pinch && !pinch) release(st);
    else {
      // Anticipation: closing fingers start to sink the water before the pinch fires; a pinch sinks it fully.
      const a = Math.min(Math.max((hand.pinchStrength - 0.3) / 0.7, 0), 1);
      const target = pinch ? HOLD_DEPTH : 0.3 * HOLD_DEPTH * a * a;
      st.depth += (target - st.depth) * (1 - Math.exp(-dt * 12));
    }
    st.pinch = pinch;
  };

  return {
    id: 'ripple',
    title: meta.title,
    hint: { text: '물을 집어 당겼다가 놓아 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      vu.time.value += dt;
      count = 0;
      stamp++;

      const n = Math.min(input.hands.length, MAX_HANDS);
      for (let i = 0; i < n; i++) handInput(input.hands[i], dt);
      let hc = 0;
      for (const [id, st] of state) {
        if (st.stamp !== stamp) {
          if (st.pinch) release(st); // a lifted touch lets go too
          state.delete(id);
        } else if (st.depth > 0.005) holds[hc++].set(st.x, st.y, HOLD_R, st.depth * motion);
      }
      su.holdCount.value = vu.holdCount.value = hc;

      // Idle rain so the pool stays alive with no input.
      if (Math.random() < (reduced ? 0.25 : 0.9) * dt) {
        const x = Math.random(), y = Math.random();
        drop(x, y, x, y, 0.012 + Math.random() * 0.01, 0.3 + Math.random() * 0.3);
      }

      acc = Math.min(acc + dt, 4 / SIM_HZ);
      su.count.value = count;
      while (acc >= 1 / SIM_HZ) {
        acc -= 1 / SIM_HZ;
        su.state.value = read.texture;
        renderer.setRenderTarget(write);
        renderer.render(simScene, camera);
        [read, write] = [write, read];
        su.count.value = 0; // inject once per frame, not per sub-step
      }

      vu.heightTex.value = read.texture;
      renderer.setRenderTarget(null);
      renderer.render(viewScene, camera);
    },
    resize(width, height) {
      read?.dispose();
      write?.dispose();
      const w = Math.max(1, Math.round(width / 4)), h = Math.max(1, Math.round(height / 4));
      const opts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
      read = new THREE.WebGLRenderTarget(w, h, opts);
      write = new THREE.WebGLRenderTarget(w, h, opts);
      su.texel.value.set(1 / w, 1 / h);
      vu.texel.value.set(1 / w, 1 / h);
      su.aspect.value = vu.aspect.value = width / height;
    },
    dispose() {
      read?.dispose();
      write?.dispose();
      geometry.dispose();
      simMat.dispose();
      viewMat.dispose();
    },
  };
};
