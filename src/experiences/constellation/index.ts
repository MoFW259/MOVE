import * as THREE from 'three';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// Multi-hand constellation: fingertips are stars, nearby stars link up; links between different hands glow warm.
// Stars near the pinch point brighten as the fingers close; pinch catches them, release throws them.
const MAX_SLOTS = 8;
const TIPS = [4, 8, 12, 16, 20];
const N_AMB = 80;
const N_PTS = N_AMB + MAX_SLOTS * TIPS.length;
const MAX_SEG = (N_PTS * (N_PTS - 1)) / 2;

// Link radii (aspect-corrected, in screen heights) per pair class.
const R_AMB = 0.13;
const R_HAND = 0.2;
const R_SAME = 0.3;
const R_INTER = 0.45;
const ATTRACT_R = 0.35;
const GRAB_R = 0.14;
const SCATTER_R = 0.3;

export default (): Experience => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduce ? 0.4 : 1;

  let renderer: THREE.WebGLRenderer;
  let aspect = 1;
  let time = 0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050d);
  // Screen-space 0..1 with y down, so landmark coords plug in directly.
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);

  // Ambient stars.
  const ax = new Float32Array(N_AMB), ay = new Float32Array(N_AMB);
  const avx = new Float32Array(N_AMB), avy = new Float32Array(N_AMB);
  const adx = new Float32Array(N_AMB), ady = new Float32Array(N_AMB); // constant drift
  const aSizeBase = new Float32Array(N_AMB);
  const grabbedBy = new Int8Array(N_AMB).fill(-1);
  const gox = new Float32Array(N_AMB), goy = new Float32Array(N_AMB);
  const hl = new Float32Array(N_AMB); // per-frame pinch anticipation 0..1
  for (let i = 0; i < N_AMB; i++) {
    ax[i] = Math.random();
    ay[i] = Math.random();
    const a = Math.random() * Math.PI * 2, s = (0.004 + Math.random() * 0.008) * motion;
    adx[i] = Math.cos(a) * s;
    ady[i] = Math.sin(a) * s;
    aSizeBase[i] = 9 + Math.random() * 9;
  }

  // Hand slots keyed by hand.id; vanished ids fade out, then free the slot.
  const slotId: (string | null)[] = new Array(MAX_SLOTS).fill(null);
  const slotAlpha = new Float32Array(MAX_SLOTS);
  const slotSeen = new Uint8Array(MAX_SLOTS);
  const slotPressed = new Uint8Array(MAX_SLOTS);
  const slotN = new Uint8Array(MAX_SLOTS);
  const slotPx = new Float32Array(MAX_SLOTS * TIPS.length), slotPy = new Float32Array(MAX_SLOTS * TIPS.length);
  const slotVx = new Float32Array(MAX_SLOTS), slotVy = new Float32Array(MAX_SLOTS);
  const slotGx = new Float32Array(MAX_SLOTS), slotGy = new Float32Array(MAX_SLOTS); // grab point

  // Per-frame point list (ambient first, then hand tips compacted).
  const px = new Float32Array(N_PTS), py = new Float32Array(N_PTS), pf = new Float32Array(N_PTS);
  const owner = new Int8Array(N_PTS);

  // Stars.
  const starPos = new Float32Array(N_PTS * 3);
  const starCol = new Float32Array(N_PTS * 3);
  const starSize = new Float32Array(N_PTS);
  const starPhase = new Float32Array(N_PTS);
  for (let i = 0; i < N_PTS; i++) starPhase[i] = Math.random() * Math.PI * 2;
  const starGeo = new THREE.BufferGeometry();
  const starPosAttr = new THREE.BufferAttribute(starPos, 3).setUsage(THREE.DynamicDrawUsage);
  const starColAttr = new THREE.BufferAttribute(starCol, 3).setUsage(THREE.DynamicDrawUsage);
  const starSizeAttr = new THREE.BufferAttribute(starSize, 1).setUsage(THREE.DynamicDrawUsage);
  starGeo.setAttribute('position', starPosAttr);
  starGeo.setAttribute('aColor', starColAttr);
  starGeo.setAttribute('aSize', starSizeAttr);
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, scale: { value: 1 }, twinkle: { value: reduce ? 0.05 : 0.25 } },
    vertexShader: /* glsl */ `
      uniform float time, scale, twinkle;
      attribute vec3 aColor;
      attribute float aSize, aPhase;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        // Slow twinkle (< 0.5 Hz), never a flash.
        gl_PointSize = aSize * scale * (1.0 + twinkle * sin(time * (1.2 + fract(aPhase) * 1.5) + aPhase));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = (exp(-d * d * 28.0) + 0.3 * exp(-d * d * 6.0)) * (1.0 - smoothstep(0.75, 1.0, d));
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;

  // Lines.
  const linePos = new Float32Array(MAX_SEG * 6);
  const lineCol = new Float32Array(MAX_SEG * 6);
  const lineGeo = new THREE.BufferGeometry();
  const linePosAttr = new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage);
  const lineColAttr = new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute('position', linePosAttr);
  lineGeo.setAttribute('color', lineColAttr);
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines, stars);
  // Reused upload range so only the used part of the line buffers is sent each frame.
  const lineRange = { start: 0, count: 0 };

  const releaseSlot = (s: number) => {
    for (let i = 0; i < N_AMB; i++) {
      if (grabbedBy[i] !== s) continue;
      grabbedBy[i] = -1;
      // Throw with the hand's last velocity.
      avx[i] = Math.max(-2, Math.min(2, slotVx[s]));
      avy[i] = Math.max(-2, Math.min(2, slotVy[s]));
    }
    slotPressed[s] = 0;
  };

  return {
    id: 'constellation',
    title: meta.title,
    hint: { text: '별 가까이에서 손가락을 집어 잡고, 놓으며 던져 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      dt = Math.min(dt, 0.1);
      time += dt;
      slotSeen.fill(0);
      hl.fill(0);

      // 1. Hands -> slots, interactions with ambient stars.
      for (let h = 0; h < input.hands.length; h++) {
        const hand = input.hands[h];
        let s = slotId.indexOf(hand.id);
        if (s < 0) s = slotId.indexOf(null);
        if (s < 0) continue; // more than MAX_SLOTS hands: ignore extras
        if (slotId[s] !== hand.id) {
          slotId[s] = hand.id;
          slotAlpha[s] = 0;
          slotPressed[s] = 0;
        }
        slotSeen[s] = 1;
        slotVx[s] = hand.velocity.x;
        slotVy[s] = hand.velocity.y;
        const o = s * TIPS.length;
        let palmX: number, palmY: number;
        slotGx[s] = hand.pinchPoint.x;
        slotGy[s] = hand.pinchPoint.y;
        if (hand.kind === 'pointer') {
          slotN[s] = 1;
          palmX = slotPx[o] = hand.cursor.x;
          palmY = slotPy[o] = hand.cursor.y;
        } else {
          const lm = hand.landmarks;
          slotN[s] = TIPS.length;
          for (let t = 0; t < TIPS.length; t++) {
            slotPx[o + t] = lm[TIPS[t]].x;
            slotPy[o + t] = lm[TIPS[t]].y;
          }
          palmX = lm[9].x;
          palmY = lm[9].y;
        }

        const g = hand.gestures;
        const pressed = g.pinch || g.fist;
        if (!pressed && slotPressed[s]) releaseSlot(s);
        slotPressed[s] = pressed ? 1 : 0;

        const reach = 0.3 + 0.7 * hand.pinchStrength;
        for (let i = 0; i < N_AMB; i++) {
          if (grabbedBy[i] >= 0) continue;
          const gx = (ax[i] - slotGx[s]) * aspect, gy = ay[i] - slotGy[s];
          const g2 = gx * gx + gy * gy;
          if (pressed) {
            if (g2 < GRAB_R * GRAB_R) {
              grabbedBy[i] = s;
              gox[i] = (ax[i] - slotGx[s]) * 0.5;
              goy[i] = (ay[i] - slotGy[s]) * 0.5;
            }
            continue;
          }
          // Anticipation: stars inside the catch radius light up as the fingers close.
          if (g2 < GRAB_R * GRAB_R) hl[i] = Math.max(hl[i], reach * (1 - Math.sqrt(g2) / GRAB_R));
          const dx = (ax[i] - palmX) * aspect, dy = ay[i] - palmY;
          const d = Math.sqrt(dx * dx + dy * dy) + 1e-5;
          if (g.swipe) {
            if (d > SCATTER_R) continue;
            const f = (1 - d / SCATTER_R) * dt * 6 * motion;
            avx[i] += (slotVx[s] * 0.6 + (dx / d / aspect) * 0.5) * f;
            avy[i] += (slotVy[s] * 0.6 + (dy / d) * 0.5) * f;
          } else if (g.open) {
            if (d > ATTRACT_R) continue;
            // Pull in, soft-stop near the palm, slight swirl so they orbit instead of collapsing.
            const f = (1 - d / ATTRACT_R) * Math.min(1, d / 0.05) * dt * 0.6 * motion;
            avx[i] += ((-dx / d - (dy / d) * 0.4) / aspect) * f;
            avy[i] += (-dy / d + (dx / d) * 0.4) * f;
          }
        }
      }

      // 2. Fade slots in/out; vanished hands drop what they hold.
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (slotId[s] === null) continue;
        if (slotSeen[s]) {
          slotAlpha[s] = Math.min(1, slotAlpha[s] + dt * 4);
        } else {
          if (slotPressed[s]) releaseSlot(s);
          slotAlpha[s] -= dt * 2.5;
          if (slotAlpha[s] <= 0) {
            slotAlpha[s] = 0;
            slotId[s] = null;
          }
        }
      }

      // 3. Integrate ambient stars.
      const damp = Math.exp(-1.5 * dt);
      const follow = 1 - Math.exp(-12 * dt);
      for (let i = 0; i < N_AMB; i++) {
        const s = grabbedBy[i];
        if (s >= 0) {
          ax[i] += (slotGx[s] + gox[i] - ax[i]) * follow;
          ay[i] += (slotGy[s] + goy[i] - ay[i]) * follow;
          continue;
        }
        avx[i] *= damp;
        avy[i] *= damp;
        ax[i] += (adx[i] / aspect + avx[i]) * dt;
        ay[i] += (ady[i] + avy[i]) * dt;
        if (ax[i] < -0.05) ax[i] += 1.1;
        else if (ax[i] > 1.05) ax[i] -= 1.1;
        if (ay[i] < -0.05) ay[i] += 1.1;
        else if (ay[i] > 1.05) ay[i] -= 1.1;
      }

      // 4. Point list + star buffers.
      let n = 0;
      for (let i = 0; i < N_AMB; i++, n++) {
        const grabbed = grabbedBy[i] >= 0;
        const h = grabbed ? 1 : hl[i];
        px[n] = ax[i];
        py[n] = ay[i];
        pf[n] = 1;
        owner[n] = -1;
        starSize[n] = aSizeBase[i] * (1 + (grabbed ? 0.4 : 0.9 * h));
        starCol[n * 3] = 0.7 + 0.3 * h;
        starCol[n * 3 + 1] = 0.78 + 0.07 * h;
        starCol[n * 3 + 2] = 1.0 - 0.4 * h;
      }
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (slotId[s] === null) continue;
        const a = slotAlpha[s];
        const warm = slotPressed[s] ? 1 : 0;
        for (let t = 0; t < slotN[s]; t++, n++) {
          px[n] = slotPx[s * TIPS.length + t];
          py[n] = slotPy[s * TIPS.length + t];
          pf[n] = a;
          owner[n] = s;
          starSize[n] = 34 * (0.5 + 0.5 * a);
          starCol[n * 3] = a;
          starCol[n * 3 + 1] = a * (0.95 - 0.1 * warm);
          starCol[n * 3 + 2] = a * (1.0 - 0.3 * warm);
        }
      }
      for (let i = 0; i < n; i++) {
        starPos[i * 3] = px[i];
        starPos[i * 3 + 1] = py[i];
      }
      starGeo.setDrawRange(0, n);
      starPosAttr.needsUpdate = starColAttr.needsUpdate = starSizeAttr.needsUpdate = true;

      // 5. Lines between every pair within its class radius.
      let seg = 0;
      const shimmer = reduce ? 0 : 0.2;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = (px[i] - px[j]) * aspect, dy = py[i] - py[j];
          const d2 = dx * dx + dy * dy;
          const oi = owner[i], oj = owner[j];
          let r: number, cr: number, cg: number, cb: number, k: number;
          if (oi < 0 && oj < 0) { r = R_AMB; cr = 0.45; cg = 0.55; cb = 0.9; k = 0.35; }
          else if (oi < 0 || oj < 0) { r = R_HAND; cr = 0.5; cg = 0.8; cb = 1.0; k = 0.7; }
          else if (oi === oj) { r = R_SAME; cr = 0.6; cg = 0.85; cb = 1.0; k = 0.6; }
          else { r = R_INTER; cr = 1.0; cg = 0.6; cb = 0.3; k = 1.0 + shimmer * Math.sin(time * 2 + i + j); }
          if (d2 >= r * r) continue;
          const t = 1 - Math.sqrt(d2) / r;
          const a = t * t * k * pf[i] * pf[j];
          const o = seg * 6;
          linePos[o] = px[i]; linePos[o + 1] = py[i]; linePos[o + 2] = 0;
          linePos[o + 3] = px[j]; linePos[o + 4] = py[j]; linePos[o + 5] = 0;
          lineCol[o] = lineCol[o + 3] = cr * a;
          lineCol[o + 1] = lineCol[o + 4] = cg * a;
          lineCol[o + 2] = lineCol[o + 5] = cb * a;
          seg++;
        }
      }
      lineGeo.setDrawRange(0, seg * 2);
      if (seg > 0) {
        lineRange.count = seg * 6;
        // three clears updateRanges after upload; reusing one object keeps frame() allocation-free.
        linePosAttr.updateRanges.push(lineRange);
        lineColAttr.updateRanges.push(lineRange);
        linePosAttr.needsUpdate = lineColAttr.needsUpdate = true;
      }

      starMat.uniforms.time.value = time;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      aspect = width / height;
      starMat.uniforms.scale.value = height / 900;
    },
    dispose() {
      starGeo.dispose();
      starMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
    },
  };
};
