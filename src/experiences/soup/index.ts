import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Grabber, type Grabbable } from '../../core/grab.ts';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// A Warhol-style wall shelf of soup cans. Pinch a can off the shelf, carry it (push/pull for depth, twist to roll,
// two hands to scale); drop it on an empty slot to shelve it there, or let go anywhere else to toss it: it bounces on
// the floor and floats back home after a few seconds.
const COLS = 4;
const ROWS = 3;
const DX = 1.4; // slot spacing
const ROW_BASE = [1.25, -0.5, -2.25]; // shelf board tops, top row first
const EMPTY = [5, 10]; // slots that start empty (row * COLS + col)
const R = 0.42; // can radius
const H = 1.1; // can height
const FLOOR = -3.3;
const WALL_Z = -0.65;
const BOARD_W = 6.4;
const BOARD_D = 1.25;
const BOARD_FRONT = WALL_Z + BOARD_D;
const FRONT_Z = 3.5; // tossed cans bounce back before reaching the camera
const LOOK = new THREE.Vector3(0, -0.4, 0);
const FOV = 40;
const G = 16; // gravity, units/s²
const MAX_THROW = 16;
const SNAP_R = 0.8; // how close (perpendicular to the view ray) a held can must be to a free slot to shelve it
const SNAP_SPEED = 7; // faster releases are throws even over a free slot
const RETURN_AFTER = 3;
const MAX_CURSORS = 8;

const RED = '#d7261e';
const GOLD = '#e2b13c';
const KO = '"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic","Nanum Gothic",sans-serif';
const SANS = '"Helvetica Neue",Arial,sans-serif';

// Invented varieties: [Korean name, English name, band color, name ink]
const VARIETIES: [string, string, string, string][] = [
  ['토마토', 'TOMATO', RED, RED],
  ['크림 버섯', 'CREAM OF MUSHROOM', RED, RED],
  ['옥수수 차우더', 'CORN CHOWDER', '#f2b705', '#b07c00'],
  ['소고기 국수', 'BEEF NOODLE', RED, RED],
  ['단호박', 'PUMPKIN', '#f26b1d', '#d4520a'],
  ['감자 대파', 'POTATO LEEK', '#1f8a4c', '#1f8a4c'],
  ['김치 찌개', 'KIMCHI STEW', RED, RED],
  ['별 닭고기', 'CHICKEN STARS', '#2b59c3', '#2b59c3'],
  ['완두콩', 'GREEN PEA', '#e5398a', '#c81f6f'],
  ['양파', 'FRENCH ONION', RED, RED],
];

type State = 'shelf' | 'held' | 'toss' | 'fly';

interface Can extends Grabbable {
  object: THREE.Group;
  idx: number;
  pivot: THREE.Group; // hinge at the can's bottom: hover lean + wobble rock
  spinner: THREE.Group; // spins around the can's axis while held so the label reads
  label: THREE.MeshStandardMaterial;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  home: number;
  state: State;
  target: number; // free slot under a held can, -1 if none
  hover: number;
  hoverTarget: number;
  lean: number;
  punch: number; // grab/land pop, decays
  wob: number;
  wobV: number;
  spin: number;
  shadowA: number;
  vel: THREE.Vector3;
  ang: THREE.Vector3; // angular velocity, axis * rad/s
  timer: number;
  from: THREE.Vector3;
  fromQ: THREE.Quaternion;
  fromS: number;
  t: number;
  dur: number;
  arc: number;
}

