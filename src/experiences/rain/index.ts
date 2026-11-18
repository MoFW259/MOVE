import * as THREE from 'three';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// Rain falls on the body: hand bones and pointer umbrellas split drops into droplets that bounce and slide off.
// A pinch catches rain into a bead held between the fingers that grows as more drops hit it; release flings it
// and it splashes where it lands. An open upright palm catches a pool, a fist throws it up, a swipe sprays the rain.
// Mouse/touch: hover holds an umbrella, press pinches a bead.
// World space: x in 0..aspect, y in 0..1 (screen heights, y down), so landmark (x, y) -> (x * aspect, y).
const MAX_SLOTS = 8;
const N_RAIN = 3000;
const N_DROP = 4000;
const ARC_SEG = 20;
const UMB_SEG = ARC_SEG + 2; // canopy arc + shaft + hook
const N_SEG = N_RAIN + N_DROP + MAX_SLOTS * UMB_SEG;
// prettier-ignore
const BONES = [0, 1, 1, 2, 2, 3, 3, 4, 0, 5, 5, 6, 6, 7, 7, 8, 9, 10, 10, 11, 11, 12, 13, 14, 14, 15, 15, 16,
  0, 17, 17, 18, 18, 19, 19, 20, 5, 9, 9, 13, 13, 17];
const NB = BONES.length / 2;
const COLLIDE_DEPTH = 0.35; // farther drops pass behind the hands (parallax)
const POOL_CAP = 160; // drops a full palm holds
const GRAVITY = 2.2;
const MARGIN = 0.07; // bbox slack for one frame of drop travel
const SWIPE_R = 0.25;
const HOLD_CAP = 60; // drops a full pinched bead holds
const N_FLY = 16; // flung beads in flight
const beadR = (fill: number) => 0.01 + 0.03 * Math.sqrt(fill);

