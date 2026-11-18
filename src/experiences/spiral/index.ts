import * as THREE from 'three';
import type { Experience, Hand } from '../../core/types.ts';
import meta from './meta.ts';

// Vogel phyllotaxis: seed n sits at r = c·√n, θ = n·divergence. Everything is placed in the vertex shader from a few uniforms.
// Pinch the rim to twist (angle) and resize (distance) it, release keeps it spinning; pinch the core to drag it.
const N = 2000;
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // 137.508°
const MAX_OFFSET = (4 * Math.PI) / 180; // divergence may drift ±4° off golden
const PALM = 9;
const CORE = 0.55; // pinch within this fraction of the radius drags the centre; out to RIM twists
const RIM = 1.35;

export default (): Experience => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduce ? 0.35 : 1;
  const MAX_SPIN = 5 * motion;

  let renderer: THREE.WebGLRenderer;
  let aspect = 1;
  let time = 0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(meta.bg);
  // Aspect-corrected, y up: x ∈ [-aspect, aspect], y ∈ [-1, 1].
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  const idx = new Float32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i + 1;
  geo.setAttribute('aIdx', new THREE.InstancedBufferAttribute(idx, 1));
  geo.instanceCount = N;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector2() },
      uC: { value: 0.018 },
      uDiv: { value: GOLDEN },
      uRot: { value: 0 },
      uRim: { value: 0 }, // rim hover/hold 0..1: petals swell and redden
      uCore: { value: 0 }, // core hover/hold 0..1: centre seeds swell and redden
      uInk: { value: new THREE.Color(meta.ink) },
    },
    vertexShader: /* glsl */ `
      attribute float aIdx;
      uniform vec2 uCenter;
      uniform float uC, uDiv, uRot, uRim, uCore;
      varying vec2 vUv;
      varying float vPetal, vIdx, vCore;
      void main() {
        float f = aIdx / ${N}.0;
        float petal = smoothstep(0.86, 0.97, f); // outermost ring stretches into petals
        float core = 1.0 - smoothstep(0.0, 0.3, f);
        float s = uC * (0.42 + 0.24 * f) * (1.0 + 0.45 * uRim * petal + 0.5 * uCore * core);
        float th = aIdx * uDiv + uRot;
        vec2 dir = vec2(cos(th), sin(th));
        vec2 local = vec2(position.x * s, position.y * s * (1.0 + 1.8 * petal)); // local y points outward
        // Basis (x → (dir.y, -dir.x), y → dir) keeps det = +1, so quads stay front-facing (CCW) and aren't culled.
        vec2 p = uCenter + dir * (uC * sqrt(aIdx) + petal * s * 1.4) + dir * local.y + vec2(dir.y, -dir.x) * local.x;
        vUv = position.xy;
        vPetal = petal;
        vIdx = aIdx;
        vCore = core;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk;
      uniform float uRim, uCore;
      varying vec2 vUv;
      varying float vPetal, vIdx, vCore;
      void main() {
        float w = max(1.0 - vPetal * 0.75 * max(vUv.y, 0.0), 0.05); // taper petal tips
        float d = length(vec2(vUv.x / w, vUv.y));
        float a = 1.0 - smoothstep(1.0 - fwidth(d) * 1.5, 1.0, d);
        if (a <= 0.0) discard;
        // Flat poster palette: ink seeds, Fibonacci-modulo arms (21 / 34) in red and cream; petals/core redden when pinched.
        vec3 red = vec3(0.85, 0.2, 0.1), cream = vec3(1.0, 0.95, 0.83);
        vec3 col = uInk;
        if (mod(vIdx, 34.0) < 2.0) col = cream;
        if (mod(vIdx, 21.0) < 3.0) col = red;
        col = mix(col, red, vCore * uCore * 0.8);
        col = mix(col, mix(cream, red, uRim), vPetal);
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const u = mat.uniforms;

  // Smoothed shape (current) and targets.
  let cx = 0, cy = 0, R = 0.8, off = 0;
  let tx = 0, ty = 0, tR = 0.8, tOff = 0;
  let rot = 0, spin = 0, rim = 0, core = 0;
  // One pinch grab at a time: hand id, rim (twist) or core (drag), and the anchors it started from.
  let grabId: string | null = null, grabRim = false;
  let lastAng = 0, d0 = 1, R0 = 1, offX = 0, offY = 0;
  const wasPinch = new Set<string>();

  const px = (h: Hand) => (h.landmarks[PALM].x * 2 - 1) * aspect;
  const py = (h: Hand) => 1 - h.landmarks[PALM].y * 2;
  // t ∈ [-1, 1] → divergence offset; eased so the golden neighbourhood is wider.
  const offsetOf = (t: number) => {
    const c = Math.max(-1, Math.min(1, t));
    return Math.sign(c) * Math.abs(c) ** 1.6 * MAX_OFFSET;
  };

  return {
    id: 'spiral',
    title: meta.title,
    hint: { text: '나선 가장자리를 집어 돌리고, 가운데를 집어 옮겨 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      dt = Math.min(dt, 0.1);
      time += dt;
      const hands = input.hands;
      const baseR = 0.82 * Math.min(1, aspect);
      let follow = 2; // center damping rate (1/s)
      let rimT = 0, coreT = 0;

      // Pinch: hover zones light up as fingers close; onset in a zone grabs it.
      let grabHand: Hand | undefined;
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        const pinch = h.gestures.pinch;
        const was = wasPinch.has(h.id);
        if (pinch) wasPinch.add(h.id);
        else wasPinch.delete(h.id);
        if (h.id === grabId) {
          if (pinch) grabHand = h;
          continue;
        }
        const hx = (h.pinchPoint.x * 2 - 1) * aspect, hy = 1 - h.pinchPoint.y * 2;
        const d = Math.hypot(hx - cx, hy - cy);
        const zone = d < CORE * R ? 2 : d < RIM * R ? 1 : 0;
        if (!zone) continue;
        if (grabId === null && pinch && !was) {
          grabId = h.id;
          grabRim = zone === 1;
          lastAng = Math.atan2(hy - cy, hx - cx);
          d0 = Math.max(d, 0.05);
          R0 = R;
          offX = cx - hx;
          offY = cy - hy;
          grabHand = h;
        } else if (!pinch) {
          const k = 0.3 + 0.7 * h.pinchStrength;
          if (zone === 1) rimT = Math.max(rimT, k);
          else coreT = Math.max(coreT, k);
        }
      }
      if (hands.length === 0) wasPinch.clear();
      if (!grabHand) grabId = null; // released (or hand lost): spin carries on
      const twisting = grabHand !== undefined && grabRim;

      if (grabHand) {
        const hx = (grabHand.pinchPoint.x * 2 - 1) * aspect, hy = 1 - grabHand.pinchPoint.y * 2;
        if (grabRim) {
          // Rotation follows the angle swept around the centre; radius scales with distance from it.
          const ang = Math.atan2(hy - cy, hx - cx);
          let da = ang - lastAng;
          if (da > Math.PI) da -= 2 * Math.PI;
          else if (da < -Math.PI) da += 2 * Math.PI;
          lastAng = ang;
          rot += da;
          const w = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, da / Math.max(dt, 1e-3)));
          spin += (w - spin) * (1 - Math.exp(-dt * 10));
          tR = Math.max(0.15, Math.min(1.6, (R0 * Math.hypot(hx - cx, hy - cy)) / d0));
          rimT = 1;
        } else {
          tx = hx + offX;
          ty = hy + offY;
          follow = 15;
          coreT = 1;
        }
      } else if (hands.length >= 2 && !hands[0].gestures.pinch && !hands[1].gestures.pinch) {
        // Two open hands: stretch and tilt the arms.
        const a = hands[0], b = hands[1];
        const ax = px(a), ay = py(a), bx = px(b), by = py(b);
        tx = (ax + bx) / 2;
        ty = (ay + by) / 2;
        tR = Math.max(0.15, Math.hypot(bx - ax, by - ay) / 2);
        // Tilt of the hand-to-hand line, folded to ±90° so hand order doesn't matter; level hands = golden.
        let ang = Math.atan2(by - ay, bx - ax);
        if (ang > Math.PI / 2) ang -= Math.PI;
        else if (ang < -Math.PI / 2) ang += Math.PI;
        tOff = offsetOf(ang / (Math.PI / 4));
        follow = 8;
      } else if (hands.length === 0) {
        // Idle: drift home, breathe, let the arms slowly wander around golden.
        tx = 0;
        ty = 0;
        tR = baseR * (1 + 0.025 * motion * Math.sin(time * 1.1));
        tOff = reduce ? 0 : 0.0014 * Math.sin(time * 0.3);
      }

      // Any other swiping hand flings the spiral around its center (angular velocity from r × v).
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        if (!h.gestures.swipe || h === grabHand) continue;
        const rx = px(h) - cx, ry = py(h) - cy;
        const vx = h.velocity.x * 2 * aspect, vy = -h.velocity.y * 2;
        const w = (rx * vy - ry * vx) / Math.max(rx * rx + ry * ry, 0.04);
        const target = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, w));
        spin += (target - spin) * (1 - Math.exp(-dt * 4));
      }
      if (!twisting) {
        spin *= Math.exp(-dt * 0.5);
        rot += (0.1 * motion + spin) * dt;
      }

      const kc = 1 - Math.exp(-dt * follow);
      cx += (tx - cx) * kc;
      cy += (ty - cy) * kc;
      R += (tR - R) * (1 - Math.exp(-dt * (twisting ? 15 : 5)));
      off += (tOff - off) * (1 - Math.exp(-dt * 4));
      rim += (rimT - rim) * (1 - Math.exp(-dt * 12));
      core += (coreT - core) * (1 - Math.exp(-dt * 12));

      u.uCenter.value.set(cx, cy);
      u.uC.value = R / Math.sqrt(N);
      u.uDiv.value = GOLDEN + off;
      u.uRot.value = rot;
      u.uRim.value = rim;
      u.uCore.value = core;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      aspect = width / height;
      camera.left = -aspect;
      camera.right = aspect;
      camera.updateProjectionMatrix();
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
};