function drawLabel([ko, en, band, ink]: [string, string, string, string]): HTMLCanvasElement {
  const W = 768, Hh = 320, BAND = 172;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Hh;
  const g = c.getContext('2d')!;
  g.fillStyle = band;
  g.fillRect(0, 0, W, BAND);
  g.fillStyle = '#fbf6ee';
  g.fillRect(0, BAND, W, Hh - BAND);
  g.fillStyle = GOLD;
  g.fillRect(0, BAND - 4, W, 6);
  for (let x = 12; x < W; x += 24) {
    g.beginPath();
    g.arc(x, Hh - 12, 4, 0, Math.PI * 2);
    g.fill();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // One face at the front (u = 0.5) and one split across the seam for the back.
  for (const cx of [W / 2, 0, W]) {
    g.fillStyle = '#ffffff';
    g.font = `italic 700 86px Georgia,"Times New Roman",serif`;
    g.fillText("MOVE's", cx, 76, 330);
    g.font = `700 22px ${SANS}`;
    g.fillText('CONDENSED  ·  진한 수프', cx, 140, 320);
    g.beginPath();
    g.arc(cx, BAND, 30, 0, Math.PI * 2);
    g.fillStyle = GOLD;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#9a7420';
    g.stroke();
    g.beginPath();
    g.arc(cx, BAND, 20, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = ink;
    g.font = `800 58px ${KO}`;
    g.fillText(ko, cx, 236, 330);
    g.fillStyle = '#1a1a1a';
    g.font = `700 25px ${SANS}`;
    g.fillText(en, cx, 280, 330);
  }
  return c;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return new THREE.CanvasTexture(c);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export default (): Experience => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.35 : 1;

  let renderer: THREE.WebGLRenderer;
  let envRT: THREE.WebGLRenderTarget | undefined;
  let time = 0;
  let dist = 10;
  let boundX = 4;
  let sway = 1;
  let nextWobble = 2;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f4ede1');
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  const cans: Can[] = [];
  const owner = new Int8Array(COLS * ROWS).fill(-1);
  const slotPos: THREE.Vector3[] = [];
  const ghosts: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = [];
  const ghostA = new Float32Array(COLS * ROWS);
  const cursors: { group: THREE.Group; ring: THREE.Mesh; dot: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  const grabber = new Grabber(camera, cans);

  const ray = new THREE.Ray();
  const tmp = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const IDENT = new THREE.Quaternion();
  const cursorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1); // z = 1, just in front of the shelf
  const CUR_IDLE = new THREE.Color('#1b1b1b');
  const CUR_ACTIVE = new THREE.Color(RED);

  for (let s = 0; s < COLS * ROWS; s++) {
    const r = Math.floor(s / COLS), c = s % COLS;
    slotPos.push(new THREE.Vector3((c - (COLS - 1) / 2) * DX, ROW_BASE[r] + H / 2, 0));
  }

  /** Free slot (or this can's own home) the held can is visually over, -1 if none. */
  function slotUnder(can: Can): number {
    ray.origin.copy(camera.position);
    ray.direction.subVectors(can.object.position, camera.position).normalize();
    let best = -1, bestD = SNAP_R * SNAP_R;
    for (let s = 0; s < slotPos.length; s++) {
      if (owner[s] !== -1 && owner[s] !== can.idx) continue;
      const d = ray.distanceSqToPoint(slotPos[s]);
      if (d < bestD) (best = s), (bestD = d);
    }
    return best;
  }

  function fly(can: Can, dur: number, arc: number) {
    can.state = 'fly';
    can.from.copy(can.object.position);
    can.fromQ.copy(can.object.quaternion);
    can.fromS = can.object.scale.x;
    can.t = 0;
    can.dur = dur;
    can.arc = arc;
  }

  grabber.onGrab = (item) => {
    const can = item as Can;
    can.state = 'held';
    can.punch = 1;
    can.wob = can.wobV = 0;
  };
  grabber.onRelease = (item, v) => {
    const can = item as Can;
    const s = slotUnder(can);
    if (s >= 0 && v.length() < SNAP_SPEED) {
      owner[can.home] = -1;
      owner[s] = can.idx;
      can.home = s;
      fly(can, 0.45, 0.25);
      return;
    }
    can.state = 'toss';
    can.timer = 0;
    can.vel.copy(v);
    if (can.vel.length() > MAX_THROW) can.vel.setLength(MAX_THROW);
    can.ang.set(can.vel.z * 0.8 + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3, -can.vel.x * 0.8);
  };

  function updateCan(can: Can, dt: number) {
    const obj = can.object;
    const k = 1 - Math.exp(-14 * dt);
    can.hover += (can.hoverTarget - can.hover) * k;
    can.lean += ((can.state === 'shelf' ? can.hover : 0) - can.lean) * k;
    can.punch *= Math.exp(-7 * dt);
    can.wobV += (-90 * can.wob - 5 * can.wobV) * dt;
    can.wob += can.wobV * dt;

    if (can.state === 'held') {
      can.spin += dt * 0.9 * motion;
      can.target = slotUnder(can);
    } else {
      can.target = -1;
      if (can.state !== 'toss') {
        // Settle the label back to the front.
        const goal = Math.round(can.spin / (Math.PI * 2)) * Math.PI * 2;
        can.spin += (goal - can.spin) * (1 - Math.exp(-4 * dt));
      }
    }

    if (can.state === 'shelf') {
      obj.position.copy(slotPos[can.home]);
    } else if (can.state === 'fly') {
      can.t = Math.min(1, can.t + dt / can.dur);
      const e = ease(can.t), a = Math.sin(Math.PI * e) * can.arc;
      obj.position.lerpVectors(can.from, slotPos[can.home], e);
      obj.position.y += a * 0.5;
      obj.position.z += a;
      obj.quaternion.slerpQuaternions(can.fromQ, IDENT, e);
      obj.scale.setScalar(can.fromS + (1 - can.fromS) * e);
      if (can.t >= 1) {
        can.state = 'shelf';
        can.punch = 0.6;
        can.wobV += (Math.random() < 0.5 ? -1 : 1) * 2.5 * motion;
      }
    } else if (can.state === 'toss') {
      const p = obj.position, v = can.vel, sc = obj.scale.x;
      // Half height of the (possibly tumbled) can along world y.
      const qq = obj.quaternion, upY = 1 - 2 * (qq.x * qq.x + qq.z * qq.z);
      const ext = (Math.abs(upY) * H * 0.5 + Math.sqrt(Math.max(0, 1 - upY * upY)) * R) * sc;
      const bottom0 = p.y - ext;
      v.y -= G * dt;
      p.addScaledVector(v, dt);
      let ground = false;
      for (const top of ROW_BASE) {
        if (v.y < 0 && Math.abs(p.x) < BOARD_W / 2 && p.z - R * sc < BOARD_FRONT && bottom0 >= top - 0.02 && p.y - ext < top) {
          p.y = top + ext;
          ground = true;
        }
      }
      if (p.y - ext < FLOOR) {
        p.y = FLOOR + ext;
        ground = true;
      }
      if (ground) {
        v.y = Math.abs(v.y) > 0.8 ? -v.y * 0.45 : 0;
        v.x *= Math.exp(-2.5 * dt);
        v.z *= Math.exp(-2.5 * dt);
        can.ang.multiplyScalar(Math.exp(-3 * dt));
      }
      if (Math.abs(p.x) > boundX) (p.x = Math.sign(p.x) * boundX), (v.x *= -0.6);
      if (p.z < WALL_Z + R * sc) (p.z = WALL_Z + R * sc), (v.z *= -0.5);
      if (p.z > FRONT_Z) (p.z = FRONT_Z), (v.z *= -0.5);
      const w = can.ang.length();
      if (w > 1e-4) {
        q.setFromAxisAngle(axis.copy(can.ang).divideScalar(w), w * dt);
        obj.quaternion.premultiply(q);
      }
      can.timer += dt;
      if (can.timer > RETURN_AFTER) fly(can, 1.2, 1.4);
    }

    can.pivot.rotation.set(0.3 * can.lean, 0, can.wob); // +x tips the top toward the camera
    can.pivot.scale.setScalar(1 + 0.07 * can.hover + 0.12 * can.punch);
    can.spinner.rotation.y = can.spin;
    can.label.emissiveIntensity = 0.4 * can.hover + 0.5 * can.punch;

    // Floor blob shadow for cans off the shelf: depth cue while carrying or tossing.
    can.shadowA += ((can.state === 'shelf' ? 0 : 1) - can.shadowA) * (1 - Math.exp(-6 * dt));
    const h = Math.max(0, obj.position.y - FLOOR);
    can.shadow.position.set(obj.position.x, FLOOR + 0.005, obj.position.z);
    can.shadow.scale.setScalar(obj.scale.x * (1 + h * 0.12));
    can.shadow.material.opacity = can.shadowA * 0.4 * THREE.MathUtils.clamp(1 - h / 7, 0.15, 1);
    can.shadow.visible = can.shadowA > 0.01;
  }

  return {
    id: 'soup',
    title: meta.title,
    hint: { text: '손가락을 모아 통조림을 집고 옮겨 보세요', gesture: 'pinch' },
    needs: ['hands'],

    async init(ctx) {
      renderer = ctx.renderer;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      envRT = pmrem.fromScene(room, 0.04);
      room.dispose();
      pmrem.dispose();
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.9;
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

      const sun = new THREE.DirectionalLight(0xffffff, 1.4);
      sun.position.set(-3, 5, 8);
      scene.add(sun);

      // Wall with pale Ben-Day dots.
      const dots = canvasTexture(64, 64, (g) => {
        g.fillStyle = '#f4ede1';
        g.fillRect(0, 0, 64, 64);
        g.fillStyle = '#f2cfc6';
        for (const [x, y] of [[16, 16], [48, 48]]) {
          g.beginPath();
          g.arc(x, y, 11, 0, Math.PI * 2);
          g.fill();
        }
      });
      dots.colorSpace = THREE.SRGBColorSpace;
      dots.wrapS = dots.wrapT = THREE.RepeatWrapping;
      dots.repeat.set(80 / 0.6, 40 / 0.6);
      dots.anisotropy = aniso;
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(80, 40), new THREE.MeshBasicMaterial({ map: dots }));
      wall.position.set(0, 0, WALL_Z);
      scene.add(wall);

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 30), new THREE.MeshBasicMaterial({ color: RED }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, FLOOR, WALL_Z + 15);
      scene.add(floor);

      const boardGeo = new THREE.BoxGeometry(BOARD_W, 0.14, BOARD_D);
      const lipGeo = new THREE.BoxGeometry(BOARD_W, 0.22, 0.05);
      const boardMat = new THREE.MeshStandardMaterial({ color: '#fbf6ee', roughness: 0.75 });
      const lipMat = new THREE.MeshStandardMaterial({ color: RED, roughness: 0.6 });
      for (const top of ROW_BASE) {
        const board = new THREE.Mesh(boardGeo, boardMat);
        board.position.set(0, top - 0.07, WALL_Z + BOARD_D / 2);
        const lip = new THREE.Mesh(lipGeo, lipMat);
        lip.position.set(0, top - 0.07, BOARD_FRONT + 0.025);
        scene.add(board, lip);
      }

      // Slot ghosts: show where a can can go.
      const ghostGeo = new THREE.CylinderGeometry(R, R, H, 32, 1, true);
      for (let s = 0; s < slotPos.length; s++) {
        const m = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
        m.position.copy(slotPos[s]);
        m.visible = false;
        ghosts.push(m);
        scene.add(m);
      }

      // Can parts, shared.
      const HB = H - 0.06;
      const bodyGeo = new THREE.CylinderGeometry(R, R, HB, 48, 1, false, Math.PI); // thetaStart π puts label u = 0.5 at the front
      const rimGeo = new THREE.TorusGeometry(R * 0.985, 0.035, 8, 48);
      rimGeo.rotateX(Math.PI / 2);
      const lidBump = canvasTexture(128, 128, (g) => {
        g.fillStyle = '#808080';
        g.fillRect(0, 0, 128, 128);
        g.lineWidth = 3;
        for (const [r, c] of [[58, '#b0b0b0'], [50, '#505050'], [40, '#b0b0b0'], [30, '#606060'], [18, '#a0a0a0']] as const) {
          g.strokeStyle = c;
          g.beginPath();
          g.arc(64, 64, r, 0, Math.PI * 2);
          g.stroke();
        }
      });
      const lidMat = new THREE.MeshStandardMaterial({ color: '#cfd2d6', metalness: 1, roughness: 0.3, bumpMap: lidBump, bumpScale: 2 });
      const shadowTex = canvasTexture(64, 64, (g) => {
        const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grd.addColorStop(0, 'rgba(0,0,0,1)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 64, 64);
      });
      const shadowGeo = new THREE.PlaneGeometry(R * 3, R * 3);
      shadowGeo.rotateX(-Math.PI / 2);

      const free = new Set(EMPTY);
      let s = 0;
      for (let i = 0; i < VARIETIES.length; i++) {
        while (free.has(s)) s++;
        const tex = new THREE.CanvasTexture(drawLabel(VARIETIES[i]));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = aniso;
        const label = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, metalness: 0.1, roughness: 0.45 });
        const spinner = new THREE.Group();
        spinner.position.y = H / 2;
        const top = new THREE.Mesh(rimGeo, lidMat);
        top.position.y = HB / 2;
        const bottom = new THREE.Mesh(rimGeo, lidMat);
        bottom.position.y = -HB / 2;
        spinner.add(new THREE.Mesh(bodyGeo, [label, lidMat, lidMat]), top, bottom);
        const pivot = new THREE.Group();
        pivot.position.y = -H / 2;
        pivot.add(spinner);
        const object = new THREE.Group();
        object.add(pivot);
        object.position.copy(slotPos[s]);
        const shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0, depthWrite: false }));
        shadow.visible = false;
        scene.add(object, shadow);
        owner[s] = i;
        cans.push({
          object, radius: 0.62, idx: i, pivot, spinner, label, shadow, home: s, state: 'shelf', target: -1,
          hover: 0, hoverTarget: 0, lean: 0, punch: 0, wob: 0, wobV: 0, spin: 0, shadowA: 0,
          vel: new THREE.Vector3(), ang: new THREE.Vector3(), timer: 0,
          from: new THREE.Vector3(), fromQ: new THREE.Quaternion(), fromS: 1, t: 0, dur: 1, arc: 0,
        });
        s++;
      }

      // 3D pinch cursors: ring tightens as the fingers close, dot fills in.
      const ringGeo = new THREE.RingGeometry(0.15, 0.19, 40);
      const dotGeo = new THREE.CircleGeometry(0.06, 24);
      for (let i = 0; i < MAX_CURSORS; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: CUR_IDLE, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
        const ring = new THREE.Mesh(ringGeo, mat);
        const dot = new THREE.Mesh(dotGeo, mat);
        const group = new THREE.Group();
        group.add(ring, dot);
        group.renderOrder = ring.renderOrder = dot.renderOrder = 10;
        group.visible = false;
        cursors.push({ group, ring, dot, mat });
        scene.add(group);
      }
    },

    frame(input, dt) {
      time += dt;
      const hands = input.hands;

      // Camera: gentle sway, calmer while someone is interacting.
      sway += ((hands.length ? 0.25 : 1) - sway) * (1 - Math.exp(-1.5 * dt));
      const a = sway * motion;
      camera.position.set(LOOK.x + Math.sin(time * 0.17) * 0.6 * a, LOOK.y + Math.sin(time * 0.11 + 1) * 0.3 * a, dist);
      camera.lookAt(LOOK);
      camera.updateMatrixWorld();

      grabber.update(hands, dt);

      for (const can of cans) can.hoverTarget = 0;
      for (const h of hands) {
        const held = grabber.held.get(h.id) as Can | undefined;
        if (held) held.hoverTarget = 1;
        const hov = grabber.hovered.get(h.id) as Can | undefined;
        if (hov) hov.hoverTarget = Math.max(hov.hoverTarget, 0.35 + 0.65 * h.pinchStrength);
      }

      // Idle: now and then a shelved can rocks on its base.
      nextWobble -= dt;
      if (nextWobble <= 0) {
        nextWobble = (hands.length ? 4 : 1.5) + Math.random() * 2.5;
        const can = cans[Math.floor(Math.random() * cans.length)];
        if (can.state === 'shelf') can.wobV += (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 1.5) * motion;
      }

      let carrying = false;
      for (const can of cans) {
        updateCan(can, dt);
        if (can.state === 'held') carrying = true;
      }

      for (let s = 0; s < ghosts.length; s++) {
        const o = owner[s];
        let goal = o >= 0 && cans[o].state === 'shelf' ? 0 : 0.1 + (carrying ? 0.06 + 0.04 * Math.sin(time * 3) : 0);
        for (const can of cans) if (can.target === s) goal = 0.42;
        ghostA[s] += (goal - ghostA[s]) * (1 - Math.exp(-10 * dt));
        const m = ghosts[s];
        m.material.opacity = ghostA[s];
        m.visible = ghostA[s] > 0.005;
        m.scale.setScalar(1 + ghostA[s] * 0.12);
      }

      for (let i = 0; i < MAX_CURSORS; i++) {
        const c = cursors[i], h = hands[i];
        c.group.visible = !!h;
        if (!h) continue;
        const p = grabber.points.get(h.id);
        if (p) c.group.position.copy(p);
        else {
          const r = grabber.rayAt(h.pinchPoint.x, h.pinchPoint.y);
          if (!r.intersectPlane(cursorPlane, c.group.position)) r.at(dist - 1, c.group.position);
        }
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
      dist = Math.max(3.45 / t, 3.5 / (t * aspect));
      boundX = Math.max(1, t * aspect * dist - 0.5);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    dispose() {
      const geos = new Set<THREE.BufferGeometry>();
      const mats = new Set<THREE.Material>();
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        geos.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
      });
      const texs = new Set<THREE.Texture>();
      for (const m of mats) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) texs.add(v);
        m.dispose();
      }
      for (const g of geos) g.dispose();
      for (const t of texs) t.dispose();
      envRT?.dispose();
    },
  };
};