export default (): Experience => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const speedMul = reduce ? 0.55 : 1;
  const gustAmp = reduce ? 0.3 : 1;
  const splashMul = reduce ? 0.5 : 1;

  let renderer: THREE.WebGLRenderer;
  let aspect = 1;
  let time = 0;
  let wind = 0.08, windTarget = 0.08, nextGust = 4, gustOn = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(meta.bg);
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);

  // Rain.
  const rx = new Float32Array(N_RAIN), ry = new Float32Array(N_RAIN);
  const rvx = new Float32Array(N_RAIN), rvy = new Float32Array(N_RAIN);
  const rd = new Float32Array(N_RAIN); // depth 0 (far) .. 1 (near)
  const fallSpeed = (d: number) => (0.9 + d * 1.1) * speedMul;
  const respawn = (i: number) => {
    ry[i] = -0.05 - Math.random() * 0.2;
    rx[i] = -0.3 + Math.random() * (aspect + 0.6) - wind * 0.4;
    rvx[i] = wind;
    rvy[i] = fallSpeed(rd[i]) * (0.85 + Math.random() * 0.15);
  };
  for (let i = 0; i < N_RAIN; i++) {
    rd[i] = Math.random();
    respawn(i);
    ry[i] = Math.random() * 1.2 - 0.1;
  }

  // Splash droplets: ring buffer, oldest overwritten when full.
  const dx = new Float32Array(N_DROP), dy = new Float32Array(N_DROP);
  const dvx = new Float32Array(N_DROP), dvy = new Float32Array(N_DROP);
  const dLife = new Float32Array(N_DROP), dTotal = new Float32Array(N_DROP);
  let dHead = 0;
  const spawn = (x: number, y: number, vx: number, vy: number, life: number) => {
    const j = dHead;
    dHead = (dHead + 1) % N_DROP;
    dx[j] = x;
    dy[j] = y;
    dvx[j] = vx;
    dvy[j] = vy;
    dLife[j] = dTotal[j] = life;
  };

  // Hand slots keyed by hand.id. kind: 0 free, 1 tracked (bone capsules), 2 pointer (umbrella).
  const slotId: (string | null)[] = new Array(MAX_SLOTS).fill(null);
  const slotSeen = new Uint8Array(MAX_SLOTS);
  const kind = new Uint8Array(MAX_SLOTS);
  const bone = new Float32Array(MAX_SLOTS * NB * 4);
  const boneR = new Float32Array(MAX_SLOTS);
  const bbx0 = new Float32Array(MAX_SLOTS), bby0 = new Float32Array(MAX_SLOTS);
  const bbx1 = new Float32Array(MAX_SLOTS), bby1 = new Float32Array(MAX_SLOTS);
  const hvx = new Float32Array(MAX_SLOTS), hvy = new Float32Array(MAX_SLOTS);
  const hx = new Float32Array(MAX_SLOTS), hy = new Float32Array(MAX_SLOTS); // swipe origin
  const swiping = new Uint8Array(MAX_SLOTS);
  const sprayAcc = new Float32Array(MAX_SLOTS);
  // Tracked: palm pool.
  const pcx = new Float32Array(MAX_SLOTS), pcy = new Float32Array(MAX_SLOTS), palmR = new Float32Array(MAX_SLOTS);
  const catching = new Uint8Array(MAX_SLOTS);
  const pool = new Float32Array(MAX_SLOTS);
  const wasFist = new Uint8Array(MAX_SLOTS);
  const leakAcc = new Float32Array(MAX_SLOTS);
  const glowA = new Float32Array(MAX_SLOTS);
  // Pointer: umbrella.
  const ux = new Float32Array(MAX_SLOTS), uy = new Float32Array(MAX_SLOTS), uR = new Float32Array(MAX_SLOTS);
  const ugx = new Float32Array(MAX_SLOTS), ugy = new Float32Array(MAX_SLOTS); // grip (cursor)
  // Pinch: held bead (world pos, smoothed velocity, fill 0..1) and the pinch point / strength for the anticipation ring.
  const holding = new Uint8Array(MAX_SLOTS);
  const hdx = new Float32Array(MAX_SLOTS), hdy = new Float32Array(MAX_SLOTS), hdS = new Float32Array(MAX_SLOTS);
  const hdvx = new Float32Array(MAX_SLOTS), hdvy = new Float32Array(MAX_SLOTS);
  const pqx = new Float32Array(MAX_SLOTS), pqy = new Float32Array(MAX_SLOTS), pStr = new Float32Array(MAX_SLOTS);
  // Flung beads: ring buffer.
  const fx = new Float32Array(N_FLY), fy = new Float32Array(N_FLY), fvx = new Float32Array(N_FLY), fvy = new Float32Array(N_FLY);
  const fS = new Float32Array(N_FLY), fAge = new Float32Array(N_FLY), fOn = new Uint8Array(N_FLY);
  let fHead = 0;

  const splash = (x: number, y: number, nx: number, ny: number, s: number) => {
    const n = Math.max(1, Math.round((2 + Math.random() * 3) * splashMul));
    for (let k = 0; k < n; k++) {
      const a = 0.25 + Math.random() * 0.45, b = (Math.random() - 0.5) * 0.9;
      spawn(x, y, nx * a - ny * b + hvx[s] * 0.4, ny * a + nx * b + hvy[s] * 0.4, 0.35 + Math.random() * 0.4);
    }
  };
  const burst = (s: number, up: boolean) => {
    const n = Math.min(POOL_CAP, Math.round(pool[s] * POOL_CAP * splashMul));
    for (let k = 0; k < n; k++) {
      const ang = (up ? -Math.PI / 2 : Math.PI / 2) + (Math.random() - 0.5) * 2.2;
      const sp = up ? (0.5 + Math.random() * 0.9) * speedMul : 0.1 + Math.random() * 0.2;
      spawn(
        pcx[s] + (Math.random() - 0.5) * palmR[s],
        pcy[s] + (Math.random() - 0.5) * palmR[s],
        Math.cos(ang) * sp + hvx[s] * 0.5,
        Math.sin(ang) * sp + hvy[s] * 0.5,
        0.8 + Math.random() * 0.6,
      );
    }
    pool[s] = 0;
  };

  // Collision of a path p0 -> p1 with every collider; result in cHit* (allocation-free).
  let cHitX = 0, cHitY = 0, cHitNx = 0, cHitNy = 0;
  const collide = (x0: number, y0: number, x1: number, y1: number): number => {
    for (let s = 0; s < MAX_SLOTS; s++) {
      const k = kind[s];
      if (k === 0 || x1 < bbx0[s] || x1 > bbx1[s] || y1 < bby0[s] || y1 > bby1[s]) continue;
      if (k === 2) {
        // Umbrella: upper half-circle shell; drops already under the canopy stay sheltered.
        const R = uR[s], ex = x1 - ux[s], ey = y1 - uy[s];
        const d2 = ex * ex + ey * ey;
        if (d2 >= R * R || ey > 0) continue;
        const fx = x0 - ux[s], fy = y0 - uy[s];
        if (fx * fx + fy * fy < R * R * 0.8) continue;
        const d = Math.sqrt(d2) + 1e-6;
        cHitNx = ex / d;
        cHitNy = ey / d;
        cHitX = ux[s] + cHitNx * R;
        cHitY = uy[s] + cHitNy * R;
        return s;
      }
      const r = boneR[s];
      for (let b = 0, o = s * NB * 4; b < NB; b++, o += 4) {
        const ax = bone[o], ay = bone[o + 1], sx = bone[o + 2] - ax, sy = bone[o + 3] - ay;
        const ll = sx * sx + sy * sy + 1e-9;
        let t = ((x1 - ax) * sx + (y1 - ay) * sy) / ll;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        let cx = ax + sx * t, cy = ay + sy * t;
        let nx = x1 - cx, ny = y1 - cy;
        let d2 = nx * nx + ny * ny;
        if (d2 >= r * r) {
          // Swept test: fast drops can step over a thin bone in one frame.
          const px = x1 - x0, py = y1 - y0;
          const den = px * sy - py * sx;
          if (den > -1e-9 && den < 1e-9) continue;
          const qx = ax - x0, qy = ay - y0;
          const u = (qx * sy - qy * sx) / den, v = (qx * py - qy * px) / den;
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;
          cx = ax + sx * v;
          cy = ay + sy * v;
          d2 = 0;
        }
        if (d2 < 1e-10) {
          // On the bone axis: normal perpendicular to the bone, toward where the drop came from.
          nx = -sy;
          ny = sx;
          if (nx * (x0 - cx) + ny * (y0 - cy) < 0) (nx = -nx), (ny = -ny);
          d2 = ll;
        }
        const d = Math.sqrt(d2);
        cHitNx = nx / d;
        cHitNy = ny / d;
        cHitX = cx + cHitNx * r;
        cHitY = cy + cHitNy * r;
        return s;
      }
    }
    return -1;
  };

  // Lines: rain streaks, droplets, umbrellas. RGBA vertex colors (three enables vertex alpha for itemSize 4).
  const linePos = new Float32Array(N_SEG * 2 * 3);
  const lineCol = new Float32Array(N_SEG * 2 * 4);
  const lineGeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(lineCol, 4).setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute('position', posAttr);
  lineGeo.setAttribute('color', colAttr);
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  // Reused upload ranges: only the used part of the buffers is sent each frame.
  const posRange = { start: 0, count: 0 }, colRange = { start: 0, count: 0 };
  let nv = 0;
  const vert = (x: number, y: number, a: number) => {
    linePos[nv * 3] = x;
    linePos[nv * 3 + 1] = y;
    const c = nv * 4;
    lineCol[c] = 0.88;
    lineCol[c + 1] = 0.93;
    lineCol[c + 2] = 1;
    lineCol[c + 3] = a;
    nv++;
  };

  // Soft water discs: palm pools (mode 0), pinched beads / anticipation rings (mode 1 / 2), flung beads (mode 1).
  const N_GLOW = MAX_SLOTS * 2 + N_FLY;
  const glowPos = new Float32Array(N_GLOW * 3);
  const glowSize = new Float32Array(N_GLOW);
  const glowAlpha = new Float32Array(N_GLOW);
  const glowFill = new Float32Array(N_GLOW);
  const glowMode = new Float32Array(N_GLOW);
  const glowGeo = new THREE.BufferGeometry();
  const gPosAttr = new THREE.BufferAttribute(glowPos, 3).setUsage(THREE.DynamicDrawUsage);
  const gSizeAttr = new THREE.BufferAttribute(glowSize, 1).setUsage(THREE.DynamicDrawUsage);
  const gAlphaAttr = new THREE.BufferAttribute(glowAlpha, 1).setUsage(THREE.DynamicDrawUsage);
  const gFillAttr = new THREE.BufferAttribute(glowFill, 1).setUsage(THREE.DynamicDrawUsage);
  const gModeAttr = new THREE.BufferAttribute(glowMode, 1).setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('position', gPosAttr);
  glowGeo.setAttribute('aSize', gSizeAttr);
  glowGeo.setAttribute('aAlpha', gAlphaAttr);
  glowGeo.setAttribute('aFill', gFillAttr);
  glowGeo.setAttribute('aMode', gModeAttr);
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, scale: { value: 1 }, wave: { value: reduce ? 0.3 : 1 } },
    vertexShader: /* glsl */ `
      uniform float scale;
      attribute float aSize, aAlpha, aFill, aMode;
      varying float vAlpha, vFill, vMode;
      void main() {
        vAlpha = aAlpha;
        vFill = aFill;
        vMode = aMode;
        gl_PointSize = aSize * scale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float time, wave;
      varying float vAlpha, vFill, vMode;
      void main() {
        vec2 pc = gl_PointCoord - 0.5;
        float d = length(pc) * 2.0;
        if (vMode > 1.5) {
          // Anticipation ring: tightens toward the pinch point as the fingers close (vFill = closure).
          float ring = smoothstep(0.07, 0.0, abs(d - mix(0.95, 0.4, vFill)));
          gl_FragColor = vec4(0.85, 0.94, 1.0, ring * vAlpha);
          return;
        }
        if (vMode > 0.5) {
          // Glassy bead: faint body, brighter rim, highlight from the upper left.
          float body = smoothstep(0.92, 0.84, d);
          float rim = smoothstep(0.5, 0.88, d) * body;
          float hl = smoothstep(0.24, 0.0, length(pc - vec2(-0.17, -0.19)));
          gl_FragColor = vec4(0.85, 0.94, 1.0, (body * 0.3 + rim * 0.5 + hl * 0.9) * vAlpha);
          return;
        }
        float r = 0.3 + 0.6 * sqrt(vFill);
        // Slow inward ripples (< 0.5 Hz), never a flash.
        float water = smoothstep(r, r - 0.25, d) * (0.55 + 0.2 * wave * sin(d * 14.0 - time * 2.5)) * min(vFill * 4.0, 1.0);
        float rim = smoothstep(0.06, 0.0, abs(d - 0.9)) * 0.35;
        gl_FragColor = vec4(0.85, 0.94, 1.0, (water + rim) * vAlpha);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const glow = new THREE.Points(glowGeo, glowMat);
  glow.frustumCulled = false;
  scene.add(lines, glow);

  // Pinch start seeds a bead at the pinch point; while held it follows with a smoothed velocity for the throw.
  const grip = (s: number, pinch: boolean, qx: number, qy: number, dt: number) => {
    pqx[s] = qx;
    pqy[s] = qy;
    if (pinch && !holding[s]) {
      holding[s] = 1;
      hdx[s] = qx;
      hdy[s] = qy;
      hdvx[s] = hdvy[s] = 0;
      hdS[s] = 1.5 / HOLD_CAP;
    }
    if (!pinch && holding[s]) fling(s);
    if (!holding[s]) return;
    const k = 1 - Math.exp(-dt * 30), sv = Math.min(1, dt * 12), idt = 1 / Math.max(dt, 1e-3);
    const nx = hdx[s] + (qx - hdx[s]) * k, ny = hdy[s] + (qy - hdy[s]) * k;
    hdvx[s] += ((nx - hdx[s]) * idt - hdvx[s]) * sv;
    hdvy[s] += ((ny - hdy[s]) * idt - hdvy[s]) * sv;
    const vl = Math.sqrt(hdvx[s] * hdvx[s] + hdvy[s] * hdvy[s]);
    if (vl > 4) (hdvx[s] *= 4 / vl), (hdvy[s] *= 4 / vl);
    hdx[s] = nx;
    hdy[s] = ny;
  };
  const fling = (s: number) => {
    holding[s] = 0;
    const f = fHead;
    fHead = (fHead + 1) % N_FLY;
    fx[f] = hdx[s];
    fy[f] = hdy[s];
    fvx[f] = hdvx[s];
    fvy[f] = hdvy[s];
    fS[f] = hdS[s];
    fAge[f] = 0;
    fOn[f] = 1;
  };
  // A landing bead bursts into droplets thrown off the surface normal; bigger and faster beads splash harder.
  const impact = (f: number, x: number, y: number, nx: number, ny: number) => {
    fOn[f] = 0;
    const S = fS[f], hit = Math.min(Math.sqrt(fvx[f] * fvx[f] + fvy[f] * fvy[f]) / 2, 1);
    const n = Math.max(3, Math.round((6 + 50 * S) * splashMul));
    for (let k = 0; k < n; k++) {
      const a = (Math.random() - 0.5) * 2.4, c = Math.cos(a), sn = Math.sin(a);
      const sp = (0.25 + Math.random() * 0.55) * (0.6 + 0.6 * hit) * (0.7 + 0.6 * S) * speedMul;
      spawn(x, y, (nx * c - ny * sn) * sp + fvx[f] * 0.15, (ny * c + nx * sn) * sp, 0.5 + Math.random() * 0.5);
    }
  };

  return {
    id: 'rain',
    title: meta.title,
    hint: { text: '손가락으로 빗방울을 집어 키운 뒤 던져 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      dt = Math.min(dt, 0.05);
      time += dt;

      // 1. Wind: calm drizzle with occasional gusts.
      if (time > nextGust) {
        gustOn = !gustOn;
        windTarget = gustOn ? (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.5) * gustAmp : (Math.random() - 0.5) * 0.2;
        nextGust = time + (gustOn ? 1.5 + Math.random() * 2 : 4 + Math.random() * 6);
      }
      wind += (windTarget - wind) * Math.min(1, dt * 0.9);
      const windNow = wind + Math.sin(time * 1.3) * 0.03 * gustAmp;

      // 2. Hands -> slots.
      slotSeen.fill(0);
      let anyHand = false;
      for (let h = 0; h < input.hands.length; h++) {
        const hand = input.hands[h];
        let s = slotId.indexOf(hand.id);
        if (s < 0) s = slotId.indexOf(null);
        if (s < 0) continue; // more than MAX_SLOTS hands: ignore extras
        if (slotId[s] !== hand.id) {
          slotId[s] = hand.id;
          pool[s] = glowA[s] = sprayAcc[s] = leakAcc[s] = 0;
          wasFist[s] = 0;
          uR[s] = 0.04;
          holding[s] = 0;
        }
        slotSeen[s] = 1;
        anyHand = true;
        const g = hand.gestures;
        let vx = hand.velocity.x * aspect, vy = hand.velocity.y;
        const vl = Math.sqrt(vx * vx + vy * vy);
        if (vl > 3) (vx *= 3 / vl), (vy *= 3 / vl);
        hvx[s] = vx;
        hvy[s] = vy;
        swiping[s] = g.swipe ? 1 : 0;

        if (hand.kind === 'pointer') {
          // Pressed = pinch: the umbrella folds away and the cursor holds a bead instead.
          pStr[s] = 0;
          grip(s, g.pinch, hand.cursor.x * aspect, hand.cursor.y, dt);
          catching[s] = 0;
          if (g.pinch) {
            kind[s] = 0;
            uR[s] = 0.03;
            continue;
          }
          kind[s] = 2;
          const R = (uR[s] += (0.075 - uR[s]) * Math.min(1, dt * 10));
          ugx[s] = hand.cursor.x * aspect;
          ugy[s] = hand.cursor.y;
          ux[s] = hx[s] = ugx[s];
          uy[s] = ugy[s] - 0.07;
          hy[s] = ugy[s];
          bbx0[s] = ux[s] - R - MARGIN;
          bbx1[s] = ux[s] + R + MARGIN;
          bby0[s] = uy[s] - R - MARGIN;
          bby1[s] = uy[s] + MARGIN;
          continue;
        }

        // A fist can read as a pinch too; fists keep throwing the palm pool.
        pStr[s] = hand.pinchStrength;
        grip(s, g.pinch && !g.fist, hand.pinchPoint.x * aspect, hand.pinchPoint.y, dt);

        kind[s] = 1;
        const lm = hand.landmarks;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let b = 0, o = s * NB * 4; b < NB; b++, o += 4) {
          const p = lm[BONES[b * 2]], q = lm[BONES[b * 2 + 1]];
          bone[o] = p.x * aspect;
          bone[o + 1] = p.y;
          bone[o + 2] = q.x * aspect;
          bone[o + 3] = q.y;
        }
        for (let i = 0; i < 21; i++) {
          const x = lm[i].x * aspect, y = lm[i].y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        const lx = (lm[9].x - lm[0].x) * aspect, ly = lm[9].y - lm[0].y;
        const palmLen = Math.sqrt(lx * lx + ly * ly);
        const r = (boneR[s] = Math.min(0.025, Math.max(0.006, palmLen * 0.12)));
        bbx0[s] = x0 - r - MARGIN;
        bbx1[s] = x1 + r + MARGIN;
        bby0[s] = y0 - r - MARGIN;
        bby1[s] = y1 + r + MARGIN;
        pcx[s] = ((lm[0].x + lm[5].x + lm[9].x + lm[17].x) / 4) * aspect;
        pcy[s] = (lm[0].y + lm[5].y + lm[9].y + lm[17].y) / 4;
        palmR[s] = palmLen * 0.6;
        hx[s] = pcx[s];
        hy[s] = pcy[s];
        // Open, upright palm (fingers above wrist) holds water.
        catching[s] = g.open && !g.swipe && lm[9].y < lm[0].y ? 1 : 0;
        if (g.fist && !wasFist[s] && pool[s] > 0.03) burst(s, true);
        wasFist[s] = g.fist ? 1 : 0;
        if (!catching[s] && !g.fist && pool[s] > 0) {
          // Tilted or relaxed hand: water drips out of the palm.
          leakAcc[s] += dt * 25;
          while (leakAcc[s] >= 1 && pool[s] > 0) {
            leakAcc[s] -= 1;
            pool[s] = Math.max(0, pool[s] - 1 / POOL_CAP);
            spawn(pcx[s] + (Math.random() - 0.5) * palmR[s], pcy[s] + palmR[s] * 0.5, hvx[s] * 0.3, 0.2, 0.9);
          }
        }
      }
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (slotSeen[s] || slotId[s] === null) continue;
        if (pool[s] > 0) burst(s, false); // hand left: its water spills
        if (holding[s]) fling(s); // a lifted touch lets go of its bead
        slotId[s] = null;
        kind[s] = 0;
      }

      // 3. Swipes: spray from the hand along its motion.
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (!kind[s] || !swiping[s]) {
          sprayAcc[s] = 0;
          continue;
        }
        sprayAcc[s] += dt * 140 * splashMul;
        while (sprayAcc[s] >= 1) {
          sprayAcc[s] -= 1;
          spawn(
            hx[s] + (Math.random() - 0.5) * 0.06,
            hy[s] + (Math.random() - 0.5) * 0.06,
            hvx[s] * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.3,
            hvy[s] * 0.4 - Math.random() * 0.3,
            0.4 + Math.random() * 0.4,
          );
        }
      }

      // 4. Rain.
      for (let i = 0; i < N_RAIN; i++) {
        const depth = rd[i];
        rvx[i] += (windNow * (0.5 + 0.5 * depth) - rvx[i]) * Math.min(1, dt * 1.5);
        rvy[i] += (fallSpeed(depth) - rvy[i]) * Math.min(1, dt * 2);
        const x0 = rx[i], y0 = ry[i];
        if (anyHand && depth > COLLIDE_DEPTH) {
          for (let s = 0; s < MAX_SLOTS; s++) {
            if (!swiping[s] || !kind[s]) continue;
            const ex = x0 - hx[s], ey = y0 - hy[s];
            const d2 = ex * ex + ey * ey;
            if (d2 > SWIPE_R * SWIPE_R) continue;
            const f = (1 - Math.sqrt(d2) / SWIPE_R) * dt;
            rvx[i] += hvx[s] * f * 8;
            rvy[i] += hvy[s] * f * 3;
          }
        }
        const x1 = x0 + rvx[i] * dt, y1 = y0 + rvy[i] * dt;
        if (anyHand && depth > COLLIDE_DEPTH) {
          let caught = false;
          for (let s = 0; s < MAX_SLOTS; s++) {
            if (holding[s] && hdS[s] < 1) {
              const ex = x1 - hdx[s], ey = y1 - hdy[s], R = beadR(hdS[s]) + 0.008;
              if (ex * ex + ey * ey < R * R) {
                hdS[s] = Math.min(1, hdS[s] + 1 / HOLD_CAP);
                caught = true;
                break;
              }
            }
            if (!catching[s] || pool[s] >= 1) continue;
            const ex = x1 - pcx[s], ey = y1 - pcy[s];
            if (ex * ex + ey * ey < palmR[s] * palmR[s]) {
              pool[s] = Math.min(1, pool[s] + 1 / POOL_CAP);
              caught = true;
              break;
            }
          }
          if (caught) {
            respawn(i);
            continue;
          }
          const s = collide(x0, y0, x1, y1);
          if (s >= 0) {
            splash(cHitX, cHitY, cHitNx, cHitNy, s);
            respawn(i);
            continue;
          }
        }
        rx[i] = x1;
        ry[i] = y1;
        if (y1 > 1) {
          if (depth > 0.6 && Math.random() < 0.12 * splashMul) {
            for (let k = 0; k < 2; k++) {
              spawn(x1, 1, (Math.random() - 0.5) * 0.5 + rvx[i] * 0.2, -0.2 - Math.random() * 0.4, 0.25 + Math.random() * 0.2);
            }
          }
          respawn(i);
        } else if (x1 < -0.35 || x1 > aspect + 0.35) respawn(i);
      }

      // 5. Droplets: gravity, bounce and slide along colliders.
      for (let j = 0; j < N_DROP; j++) {
        if (dLife[j] <= 0) continue;
        dLife[j] -= dt;
        dvy[j] += GRAVITY * speedMul * dt;
        dvx[j] += (windNow * 0.5 - dvx[j]) * dt * 0.4;
        const x0 = dx[j], y0 = dy[j];
        let x1 = x0 + dvx[j] * dt, y1 = y0 + dvy[j] * dt;
        if (anyHand) {
          const s = collide(x0, y0, x1, y1);
          if (s >= 0) {
            const vn = dvx[j] * cHitNx + dvy[j] * cHitNy;
            if (vn < 0) {
              // Restitution 0.35 on the normal, slight friction on the tangent.
              dvx[j] = (dvx[j] - 1.35 * vn * cHitNx) * 0.97;
              dvy[j] = (dvy[j] - 1.35 * vn * cHitNy) * 0.97;
            }
            x1 = cHitX;
            y1 = cHitY;
          }
        }
        dx[j] = x1;
        dy[j] = y1;
        if (y1 > 1.03) dLife[j] = 0;
      }

      // 5b. Flung beads: ballistic, ignoring hands for a moment so they leave the throwing fingers, then splash.
      for (let f = 0; f < N_FLY; f++) {
        if (!fOn[f]) continue;
        fAge[f] += dt;
        fvy[f] += GRAVITY * speedMul * dt;
        const x0 = fx[f], y0 = fy[f];
        const x1 = x0 + fvx[f] * dt, y1 = y0 + fvy[f] * dt;
        const s = anyHand && fAge[f] > 0.15 ? collide(x0, y0, x1, y1) : -1;
        if (s >= 0) impact(f, cHitX, cHitY, cHitNx, cHitNy);
        else if (y1 > 1) impact(f, x1, 1, 0, -1);
        else if (x1 < -0.3 || x1 > aspect + 0.3 || fAge[f] > 6) fOn[f] = 0;
        else (fx[f] = x1), (fy[f] = y1);
      }

      // 6. Geometry.
      nv = 0;
      for (let i = 0; i < N_RAIN; i++) {
        const k = 0.016 + 0.014 * rd[i];
        vert(rx[i] - rvx[i] * k, ry[i] - rvy[i] * k, 0);
        vert(rx[i], ry[i], 0.18 + 0.55 * rd[i]);
      }
      for (let j = 0; j < N_DROP; j++) {
        if (dLife[j] <= 0) continue;
        const a = Math.min(1, (dLife[j] / dTotal[j]) * 2) * 0.9;
        vert(dx[j] - dvx[j] * 0.02, dy[j] - dvy[j] * 0.02 - 0.004, a * 0.15);
        vert(dx[j], dy[j], a);
      }
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (kind[s] !== 2) continue;
        const R = uR[s], cx = ux[s], cy = uy[s];
        for (let k = 0; k < ARC_SEG; k++) {
          const a0 = Math.PI * (1 + k / ARC_SEG), a1 = Math.PI * (1 + (k + 1) / ARC_SEG);
          vert(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R, 0.9);
          vert(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, 0.9);
        }
        vert(cx, cy - R, 0.9);
        vert(cx, ugy[s] + 0.012, 0.9);
        vert(cx, ugy[s] + 0.012, 0.9);
        vert(cx - 0.012, ugy[s] + 0.022, 0.9);
      }
      lineGeo.setDrawRange(0, nv);
      posRange.count = nv * 3;
      colRange.count = nv * 4;
      // three clears updateRanges after upload; reusing the objects keeps frame() allocation-free.
      posAttr.updateRanges.push(posRange);
      colAttr.updateRanges.push(colRange);
      posAttr.needsUpdate = colAttr.needsUpdate = true;

      for (let s = 0; s < MAX_SLOTS; s++) {
        const target = kind[s] === 1 ? (catching[s] ? 0.6 : 0) + pool[s] : 0;
        glowA[s] += (Math.min(1, target) - glowA[s]) * Math.min(1, dt * 4);
        glowPos[s * 3] = pcx[s];
        glowPos[s * 3 + 1] = pcy[s];
        glowSize[s] = palmR[s] * 2.6;
        glowAlpha[s] = glowA[s];
        glowFill[s] = pool[s];
        glowMode[s] = 0;
        // Pinch slot: the held bead (with a slight living wobble), or the anticipation ring while fingers close.
        const p = MAX_SLOTS + s;
        const live = slotId[s] !== null;
        const closing = Math.min(Math.max((pStr[s] - 0.35) / 0.55, 0), 1); // ignore the relaxed hand's resting closure
        glowPos[p * 3] = holding[s] ? hdx[s] : pqx[s];
        glowPos[p * 3 + 1] = holding[s] ? hdy[s] : pqy[s];
        glowMode[p] = holding[s] ? 1 : 2;
        glowSize[p] = holding[s] ? beadR(hdS[s]) * 2.2 * (1 + (reduce ? 0 : 0.05 * Math.sin(time * 7 + s))) : 0.12;
        glowAlpha[p] = !live ? 0 : holding[s] ? 1 : closing * 0.7;
        glowFill[p] = closing;
      }
      for (let f = 0; f < N_FLY; f++) {
        const p = MAX_SLOTS * 2 + f;
        glowPos[p * 3] = fx[f];
        glowPos[p * 3 + 1] = fy[f];
        glowMode[p] = 1;
        glowSize[p] = beadR(fS[f]) * 2.2;
        glowAlpha[p] = fOn[f];
        glowFill[p] = 0;
      }
      gPosAttr.needsUpdate = gSizeAttr.needsUpdate = gAlphaAttr.needsUpdate = gFillAttr.needsUpdate = gModeAttr.needsUpdate = true;
      glowMat.uniforms.time.value = time;

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      const next = width / height;
      for (let i = 0; i < N_RAIN; i++) rx[i] *= next / aspect;
      aspect = next;
      camera.right = aspect;
      camera.updateProjectionMatrix();
      glowMat.uniforms.scale.value = height;
    },
    dispose() {
      lineGeo.dispose();
      lineMat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
    },
  };
};
