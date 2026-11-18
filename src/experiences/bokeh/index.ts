import * as THREE from 'three';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// Night-city bokeh: fingertips shed defocused light discs, pinch picks up a light (it snaps into focus) and release throws it,
// open palm paints trails, swipe scatters.
const N = 3000; // total discs: ambient first, then a ring buffer of spawned ones
const N_AMB = 160;
const MAX_SLOTS = 8;
const TIPS = [4, 8, 12, 16, 20];
const NT = TIPS.length;
const FOCUS_R = 0.3; // screen heights
const SCATTER_R = 0.35;
const TIP_SPACING = 0.03; // one disc per this much fingertip travel
const TRAIL_SPACING = 0.007;
const SLOW_MIN = 0.04; // open-palm speed band (screen heights / s) that paints trails
const SLOW_MAX = 0.9;
const GRAB_R = 0.06; // pick slack beyond a disc's own radius (screen heights)
// amber, warm white, sodium orange, tail-light red, neon pink, rare cyan
const PALETTE = [1, 0.72, 0.36, 1, 0.9, 0.75, 1, 0.5, 0.24, 1, 0.26, 0.3, 1, 0.45, 0.6, 0.5, 0.84, 1];

export default (): Experience => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduce ? 0.4 : 1;
  const twinkle = reduce ? 0.08 : 0.25;

  let renderer: THREE.WebGLRenderer;
  let aspect = 1;
  let time = 0;
  let rack = 0; // 0..1, any pinch active: out-of-focus discs blur further
  let head = N_AMB;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // shaders write clip space directly

  // Particle state (screen 0..1, y down; x in widths, sizes in heights).
  const px = new Float32Array(N), py = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N);
  const rise = new Float32Array(N), age = new Float32Array(N), life = new Float32Array(N);
  const size = new Float32Array(N), focus = new Float32Array(N), sharp0 = new Float32Array(N), seed = new Float32Array(N);
  const posArr = new Float32Array(N * 4); // x, y, radius, focus
  const colArr = new Float32Array(N * 4); // rgb, alpha

  const cidx = new Uint8Array(N_AMB); // palette index per ambient disc (release sparks reuse it)
  const heldBy = new Int8Array(N_AMB).fill(-1); // slot holding this disc
  const lift = new Float32Array(N_AMB); // per frame: 0 none, hover 0.3..1 with pinch closure, held 1
  const setColor = (i: number, c: number) => {
    colArr[i * 4] = PALETTE[c * 3];
    colArr[i * 4 + 1] = PALETTE[c * 3 + 1];
    colArr[i * 4 + 2] = PALETTE[c * 3 + 2];
  };
  for (let i = 0; i < N_AMB; i++) {
    px[i] = Math.random();
    py[i] = Math.random();
    rise[i] = 0.004 + Math.random() * 0.01;
    size[i] = 0.025 + Math.random() * 0.07;
    seed[i] = Math.random() * 100;
    cidx[i] = Math.random() < 0.08 ? 5 : Math.floor(Math.random() * 5);
    setColor(i, cidx[i]);
  }

  const spawn = (x: number, y: number, trail: boolean, c: number) => {
    const i = head;
    head = head + 1 >= N ? N_AMB : head + 1;
    const a = Math.random() * Math.PI * 2;
    const s = trail ? 0.004 : 0.02 + Math.random() * 0.03;
    px[i] = x;
    py[i] = y;
    vx[i] = Math.cos(a) * s;
    vy[i] = Math.sin(a) * s - (trail ? 0 : 0.05 * motion);
    rise[i] = trail ? 0.006 + Math.random() * 0.01 : 0.03 + Math.random() * 0.06;
    age[i] = 0;
    life[i] = trail ? 3.5 + Math.random() * 2 : 2 + Math.random() * 2.5;
    size[i] = trail ? 0.006 + Math.random() * 0.008 : 0.012 + Math.random() * 0.03;
    sharp0[i] = trail ? 0.7 : 0;
    focus[i] = sharp0[i];
    seed[i] = Math.random() * 100;
    setColor(i, c);
  };

  // Hand slots keyed by hand.id.
  const slotId: (string | null)[] = new Array(MAX_SLOTS).fill(null);
  const slotSeen = new Uint8Array(MAX_SLOTS);
  const tipX = new Float32Array(MAX_SLOTS * NT), tipY = new Float32Array(MAX_SLOTS * NT), tipAcc = new Float32Array(MAX_SLOTS * NT);
  const palmX = new Float32Array(MAX_SLOTS), palmY = new Float32Array(MAX_SLOTS), palmAcc = new Float32Array(MAX_SLOTS);
  const slotHeld = new Int16Array(MAX_SLOTS).fill(-1), slotPinch = new Uint8Array(MAX_SLOTS);
  const slotVx = new Float32Array(MAX_SLOTS), slotVy = new Float32Array(MAX_SLOTS);
  // Per-frame focus / scatter sources (one per hand + idle).
  let nf = 0, ns = 0;
  const fx = new Float32Array(MAX_SLOTS + 1), fy = new Float32Array(MAX_SLOTS + 1), fs = new Float32Array(MAX_SLOTS + 1);
  const sx = new Float32Array(MAX_SLOTS), sy = new Float32Array(MAX_SLOTS), svx = new Float32Array(MAX_SLOTS), svy = new Float32Array(MAX_SLOTS);

  // Emits spawns along a path segment; returns the leftover accumulator.
  const emit = (x0: number, y0: number, x1: number, y1: number, acc: number, cap: number, trail: boolean, c: number) => {
    const n = Math.min(Math.floor(acc), cap);
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      spawn(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, trail, trail ? (j & 1) : c);
    }
    return acc - Math.floor(acc);
  };

  // Ambient disc under (x, y), -1 if none: nearest by distance to its rim.
  const pick = (x: number, y: number) => {
    let best = -1, bd = GRAB_R;
    for (let i = 0; i < N_AMB; i++) {
      if (heldBy[i] >= 0) continue;
      const d = Math.hypot((px[i] - x) * aspect, py[i] - y) - size[i];
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  // Let go: the disc keeps the hand's velocity (relaxes back to drift) and sheds a few sparks.
  const release = (s: number) => {
    const i = slotHeld[s];
    slotHeld[s] = -1;
    slotPinch[s] = 0;
    if (i < 0) return;
    heldBy[i] = -1;
    vx[i] = Math.max(-2, Math.min(2, slotVx[s]));
    vy[i] = Math.max(-2, Math.min(2, slotVy[s]));
    for (let k = 0; k < 6; k++) spawn(px[i], py[i], false, cidx[i]);
  };

  const background = new THREE.ShaderMaterial({
    uniforms: { aspect: { value: 1 } },
    depthTest: false,
    depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform float aspect;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - vec2(0.5, 0.4)) * vec2(aspect, 1.0);
        vec3 col = mix(vec3(0.012, 0.004, 0.006), vec3(0.1, 0.022, 0.032), exp(-dot(p, p) * 1.6));
        col += vec3(0.05, 0.014, 0.0) * smoothstep(0.55, 0.0, vUv.y); // warm street haze at the bottom
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const bgGeo = new THREE.PlaneGeometry(2, 2);
  const bgMesh = new THREE.Mesh(bgGeo, background);
  bgMesh.frustumCulled = false;
  scene.add(bgMesh);

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const posAttr = new THREE.InstancedBufferAttribute(posArr, 4).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.InstancedBufferAttribute(colArr, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', posAttr);
  geo.setAttribute('aCol', colAttr);
  geo.instanceCount = N;
  const discMat = new THREE.ShaderMaterial({
    uniforms: { aspect: { value: 1 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aPos;
      attribute vec4 aCol;
      uniform float aspect;
      varying vec2 vUv;
      varying vec4 vCol;
      varying float vFocus;
      void main() {
        vUv = position.xy * 2.0;
        vCol = aCol;
        vFocus = aPos.w;
        vec2 c = vec2(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0);
        gl_Position = vec4(c + position.xy * 4.0 * aPos.z * vec2(1.0 / aspect, 1.0), 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec4 vCol;
      varying float vFocus;
      // Flat disc with a brighter rim, like a real out-of-focus highlight.
      float disc(float d, float r) {
        return smoothstep(r, r - 0.08, d) * (0.6 + 0.55 * smoothstep(r - 0.3, r - 0.02, d));
      }
      void main() {
        vec2 a = abs(vUv);
        float hex = max(a.x * 0.8660254 + a.y * 0.5, a.y); // six-blade aperture
        float d = mix(length(vUv), hex, 0.6);
        // Per-channel radius = lateral chromatic fringe (red outside, blue inside).
        vec3 soft = vec3(disc(d, 0.86), disc(d, 0.83), disc(d, 0.8)) * 0.32;
        float r2 = dot(vUv, vUv);
        vec3 sharp = vec3(exp(-r2 * 28.0) * 1.6 + exp(-r2 * 5.0) * 0.12);
        gl_FragColor = vec4(mix(soft, sharp, vFocus) * vCol.rgb * vCol.a, 1.0);
      }`,
  });
  const discs = new THREE.Mesh(geo, discMat);
  discs.frustumCulled = false;
  discs.renderOrder = 1;
  scene.add(discs);

  return {
    id: 'bokeh',
    title: meta.title,
    hint: { text: '빛 방울을 손가락으로 집어 옮기고, 놓으며 던져 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, rawDt) {
      const dt = Math.min(rawDt, 0.05);
      time += dt;
      nf = 0;
      ns = 0;
      slotSeen.fill(0);
      lift.fill(0);
      let pinching = 0;

      const hands = input.hands;
      for (let h = 0; h < hands.length; h++) {
        const hand = hands[h];
        let s = slotId.indexOf(hand.id);
        const fresh = s < 0;
        if (fresh) {
          s = slotId.indexOf(null);
          if (s < 0) continue;
          slotId[s] = hand.id;
        }
        slotSeen[s] = 1;
        const pointer = hand.kind === 'pointer';
        const g = hand.gestures;
        slotVx[s] = hand.velocity.x;
        slotVy[s] = hand.velocity.y;

        // Fingertips (or the pointer) shed discs: a slow trickle plus one per bit of travel.
        const tips = pointer ? 1 : NT;
        for (let k = 0; k < tips; k++) {
          const p = pointer ? hand.cursor : hand.landmarks[TIPS[k]];
          const j = s * NT + k;
          if (fresh) {
            tipX[j] = p.x;
            tipY[j] = p.y;
          }
          const dist = Math.hypot((p.x - tipX[j]) * aspect, p.y - tipY[j]);
          tipAcc[j] = emit(tipX[j], tipY[j], p.x, p.y, tipAcc[j] + dist / TIP_SPACING + dt * (pointer ? 8 : 3) * motion, 6, false,
            pointer ? Math.floor(Math.random() * 5) : k);
          tipX[j] = p.x;
          tipY[j] = p.y;
        }

        // Open palm moving slowly paints a dense line of small, crisp lights.
        const palm = pointer ? hand.cursor : hand.landmarks[9];
        if (fresh) {
          palmX[s] = palm.x;
          palmY[s] = palm.y;
        }
        const speed = Math.hypot(hand.velocity.x * aspect, hand.velocity.y);
        if (g.open && speed > SLOW_MIN && speed < SLOW_MAX) {
          const dist = Math.hypot((palm.x - palmX[s]) * aspect, palm.y - palmY[s]);
          palmAcc[s] = emit(palmX[s], palmY[s], palm.x, palm.y, palmAcc[s] + dist / TRAIL_SPACING, 24, true, 0);
        }
        palmX[s] = palm.x;
        palmY[s] = palm.y;

        // Pinch picks up the disc under the pinch point; it follows and racks into focus, release throws it.
        const pp = hand.pinchPoint;
        if (g.pinch && !slotPinch[s]) {
          const i = pick(pp.x, pp.y);
          if (i >= 0) {
            slotHeld[s] = i;
            heldBy[i] = s;
          }
        } else if (!g.pinch && slotPinch[s]) release(s);
        slotPinch[s] = g.pinch ? 1 : 0;
        const held = slotHeld[s];
        if (held >= 0) {
          const k = 1 - Math.exp(-dt * 25);
          px[held] += (pp.x - px[held]) * k;
          py[held] += (pp.y - py[held]) * k;
          lift[held] = 1;
        } else {
          // Anticipation: the disc under the fingers brightens and starts focusing as they close.
          const i = pick(pp.x, pp.y);
          if (i >= 0) lift[i] = Math.max(lift[i], 0.3 + 0.6 * hand.pinchStrength);
          if (g.pinch) {
            fx[nf] = pp.x;
            fy[nf] = pp.y;
            fs[nf++] = 1;
          }
        }
        if (g.pinch) pinching++;
        if (g.swipe) {
          sx[ns] = palm.x;
          sy[ns] = palm.y;
          svx[ns] = hand.velocity.x;
          svy[ns++] = hand.velocity.y;
        }
      }
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (!slotSeen[s] && slotId[s] !== null) {
          slotId[s] = null;
          release(s);
          tipAcc.fill(0, s * NT, s * NT + NT);
          palmAcc[s] = 0;
        }
      }

      const kf = 1 - Math.exp(-dt * 3);
      rack += ((pinching > 0 ? 1 : 0) - rack) * kf;
      // Idle: an invisible focus point wanders the field and slowly racks in and out.
      if (hands.length === 0) {
        fx[nf] = 0.5 + 0.35 * Math.sin(time * 0.13 * motion);
        fy[nf] = 0.5 + 0.3 * Math.sin(time * 0.17 * motion + 1);
        fs[nf++] = 0.55 * Math.max(0, Math.sin(time * 0.2 * motion));
      }

      const kv = 1 - Math.exp(-dt * 1.2);
      const kImp = Math.min(1, dt * 6);
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const amb = i < N_AMB;
        if (!amb && age[i] >= life[i]) {
          posArr[o + 2] = 0; // zero-size quad: no fragments
          colArr[o + 3] = 0;
          continue;
        }
        age[i] += dt;
        const lf = amb ? lift[i] : 0;
        if (!amb || heldBy[i] < 0) {
          vx[i] += (Math.sin(time * 0.4 + seed[i]) * 0.012 * motion - vx[i]) * kv;
          vy[i] += (-rise[i] * motion - vy[i]) * kv;
          for (let s = 0; s < ns; s++) {
            const dx = (px[i] - sx[s]) * aspect, dy = py[i] - sy[s];
            const d2 = dx * dx + dy * dy;
            if (d2 > SCATTER_R * SCATTER_R) continue;
            const d = Math.sqrt(d2) + 1e-4, fall = (1 - d / SCATTER_R) * kImp;
            const sp = Math.hypot(svx[s] * aspect, svy[s]) * 0.5;
            vx[i] += (svx[s] * 0.9 + (dx / d) * sp / aspect) * fall;
            vy[i] += (svy[s] * 0.9 + (dy / d) * sp) * fall;
          }
          px[i] += vx[i] * dt;
          py[i] += vy[i] * dt;
        }

        let ft = 0, alpha: number, r: number;
        if (amb) {
          if (heldBy[i] < 0) {
            if (py[i] < -0.15) { py[i] += 1.3; px[i] = Math.random(); }
            else if (py[i] > 1.15) py[i] -= 1.3;
            if (px[i] < -0.1) px[i] += 1.2;
            else if (px[i] > 1.1) px[i] -= 1.2;
          }
          alpha = 0.55 + twinkle * Math.sin(time * 0.6 + seed[i] * 3);
          alpha += (1 - alpha) * lf;
          ft = lf;
          r = size[i] * (1 + 0.6 * lf);
        } else {
          const t = age[i] / life[i];
          ft = sharp0[i] * (1 - t);
          alpha = Math.min(1, age[i] * 3) * (1 - t * t);
          r = size[i] * (0.6 + 0.8 * t);
        }
        for (let f = 0; f < nf; f++) {
          const dx = (px[i] - fx[f]) * aspect, dy = py[i] - fy[f];
          const d2 = dx * dx + dy * dy;
          if (d2 < FOCUS_R * FOCUS_R) {
            const w = 1 - Math.sqrt(d2) / FOCUS_R;
            ft = Math.max(ft, fs[f] * Math.min(1, w * 2));
          }
        }
        focus[i] += (ft - focus[i]) * (lf > 0 ? 1 - Math.exp(-dt * 10) : kf);
        const fc = focus[i];
        posArr[o] = px[i];
        posArr[o + 1] = py[i];
        posArr[o + 2] = r * ((1 + 0.3 * rack) * (1 - fc) + 0.18 * fc);
        posArr[o + 3] = fc;
        colArr[o + 3] = alpha;
      }
      posAttr.needsUpdate = colAttr.needsUpdate = true;

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      aspect = width / height;
      background.uniforms.aspect.value = aspect;
      discMat.uniforms.aspect.value = aspect;
    },
    dispose() {
      bgGeo.dispose();
      background.dispose();
      geo.dispose();
      discMat.dispose();
    },
  };
};
