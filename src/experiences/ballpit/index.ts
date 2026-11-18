import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Grabber, type Grabbable } from '../../core/grab.ts';
import type { Experience, Hand } from '../../core/types.ts';
import meta from './meta.ts';

// A padded tub of glossy candy balls seen from the front, slightly above. Every hand becomes a cluster of
// kinematic spheres (palm + fingertips) pushed into the pit at a depth set by hand size, so sweeping shoves and
// splashes balls: open palm = big paddle, fist = heavy punch, swipe = splash. Pinch picks a ball up (open→pinch
// scoops a handful), release throws it. Clap two hands over the pit to pop a burst. Mouse: the cursor skims the
// pile as a paddle, press grabs. Own physics: equal spheres, spatial hash, impulses + projection, sleeping.

const R = 0.15; // ball radius
const W = 5.6; // tub interior, x
const D = 3.6; // tub interior, z
const HW = W / 2;
const HD = D / 2;
const WALL_H = 1.45;
const T = 0.34; // wall thickness
const Y_MAX = 6.5; // invisible ceiling
const G = 14;
const H_MAX = 1 / 120; // physics substep
const MAX_STEPS = 4; // frame drops beyond 1/30 s slow the sim instead of blowing it up
const ITERS = 3;
const E_BALL = 0.35;
const E_WALL = 0.45;
const E_HAND = 0.3;
const MU = 0.25;
const BOUNCE_MIN = 0.6; // slower contacts don't bounce (kills resting jitter)
const SOFT = 0.8; // fraction of overlap removed per iteration
const HEAVY = 0.25; // inverse-mass weight of the lower ball in a stacked pair
const WAKE_V = 0.45;
const WAKE_PEN = 0.3 * R;
const SLEEP_V2 = 0.07 * 0.07;
const SLEEP_T = 0.4;
const MAX_V = 20;
const MAX_THROW = 14;
const CS = 2 * R; // grid cell
const GX = Math.ceil(W / CS);
const GZ = Math.ceil(D / CS);
const GY = Math.ceil(Y_MAX / CS);
const NC = GX * GY * GZ;
const MAX_K = 64; // kinematic hand colliders
const PALM = [0, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const DEPTH_K = 3; // world units of dig per unit of hand-size ratio
const SCOOP_WINDOW = 0.5; // s: open palm this recently before a pinch = scoop a handful
const MAX_CURSORS = 8;
const FOV = 36;
const ELEV = THREE.MathUtils.degToRad(47);
const LOOK = new THREE.Vector3(0, 0.45, 0.1);

const BG = '#ffe9dc';
const TUB = '#7cc6f2';
const TUB_FLOOR = '#cfeafc';
const PINK = '#ff4f8b';
const COLORS = ['#ff4f6d', '#ffc21a', '#2f80ff', '#14d39a', '#9b5cff', '#ff8a1f'];

const clamp = THREE.MathUtils.clamp;

interface Ball extends Grabbable {
  i: number;
}

interface HandState {
  prev: Float64Array; // collider positions last frame
  n: number; // collider count last frame (-1 = none yet)
  rest: number; // calibrated rest hand size
  y: number; // smoothed dig height
  lastOpen: number;
  seen: number;
  cur: THREE.Vector3; // pinch point projected at dig height
}

export default (): Experience => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.45 : 1;
  const N = reduced ? 600 : 1000;
  const PILE_H = (N * (4 / 3) * Math.PI * R ** 3) / (0.62 * W * D); // settled pile height, roughly
  const Y_REST = PILE_H * 0.65;

  let renderer: THREE.WebGLRenderer;
  let envRT: THREE.WebGLRenderTarget | undefined;
  let prev: { shadow: boolean; type: THREE.ShadowMapType; tone: THREE.ToneMapping; exposure: number } | undefined;
  let time = 0;
  let dist = 10;
  let frameNo = 0;
  let nextDrop = 2.5;
  let clapD = Infinity;
  let clapCool = 0;
  let ringT = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

  // Physics state.
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  const vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N);
  const awake = new Uint8Array(N);
  const kin = new Uint8Array(N); // 1 = held by a hand, 2 = scooped along with a held ball
  const leader = new Int32Array(N).fill(-1);
  const ox = new Float64Array(N), oy = new Float64Array(N), oz = new Float64Array(N); // offset to leader
  const k0x = new Float64Array(N), k0y = new Float64Array(N), k0z = new Float64Array(N); // held: frame start
  const k1x = new Float64Array(N), k1y = new Float64Array(N), k1z = new Float64Array(N); // held: frame target
  const sleepT = new Float32Array(N);
  const contacts = new Uint8Array(N);
  const support = new Uint8Array(N);
  const cellOf = new Int32Array(N);
  const cellStart = new Int32Array(NC + 1);
  const cellItems = new Int32Array(N);
  // Kinematic hand colliders: interpolated from (x0) to (x1) over the frame's substeps.
  const kx0 = new Float64Array(MAX_K), ky0 = new Float64Array(MAX_K), kz0 = new Float64Array(MAX_K);
  const kx1 = new Float64Array(MAX_K), ky1 = new Float64Array(MAX_K), kz1 = new Float64Array(MAX_K);
  const kvx = new Float64Array(MAX_K), kvy = new Float64Array(MAX_K), kvz = new Float64Array(MAX_K);
  const kr = new Float64Array(MAX_K);
  const kf = new Uint8Array(MAX_K); // 0 plain, 1 fist (punch), 2 swipe (splash)
  let kCount = 0;
  // Visual state.
  const colorIdx = new Uint8Array(N);
  const glow = new Float32Array(N);
  const glowT = new Float32Array(N);
  const pop = new Float32Array(N);
  const ao = new Float32Array(N).fill(1);
  const palette = COLORS.map((c) => new THREE.Color(c));

  const balls: Ball[] = [];
  const grabber = new Grabber(camera, balls);
  const grabHands: Hand[] = [];
  const handStates = new Map<string, HandState>();
  const tmp = new THREE.Vector3();
  const cursorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  let ballMesh: THREE.InstancedMesh;
  let ghostMesh: THREE.InstancedMesh;
  let ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  const cursors: { group: THREE.Group; ring: THREE.Mesh; dot: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  const CUR_IDLE = new THREE.Color('#1d1a5e');
  const CUR_ACTIVE = new THREE.Color(PINK);

  const cell = (x: number, y: number, z: number) =>
    (clamp(Math.floor(y / CS), 0, GY - 1) * GZ + clamp(Math.floor((z + HD) / CS), 0, GZ - 1)) * GX + clamp(Math.floor((x + HW) / CS), 0, GX - 1);

  function wake(i: number) {
    awake[i] = 1;
    sleepT[i] = 0;
  }

  /** Counting sort of balls into grid cells; afterwards cell c holds cellItems[cellStart[c] .. cellStart[c+1]). */
  function buildGrid() {
    cellStart.fill(0);
    for (let i = 0; i < N; i++) cellStart[(cellOf[i] = cell(px[i], py[i], pz[i]))]++;
    let s = 0;
    for (let c = 0; c < NC; c++) cellStart[c] = s += cellStart[c];
    cellStart[NC] = N;
    for (let i = N - 1; i >= 0; i--) cellItems[--cellStart[cellOf[i]]] = i;
  }

  function solvePairs(first: boolean) {
    const DD = 4 * R * R, DM = DD * 1.06; // DM: contact margin for support/AO counting
    // Bottom-up (grid order is y-major), lower ball of a stacked pair heavier: resting load reaches the floor in
    // a few iterations instead of leaving the pile jittering.
    for (let s0 = 0; s0 < N; s0++) {
      const i = cellItems[s0], c = cellOf[i];
      const cx = c % GX, cz = Math.floor(c / GX) % GZ, cy = Math.floor(c / (GX * GZ));
      for (let y = Math.max(0, cy - 1); y <= Math.min(GY - 1, cy + 1); y++) {
        for (let z = Math.max(0, cz - 1); z <= Math.min(GZ - 1, cz + 1); z++) {
          const row = (y * GZ + z) * GX;
          const end = cellStart[row + Math.min(GX - 1, cx + 1) + 1];
          // s > s0: each pair once.
          for (let s = Math.max(s0 + 1, cellStart[row + Math.max(0, cx - 1)]); s < end; s++) {
            const j = cellItems[s];
            const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= DM) continue;
            const d = Math.sqrt(d2) || 1e-6;
            if (first) {
              contacts[i]++;
              contacts[j]++;
              if (dy > 0.25 * d) support[j] = 1;
              else if (dy < -0.25 * d) support[i] = 1;
            }
            if (d2 >= DD) continue;
            const nx = dx / d, ny = dy / d, nz = dz / d;
            const pen = 2 * R - d;
            let rvn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny + (vz[j] - vz[i]) * nz;
            if (!kin[i] && !awake[i] && (kin[j] || (awake[j] && (rvn < -WAKE_V || pen > WAKE_PEN)))) wake(i);
            if (!kin[j] && !awake[j] && (kin[i] || (awake[i] && (rvn < -WAKE_V || pen > WAKE_PEN)))) wake(j);
            let wi = kin[i] ? 0 : awake[i], wj = kin[j] ? 0 : awake[j];
            if (wi && wj) {
              if (ny > 0.3) wi = HEAVY;
              else if (ny < -0.3) wj = HEAVY;
            }
            const w = wi + wj;
            if (!w) continue;
            const corr = (pen * SOFT) / w;
            px[i] -= nx * corr * wi;
            py[i] -= ny * corr * wi;
            pz[i] -= nz * corr * wi;
            px[j] += nx * corr * wj;
            py[j] += ny * corr * wj;
            pz[j] += nz * corr * wj;
            if (rvn >= 0) continue;
            const jn = (-(1 + (rvn < -BOUNCE_MIN ? E_BALL : 0)) * rvn) / w;
            vx[i] -= nx * jn * wi;
            vy[i] -= ny * jn * wi;
            vz[i] -= nz * jn * wi;
            vx[j] += nx * jn * wj;
            vy[j] += ny * jn * wj;
            vz[j] += nz * jn * wj;
            // Coulomb friction on the tangential relative velocity.
            const rx = vx[j] - vx[i], ry = vy[j] - vy[i], rz = vz[j] - vz[i];
            rvn = rx * nx + ry * ny + rz * nz;
            const tx = rx - rvn * nx, ty = ry - rvn * ny, tz = rz - rvn * nz;
            const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (tl < 1e-6) continue;
            const jt = Math.min(MU * jn, tl / w) / tl;
            vx[i] += tx * jt * wi;
            vy[i] += ty * jt * wi;
            vz[i] += tz * jt * wi;
            vx[j] -= tx * jt * wj;
            vy[j] -= ty * jt * wj;
            vz[j] -= tz * jt * wj;
          }
        }
      }
    }
  }

  function solveHands(a: number) {
    for (let k = 0; k < kCount; k++) {
      const cx = kx0[k] + (kx1[k] - kx0[k]) * a, cy = ky0[k] + (ky1[k] - ky0[k]) * a, cz = kz0[k] + (kz1[k] - kz0[k]) * a;
      const rr = kr[k] + R, rr2 = rr * rr;
      const sp = Math.sqrt(kvx[k] * kvx[k] + kvy[k] * kvy[k] + kvz[k] * kvz[k]);
      const x0 = clamp(Math.floor((cx - rr + HW) / CS), 0, GX - 1), x1 = clamp(Math.floor((cx + rr + HW) / CS), 0, GX - 1);
      const y0 = clamp(Math.floor((cy - rr) / CS), 0, GY - 1), y1 = clamp(Math.floor((cy + rr) / CS), 0, GY - 1);
      const z0 = clamp(Math.floor((cz - rr + HD) / CS), 0, GZ - 1), z1 = clamp(Math.floor((cz + rr + HD) / CS), 0, GZ - 1);
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const row = (y * GZ + z) * GX;
          const end = cellStart[row + x1 + 1];
          for (let s = cellStart[row + x0]; s < end; s++) {
            const b = cellItems[s];
            if (kin[b]) continue;
            const dx = px[b] - cx, dy = py[b] - cy, dz = pz[b] - cz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= rr2) continue;
            const d = Math.sqrt(d2);
            const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : 1, nz = d > 1e-6 ? dz / d : 0;
            wake(b);
            px[b] = cx + nx * rr;
            py[b] = cy + ny * rr;
            pz[b] = cz + nz * rr;
            const rx = vx[b] - kvx[k], ry = vy[b] - kvy[k], rz = vz[b] - kvz[k];
            const rvn = rx * nx + ry * ny + rz * nz;
            if (rvn >= 0) continue;
            const jn = -(1 + E_HAND) * rvn;
            // Drag a bit of the hand's tangential motion along.
            const tx = rx - rvn * nx, ty = ry - rvn * ny, tz = rz - rvn * nz;
            vx[b] += nx * jn - tx * 0.3;
            vy[b] += ny * jn - ty * 0.3;
            vz[b] += nz * jn - tz * 0.3;
            if (kf[k] === 1) {
              // Fist: heavy punch.
              const p = sp * 0.7 * motion;
              vx[b] += nx * p;
              vy[b] += Math.abs(ny) * p + sp * 0.35 * motion;
              vz[b] += nz * p;
            } else if (kf[k] === 2) {
              // Swipe: splash up and out.
              vx[b] += nx * sp * 0.3 * motion;
              vy[b] += sp * (0.45 + 0.3 * Math.random()) * motion;
              vz[b] += nz * sp * 0.3 * motion;
            }
          }
        }
      }
    }
  }

  function solveWalls() {
    for (let i = 0; i < N; i++) {
      if (kin[i] || !awake[i]) continue;
      if (px[i] < -HW + R) (px[i] = -HW + R), vx[i] < 0 && (vx[i] *= -E_WALL);
      else if (px[i] > HW - R) (px[i] = HW - R), vx[i] > 0 && (vx[i] *= -E_WALL);
      if (pz[i] < -HD + R) (pz[i] = -HD + R), vz[i] < 0 && (vz[i] *= -E_WALL);
      else if (pz[i] > HD - R) (pz[i] = HD - R), vz[i] > 0 && (vz[i] *= -E_WALL);
      if (py[i] > Y_MAX - R) (py[i] = Y_MAX - R), vy[i] > 0 && (vy[i] = 0);
      if (py[i] <= R) {
        py[i] = R;
        if (vy[i] < 0) vy[i] = vy[i] < -BOUNCE_MIN ? -vy[i] * E_BALL : 0;
        support[i] = 1;
      }
    }
  }

  function step(h: number, a: number) {
    const damp = Math.exp(-0.15 * h), floorFric = Math.exp(-3 * h);
    for (let i = 0; i < N; i++) {
      if (kin[i]) {
        px[i] = k0x[i] + (k1x[i] - k0x[i]) * a;
        py[i] = k0y[i] + (k1y[i] - k0y[i]) * a;
        pz[i] = k0z[i] + (k1z[i] - k0z[i]) * a;
        continue;
      }
      if (!awake[i]) continue;
      vy[i] -= G * h;
      vx[i] *= damp;
      vy[i] *= damp;
      vz[i] *= damp;
      if (py[i] <= R * 1.02) (vx[i] *= floorFric), (vz[i] *= floorFric);
      const v2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
      if (v2 > MAX_V * MAX_V) {
        const s = MAX_V / Math.sqrt(v2);
        vx[i] *= s;
        vy[i] *= s;
        vz[i] *= s;
      }
      px[i] += vx[i] * h;
      py[i] += vy[i] * h;
      pz[i] += vz[i] * h;
    }
    buildGrid();
    contacts.fill(0);
    support.fill(0);
    for (let it = 0; it < ITERS; it++) {
      solveWalls();
      solvePairs(it === 0);
      solveHands(a);
    }
    solveWalls(); // hands may have pushed balls through a wall
    for (let i = 0; i < N; i++) {
      if (kin[i]) continue;
      if (!awake[i]) {
        if (!support[i]) wake(i); // whatever held it up moved away
        continue;
      }
      if (support[i] && vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i] < SLEEP_V2) {
        if ((sleepT[i] += h) > SLEEP_T) {
          awake[i] = 0;
          vx[i] = vy[i] = vz[i] = 0;
        }
      } else sleepT[i] = 0;
    }
  }

  // Grab: the held ball is kinematic and follows the Grabber proxy; an open→pinch scoop takes neighbours along.
  grabber.onGrab = (item, hand) => {
    const b = (item as Ball).i;
    if (kin[b]) return; // second hand on the same ball
    kin[b] = 1;
    pop[b] = 1;
    const hs = handStates.get(hand.id);
    if (!hs || hand.kind !== 'tracked' || time - hs.lastOpen > SCOOP_WINDOW) return;
    for (let n = 0; n < 5; n++) {
      let best = -1, bestD = (3.2 * R) ** 2;
      for (let j = 0; j < N; j++) {
        if (kin[j]) continue;
        const d2 = (px[j] - px[b]) ** 2 + (py[j] - py[b]) ** 2 + (pz[j] - pz[b]) ** 2;
        if (d2 < bestD) (best = j), (bestD = d2);
      }
      if (best < 0) break;
      kin[best] = 2;
      leader[best] = b;
      ox[best] = px[best] - px[b];
      oy[best] = py[best] - py[b];
      oz[best] = pz[best] - pz[b];
      balls[best].enabled = false;
      pop[best] = 0.7;
    }
  };
  grabber.onRelease = (item, v) => {
    const b = (item as Ball).i;
    const s = Math.min(1, MAX_THROW / (v.length() || 1));
    const tx = v.x * s, ty = v.y * s, tz = v.z * s;
    kin[b] = 0;
    wake(b);
    vx[b] = tx;
    vy[b] = ty;
    vz[b] = tz;
    pop[b] = 1;
    for (let j = 0; j < N; j++) {
      if (leader[j] !== b) continue;
      kin[j] = 0;
      leader[j] = -1;
      balls[j].enabled = true;
      wake(j);
      vx[j] = tx + (Math.random() - 0.5) * 1.2;
      vy[j] = ty + Math.random() * 0.8;
      vz[j] = tz + (Math.random() - 0.5) * 1.2;
      pop[j] = 0.7;
    }
  };

  /** Point on the ray through screen (x, y) at height `yh`, inside the tub's footprint. */
  function project(x: number, y: number, yh: number, out: Float64Array, o: number) {
    const ray = grabber.rayAt(x, y);
    const t = ray.direction.y < -0.02 ? Math.min(60, (yh - ray.origin.y) / ray.direction.y) : 60;
    out[o] = clamp(ray.origin.x + ray.direction.x * t, -HW, HW);
    out[o + 1] = yh;
    out[o + 2] = clamp(ray.origin.z + ray.direction.z * t, -HD, HD);
  }

  const pt = new Float64Array(3);
  function addCollider(hs: HandState, slot: number, count: number, x: number, y: number, yh: number, r: number, flag: number, dt: number) {
    if (kCount >= MAX_K) return;
    const k = kCount++;
    project(x, y, yh, pt, 0);
    const o = slot * 3;
    const has = hs.n === count;
    kx0[k] = has ? hs.prev[o] : pt[0];
    ky0[k] = has ? hs.prev[o + 1] : pt[1];
    kz0[k] = has ? hs.prev[o + 2] : pt[2];
    kx1[k] = hs.prev[o] = pt[0];
    ky1[k] = hs.prev[o + 1] = pt[1];
    kz1[k] = hs.prev[o + 2] = pt[2];
    const inv = dt > 0 ? 1 / dt : 0;
    kvx[k] = (kx1[k] - kx0[k]) * inv;
    kvy[k] = (ky1[k] - ky0[k]) * inv;
    kvz[k] = (kz1[k] - kz0[k]) * inv;
    const sp = Math.sqrt(kvx[k] ** 2 + kvy[k] ** 2 + kvz[k] ** 2);
    if (sp > 25) {
      kvx[k] *= 25 / sp;
      kvy[k] *= 25 / sp;
      kvz[k] *= 25 / sp;
    }
    kr[k] = r;
    kf[k] = flag;
  }

  const prune = (hs: HandState, id: string) => {
    if (hs.seen !== frameNo) handStates.delete(id);
  };

  function buildHands(hands: Hand[], dt: number) {
    kCount = 0;
    for (const hand of hands) {
      let hs = handStates.get(hand.id);
      if (!hs) {
        hs = { prev: new Float64Array(30), n: -1, rest: hand.size, y: Y_REST, lastOpen: -1, seen: 0, cur: new THREE.Vector3() };
        handStates.set(hand.id, hs);
      }
      hs.seen = frameNo;
      const g = hand.gestures;
      if (hand.kind === 'tracked') {
        // Depth: hand size against a slowly adapting rest size. Reach toward the screen (hand shrinks) = dig deeper.
        if (hand.size > 0) hs.rest += (hand.size - hs.rest) * (1 - Math.exp(-dt / 8));
        const ratio = hs.rest > 0 && hand.size > 0 ? hand.size / hs.rest : 1;
        const yh = clamp(Y_REST + DEPTH_K * (ratio - 1), R * 0.6, WALL_H + 0.8);
        hs.y += (yh - hs.y) * (1 - Math.exp(-10 * dt));
        if (g.open) hs.lastOpen = time;
        const flag = g.fist ? 1 : g.swipe ? 2 : 0;
        const palmR = g.open ? 0.36 : g.fist ? 0.3 : 0.25;
        const tipR = g.fist ? 0.2 : 0.15;
        const lm = hand.landmarks;
        for (let j = 0; j < 5; j++) addCollider(hs, j, 10, lm[PALM[j]].x, lm[PALM[j]].y, hs.y, palmR, flag, dt);
        for (let j = 0; j < 5; j++) addCollider(hs, 5 + j, 10, lm[TIPS[j]].x, lm[TIPS[j]].y, hs.y, tipR, flag, dt);
        hs.n = 10;
      } else {
        // Pointer: one paddle skimming the top of the pile; none while it holds a ball.
        hs.y = PILE_H;
        if (grabber.held.has(hand.id)) hs.n = -1;
        else {
          addCollider(hs, 0, 1, hand.cursor.x, hand.cursor.y, hs.y, 0.38, g.swipe ? 2 : 0, dt);
          hs.n = 1;
        }
      }
      project(hand.pinchPoint.x, hand.pinchPoint.y, hs.y, pt, 0);
      hs.cur.set(pt[0], pt[1], pt[2]);
    }
    handStates.forEach(prune);
  }

  function burst(cx: number, cz: number, strength: number) {
    const RB = 1.9;
    for (let i = 0; i < N; i++) {
      if (kin[i]) continue;
      const dx = px[i] - cx, dz = pz[i] - cz;
      const rho = Math.sqrt(dx * dx + dz * dz);
      if (rho > RB) continue;
      const f = (1 - rho / RB) * strength;
      wake(i);
      vy[i] += (5 + 3 * Math.random()) * f;
      vx[i] += (dx / (rho || 1)) * 3 * f + (Math.random() - 0.5) * f;
      vz[i] += (dz / (rho || 1)) * 3 * f + (Math.random() - 0.5) * f;
    }
    ring.position.set(cx, PILE_H + 0.05, cz);
    ringT = 0;
  }

  return {
    id: 'ballpit',
    title: meta.title,
    hint: { text: '손으로 볼풀을 헤집고, 공을 집어 던져 보세요', gesture: 'open' },
    needs: ['hands'],

    async init(ctx) {
      renderer = ctx.renderer;
      prev = { shadow: renderer.shadowMap.enabled, type: renderer.shadowMap.type, tone: renderer.toneMapping, exposure: renderer.toneMappingExposure };
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 1;

      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      envRT = pmrem.fromScene(room, 0.04);
      room.dispose();
      pmrem.dispose();
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.55;

      scene.add(new THREE.HemisphereLight(0xffffff, 0xffd6c4, 0.9));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(2.5, 8, 4);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.radius = 4;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.02;
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -5;
      sc.right = sc.top = 5;
      sc.near = 2;
      sc.far = 20;
      scene.add(sun);

      // Studio sweep: the ground is exactly the background colour, a shadow-only plane on top grounds the tub.
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ color: BG }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.2;
      const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.16 }));
      shadowPlane.rotation.x = -Math.PI / 2;
      shadowPlane.position.y = -0.19;
      shadowPlane.receiveShadow = true;
      scene.add(ground, shadowPlane);

      // Padded tub.
      const tubMat = new THREE.MeshStandardMaterial({ color: TUB, roughness: 0.55 });
      const floorMat = new THREE.MeshStandardMaterial({ color: TUB_FLOOR, roughness: 0.8 });
      const fb = new RoundedBoxGeometry(W + 2 * T, WALL_H + 0.2, T, 4, 0.14);
      const lr = new RoundedBoxGeometry(T, WALL_H + 0.2, D + 0.2, 4, 0.14);
      const floor = new THREE.Mesh(new RoundedBoxGeometry(W + 2 * T, 0.2, D + 2 * T, 2, 0.06), floorMat);
      floor.position.y = -0.1;
      floor.receiveShadow = true;
      scene.add(floor);
      for (const [geo, x, z] of [[fb, 0, HD + T / 2], [fb, 0, -HD - T / 2], [lr, -HW - T / 2, 0], [lr, HW + T / 2, 0]] as const) {
        const m = new THREE.Mesh(geo, tubMat);
        m.position.set(x, (WALL_H + 0.2) / 2 - 0.2, z);
        m.castShadow = m.receiveShadow = true;
        scene.add(m);
      }

      // Balls: one instanced mesh, glossy plastic.
      const ballMat = new THREE.MeshPhysicalMaterial({ roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
      ballMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(R, 20, 14), ballMat, N);
      ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      ballMesh.frustumCulled = false; // instances move; the cached bounds would go stale
      ballMesh.castShadow = ballMesh.receiveShadow = true;
      ballMesh.setColorAt(0, palette[0]);
      ballMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      scene.add(ballMesh);

      // Start as a random cloud above the tub: the pit pours itself full (overlaps resolve by projection, no kick).
      for (let i = 0; i < N; i++) {
        px[i] = (Math.random() * 2 - 1) * (HW - R);
        pz[i] = (Math.random() * 2 - 1) * (HD - R);
        py[i] = R + 0.05 + (i / N) * 4.5 + Math.random() * 0.3;
        awake[i] = 1;
        colorIdx[i] = Math.floor(Math.random() * palette.length);
        const object = new THREE.Object3D(); // Grabber proxy, never rendered
        object.position.set(px[i], py[i], pz[i]);
        balls.push({ object, radius: R * 1.5, i });
      }

      // Hand ghost: the colliders, faintly visible where they poke out of the pile.
      ghostMesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, roughness: 0.4, depthWrite: false }),
        MAX_K,
      );
      ghostMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      ghostMesh.frustumCulled = false;
      ghostMesh.count = 0;
      scene.add(ghostMesh);

      ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      scene.add(ring);

      // 3D pinch cursors: ring tightens as the fingers close, dot fills in.
      const ringGeo = new THREE.RingGeometry(0.15, 0.19, 40);
      const dotGeo = new THREE.CircleGeometry(0.06, 24);
      for (let i = 0; i < MAX_CURSORS; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: CUR_IDLE, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
        const r = new THREE.Mesh(ringGeo, mat);
        const dot = new THREE.Mesh(dotGeo, mat);
        const group = new THREE.Group();
        group.add(r, dot);
        group.renderOrder = r.renderOrder = dot.renderOrder = 10;
        group.visible = false;
        cursors.push({ group, ring: r, dot, mat });
        scene.add(group);
      }
    },

    frame(input, dt) {
      frameNo++;
      time += dt;
      const hands = input.hands;

      // Camera: tiny idle sway.
      const sw = (hands.length ? 0.3 : 1) * motion;
      camera.position.set(LOOK.x + Math.sin(time * 0.13) * 0.35 * sw, LOOK.y + Math.sin(ELEV) * dist, LOOK.z + Math.cos(ELEV) * dist);
      camera.lookAt(LOOK);
      camera.updateMatrixWorld();

      // Grabber picks among the proxies; a closed fist punches instead of grabbing.
      for (let i = 0; i < N; i++) if (kin[i] !== 1) balls[i].object.position.set(px[i], py[i], pz[i]);
      grabHands.length = 0;
      for (const h of hands) if (!(h.kind === 'tracked' && h.gestures.fist && !grabber.held.has(h.id))) grabHands.push(h);
      grabber.update(grabHands, dt);

      // Held balls: kinematic, interpolated from where they are to the proxy over the substeps.
      for (let i = 0; i < N; i++) {
        if (kin[i] !== 1) continue;
        const p = balls[i].object.position;
        p.set(clamp(p.x, -HW + R, HW - R), clamp(p.y, R, Y_MAX - R), clamp(p.z, -HD + R, HD - R));
        k0x[i] = px[i];
        k0y[i] = py[i];
        k0z[i] = pz[i];
        k1x[i] = p.x;
        k1y[i] = p.y;
        k1z[i] = p.z;
      }
      for (let i = 0; i < N; i++) {
        if (kin[i] !== 2) continue;
        const l = leader[i];
        k0x[i] = px[i];
        k0y[i] = py[i];
        k0z[i] = pz[i];
        k1x[i] = clamp(k1x[l] + ox[i] * 0.9, -HW + R, HW - R);
        k1y[i] = Math.max(R, k1y[l] + oy[i] * 0.9);
        k1z[i] = clamp(k1z[l] + oz[i] * 0.9, -HD + R, HD - R);
      }
      for (let i = 0; i < N; i++) {
        if (!kin[i] || dt <= 0) continue;
        vx[i] = (k1x[i] - k0x[i]) / dt;
        vy[i] = (k1y[i] - k0y[i]) / dt;
        vz[i] = (k1z[i] - k0z[i]) / dt;
      }

      buildHands(hands, dt);

      // Clap: two hands snapping together over the pit pops a burst.
      clapCool -= dt;
      if (hands.length >= 2) {
        const a = hands[0], b = hands[1];
        const pa = a.kind === 'tracked' ? a.landmarks[9] : a.cursor, pb = b.kind === 'tracked' ? b.landmarks[9] : b.cursor;
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (dt > 0 && d < 0.14 && (clapD - d) / dt > 0.6 && clapCool <= 0) {
          project((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, PILE_H, pt, 0);
          burst(pt[0], pt[2], motion);
          clapCool = 0.6;
        }
        clapD = d;
      } else clapD = Infinity;

      // Idle: now and then a buried ball pops out and drops back in from above; the hole settles.
      nextDrop -= dt;
      if (nextDrop <= 0) {
        nextDrop = (hands.length ? 2.5 : 0.7) / motion + Math.random() * 1.2;
        let best = -1;
        for (let n = 0; n < 8; n++) {
          const j = Math.floor(Math.random() * N);
          if (!kin[j] && (best < 0 || py[j] < py[best])) best = j;
        }
        if (best >= 0) {
          px[best] = (Math.random() * 2 - 1) * (HW - R);
          pz[best] = (Math.random() * 2 - 1) * (HD - R);
          py[best] = Y_MAX - R - Math.random() * 0.5;
          vx[best] = vz[best] = 0;
          vy[best] = -1;
          wake(best);
        }
      }

      // Physics: fixed-size substeps (≤ 1/120 s), capped per frame.
      const simDt = Math.min(dt, H_MAX * MAX_STEPS);
      const steps = Math.max(1, Math.ceil(simDt / H_MAX - 1e-6));
      if (simDt > 0) for (let s = 0; s < steps; s++) step(simDt / steps, (s + 1) / steps);

      // Anticipation: the ball under each hand glows and lifts as the fingers close; held balls glow fully.
      for (const h of hands) {
        const hov = grabber.hovered.get(h.id) as Ball | undefined;
        if (hov) glowT[hov.i] = Math.max(glowT[hov.i], 0.25 + 0.75 * h.pinchStrength);
      }
      const kg = 1 - Math.exp(-14 * dt), ka = 1 - Math.exp(-6 * dt), kp = Math.exp(-6 * dt);
      const m = ballMesh.instanceMatrix.array as Float32Array;
      const col = ballMesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < N; i++) {
        glow[i] += ((kin[i] ? 1 : glowT[i]) - glow[i]) * kg;
        glowT[i] = 0;
        pop[i] *= kp;
        // Baked AO: darker near the tub floor and when packed in.
        const hf = clamp(py[i] / (PILE_H + R), 0, 1);
        ao[i] += ((0.5 + 0.5 * hf * hf) * (1 - 0.025 * Math.min(contacts[i], 10)) - ao[i]) * ka;
        const s = 1 + 0.2 * glow[i] + 0.25 * pop[i];
        const o = i * 16;
        m[o] = m[o + 5] = m[o + 10] = s;
        m[o + 12] = px[i];
        m[o + 13] = py[i] + (kin[i] ? 0 : glow[i] * R * 0.8);
        m[o + 14] = pz[i];
        const c = palette[colorIdx[i]], lit = ao[i] * (1 - 0.3 * glow[i]), add = 0.35 * glow[i];
        col[i * 3] = c.r * lit + add;
        col[i * 3 + 1] = c.g * lit + add;
        col[i * 3 + 2] = c.b * lit + add;
      }
      ballMesh.instanceMatrix.needsUpdate = true;
      ballMesh.instanceColor!.needsUpdate = true;

      const gm = ghostMesh.instanceMatrix.array as Float32Array;
      for (let k = 0; k < kCount; k++) {
        const o = k * 16;
        gm[o] = gm[o + 5] = gm[o + 10] = kr[k] * 0.9;
        gm[o + 12] = kx1[k];
        gm[o + 13] = ky1[k];
        gm[o + 14] = kz1[k];
      }
      ghostMesh.count = kCount;
      ghostMesh.instanceMatrix.needsUpdate = true;

      if (ring.visible || ringT < 1) {
        ringT = Math.min(1, ringT + dt / 0.6);
        ring.visible = ringT < 1;
        ring.scale.setScalar(0.3 + 2.2 * ringT);
        ring.material.opacity = 0.8 * (1 - ringT);
      }

      for (let i = 0; i < MAX_CURSORS; i++) {
        const c = cursors[i], h = hands[i];
        c.group.visible = !!h;
        if (!h) continue;
        const p = grabber.points.get(h.id) ?? handStates.get(h.id)?.cur;
        if (p) c.group.position.copy(p);
        else grabber.rayAt(h.pinchPoint.x, h.pinchPoint.y).intersectPlane(cursorPlane, c.group.position);
        const held = grabber.held.has(h.id);
        const active = held || grabber.hovered.has(h.id);
        c.mat.color.copy(active ? CUR_ACTIVE : CUR_IDLE);
        c.mat.opacity = active ? 0.95 : 0.6;
        const ps = held ? 1 : h.pinchStrength;
        c.ring.scale.setScalar(1 - 0.45 * ps);
        c.dot.scale.setScalar(0.3 + 0.9 * ps);
        c.group.quaternion.copy(camera.quaternion);
        c.group.scale.setScalar(tmp.subVectors(c.group.position, camera.position).length() / 10);
      }

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },

    resize(width, height) {
      const aspect = width / height;
      const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      dist = Math.max((HW + T + 0.5) / (t * aspect), 3 / t);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    dispose() {
      const geos = new Set<THREE.BufferGeometry>();
      const mats = new Set<THREE.Material>();
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        geos.add(o.geometry);
        for (const mm of Array.isArray(o.material) ? o.material : [o.material]) mats.add(mm);
      });
      for (const mm of mats) mm.dispose();
      for (const g of geos) g.dispose();
      ballMesh?.dispose();
      ghostMesh?.dispose();
      envRT?.dispose();
      if (prev) {
        renderer.shadowMap.enabled = prev.shadow;
        renderer.shadowMap.type = prev.type;
        renderer.toneMapping = prev.tone;
        renderer.toneMappingExposure = prev.exposure;
      }
    },
  };
};
