import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Experience } from '../../core/types.ts';
import { Grabber, type Grabbable } from '../../core/grab.ts';
import meta from './meta.ts';

// Extruded block letters for '움직임' / 'MOVE'. Pinch picks a letter up (Grabber: move, roll, push/pull, two-hand scale);
// released letters drift and keep apart. Pinch-and-hold on empty space for 1 s sends every letter back into the words.
// Glyphs are authored as THREE.Shapes (no font files): a geometric block face, Hangul built from jamo strokes.

const ACCENT = new THREE.Color('#ff3d1f');
const S = 1.15; // glyph unit → world
const GAP = 0.2; // between glyphs, glyph units
const FLOOR = -2.3;
const RADIUS = 0.62; // pick / wall radius per letter at scale 1, world
const SEP = 0.52; // separation radius: below half the word spacing so arranged neighbours don't shove
const HOLD_S = 1; // empty pinch-hold before re-arranging
const ARRANGE_S = 2.6;
const MAX_CURSORS = 6;

// ---- glyph shapes (unit coords, baseline y=0) ----
const poly = (...p: number[]) => {
  const s = new THREE.Shape().moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) s.lineTo(p[i], p[i + 1]);
  return s.closePath() as THREE.Shape;
};
const rect = (x0: number, y0: number, x1: number, y1: number) => poly(x0, y0, x1, y0, x1, y1, x0, y1);
const ell = (cx: number, cy: number, rx: number, ry: number, t: number, tv: number) => {
  const s = new THREE.Shape();
  s.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, 0);
  const h = new THREE.Path();
  h.absellipse(cx, cy, rx - t, ry - tv, 0, Math.PI * 2, true, 0);
  s.holes.push(h);
  return s;
};
const box = (x0: number, y0: number, x1: number, y1: number, t: number, tv: number) => {
  const s = rect(x0, y0, x1, y1);
  s.holes.push(new THREE.Path().moveTo(x0 + t, y0 + tv).lineTo(x0 + t, y1 - tv).lineTo(x1 - t, y1 - tv).lineTo(x1 - t, y0 + tv).closePath());
  return s;
};

const GLYPHS: Record<string, () => THREE.Shape[]> = {
  M: () => [poly(0, 0, 0.24, 0, 0.24, 0.6, 0.5, 0.2, 0.76, 0.6, 0.76, 0, 1, 0, 1, 1, 0.76, 1, 0.5, 0.52, 0.24, 1, 0, 1)],
  O: () => [ell(0.48, 0.5, 0.48, 0.5, 0.24, 0.22)],
  V: () => [poly(0, 1, 0.37, 0, 0.63, 0, 1, 1, 0.74, 1, 0.5, 0.3, 0.26, 1)],
  E: () => [poly(0, 0, 0.78, 0, 0.78, 0.22, 0.24, 0.22, 0.24, 0.39, 0.7, 0.39, 0.7, 0.61, 0.24, 0.61, 0.24, 0.78, 0.78, 0.78, 0.78, 1, 0, 1)],
  움: () => [ell(0.5, 0.97, 0.27, 0.18, 0.14, 0.11), rect(0, 0.58, 1, 0.72), rect(0.43, 0.44, 0.57, 0.58), box(0.12, 0, 0.88, 0.36, 0.14, 0.12)],
  직: () => [
    rect(0.80, 0.48, 0.94, 1.15),
    rect(0.04, 1.01, 0.68, 1.15),
    poly(0.29, 1.01, 0.43, 1.01, 0.15, 0.48, 0.0, 0.48),
    poly(0.33, 0.86, 0.42, 0.95, 0.72, 0.48, 0.57, 0.48),
    poly(0.06, 0.38, 0.94, 0.38, 0.94, 0, 0.8, 0, 0.8, 0.24, 0.06, 0.24),
  ],
  임: () => [rect(0.80, 0.48, 0.94, 1.15), ell(0.36, 0.83, 0.31, 0.32, 0.14, 0.13), box(0.08, 0, 0.94, 0.38, 0.14, 0.13)],
};
const WIDTH: Record<string, number> = { M: 1, O: 0.96, V: 1, E: 0.78, 움: 1, 직: 0.94, 임: 0.94 };
const ROWS: { text: string[]; y: number }[] = [
  { text: ['움', '직', '임'], y: 0.8 },
  { text: ['M', 'O', 'V', 'E'], y: -0.85 },
];

const outlineVert = /* glsl */ `
  uniform float width;
  attribute vec3 smoothNormal;
  void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + smoothNormal * width, 1.0); }`;
const outlineFrag = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(color, opacity);
    #include <colorspace_fragment>
  }`;

const cursorVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const cursorFrag = /* glsl */ `
  uniform float pinch, held, hover, progress, opacity;
  uniform vec3 accent;
  varying vec2 vUv;
  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float r = length(c), aa = fwidth(r) * 1.5;
    float ringR = mix(0.62, 0.34, pinch); // ring tightens as the fingers close
    float ring = 1.0 - smoothstep(0.04, 0.04 + aa, abs(r - ringR));
    float dotA = (1.0 - smoothstep(0.1, 0.1 + aa, r)) * (0.5 + 0.5 * pinch);
    float fill = held * (1.0 - smoothstep(0.3, 0.3 + aa, r)) * 0.5;
    float a = fract(atan(c.x, c.y) / 6.2831853 + 1.0);
    float arc = step(a, progress) * step(0.001, progress) * (1.0 - smoothstep(0.06, 0.06 + aa, abs(r - 0.88)));
    vec3 col = mix(vec3(1.0), accent, max(pinch * hover, max(held, arc)));
    float alpha = max(max(ring * (0.5 + 0.5 * max(hover, pinch)), dotA), max(fill, arc));
    gl_FragColor = vec4(col, alpha * opacity);
    #include <colorspace_fragment>
  }`;

interface Letter {
  item: Grabbable;
  group: THREE.Group; // grabbable: position/rotation/scale owned by Grabber while held
  body: THREE.Group; // local feedback: lift, pop, idle wobble
  mat: THREE.MeshPhysicalMaterial;
  outline: THREE.ShaderMaterial;
  home: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  phase: number;
  hover: number; // 0..1 smoothed feedback (hover × pinchStrength, 1 = held)
  pop: number;
  popV: number;
  delay: number; // arrange stagger
}

export default (): Experience => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.3 : 1;
  let renderer: THREE.WebGLRenderer;
  let envRT: THREE.WebGLRenderTarget | undefined;
  let prev: { shadow: boolean; type: THREE.ShadowMapType; tone: THREE.ToneMapping; exposure: number } | undefined;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.Fog(0x000000, 8, 22);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  let halfW = 4, halfH = 2.7;

  // Studio: one soft overhead key (pool of light + shadow on the floor), a cool rim from behind, room reflections.
  const key = new THREE.SpotLight(0xffffff, 2.6, 0, 0.55, 0.9, 0);
  key.position.set(2, 9, 6);
  key.target.position.set(0, FLOOR, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 3;
  key.shadow.camera.far = 25;
  key.shadow.bias = -0.0005;
  key.shadow.radius = 6;
  const rim = new THREE.DirectionalLight(0xbfd4ff, 1.1);
  rim.position.set(-3, 4, -6);
  scene.add(key, key.target, rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR;
  floor.receiveShadow = true;
  scene.add(floor);

  // ---- letters ----
  const letters: Letter[] = [];
  const items: Grabbable[] = [];
  for (const row of ROWS) {
    const rowW = row.text.reduce((w, ch) => w + WIDTH[ch], 0) + GAP * (row.text.length - 1);
    let x = -rowW / 2;
    for (const ch of row.text) {
      const geo = new THREE.ExtrudeGeometry(GLYPHS[ch](), { depth: 0.26, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.03, bevelSegments: 3, curveSegments: 28 });
      geo.scale(S, S, S);
      geo.center();
      // Outline hull pushes along averaged normals so hard edges don't crack open.
      const hull = geo.clone();
      hull.deleteAttribute('normal');
      hull.deleteAttribute('uv');
      const merged = mergeVertices(hull);
      hull.dispose();
      merged.computeVertexNormals();
      merged.setAttribute('smoothNormal', merged.getAttribute('normal'));

      const mat = new THREE.MeshPhysicalMaterial({ color: 0xf1ece4, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.25, emissive: ACCENT, emissiveIntensity: 0 });
      const outline = new THREE.ShaderMaterial({
        uniforms: { width: { value: 0 }, color: { value: ACCENT }, opacity: { value: 0 } },
        vertexShader: outlineVert,
        fragmentShader: outlineFrag,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      const hullMesh = new THREE.Mesh(merged, outline);
      hullMesh.visible = false;
      const body = new THREE.Group();
      body.add(mesh, hullMesh);
      const group = new THREE.Group();
      group.add(body);
      const home = new THREE.Vector3((x + WIDTH[ch] / 2) * S, row.y, 0);
      // Start loose: readable, but nudged out of line.
      group.position.set(home.x + (Math.random() - 0.5) * 0.7, home.y + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.6);
      group.rotation.set((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.5);
      scene.add(group);
      const item: Grabbable = { object: group, radius: RADIUS * 1.15 };
      items.push(item);
      letters.push({ item, group, body, mat, outline, home, vel: new THREE.Vector3(), spin: new THREE.Vector3(), phase: Math.random() * 100, hover: 0, pop: 1, popV: 0, delay: letters.length * 0.07 });
      x += WIDTH[ch] + GAP;
    }
  }
  const letterOf = (item: Grabbable) => letters.find((l) => l.item === item)!;

  const grabber = new Grabber(camera, items);
  grabber.onGrab = (item) => (letterOf(item).popV += 3);
  grabber.onRelease = (item, v) => {
    const l = letterOf(item);
    l.vel.copy(v).clampLength(0, 10);
    l.spin.set(-v.y, v.x, 0).multiplyScalar(0.35 * motion).clampLength(0, 6); // tumble along the throw
    l.popV -= 2.5; // soft squash on landing
  };

  // ---- 3D pinch cursors ----
  const cursorGeo = new THREE.PlaneGeometry(1, 1);
  const cursors = Array.from({ length: MAX_CURSORS }, () => {
    const m = new THREE.Mesh(
      cursorGeo,
      new THREE.ShaderMaterial({
        uniforms: { pinch: { value: 0 }, held: { value: 0 }, hover: { value: 0 }, progress: { value: 0 }, opacity: { value: 1 }, accent: { value: ACCENT } },
        vertexShader: cursorVert,
        fragmentShader: cursorFrag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    m.renderOrder = 10;
    m.visible = false;
    scene.add(m);
    return m;
  });

  const emptyHold = new Map<string, number>(); // hand id → seconds pinching empty space
  const fired = new Set<string>();
  let arrangeT = -1; // seconds since re-arrange started, -1 = idle
  let time = 0;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const IDENT = new THREE.Quaternion();
  const ONE = new THREE.Vector3(1, 1, 1);

  return {
    id: 'letters',
    title: meta.title,
    hint: { text: '글자를 집어서 새 단어를 만들어 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
      prev = { shadow: renderer.shadowMap.enabled, type: renderer.shadowMap.type, tone: renderer.toneMapping, exposure: renderer.toneMappingExposure };
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      envRT = pmrem.fromScene(room, 0.04);
      room.dispose();
      pmrem.dispose();
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.45;
    },
    frame(input, dt) {
      time += dt;
      grabber.update(input.hands, dt);

      // Empty pinch-and-hold → arrange back into the words.
      for (const id of emptyHold.keys()) if (!input.hands.some((h) => h.id === id)) emptyHold.delete(id);
      for (const h of input.hands) {
        if (h.gestures.pinch && !grabber.held.has(h.id)) {
          const t = (emptyHold.get(h.id) ?? 0) + dt;
          emptyHold.set(h.id, t);
          if (t >= HOLD_S && !fired.has(h.id)) {
            fired.add(h.id);
            arrangeT = 0;
            for (const l of letters) l.popV += 1.5;
          }
        } else {
          emptyHold.delete(h.id);
          fired.delete(h.id);
        }
      }
      if (arrangeT >= 0 && (arrangeT += dt) > ARRANGE_S) arrangeT = -1;

      // Separation: free letters step aside, held letters shove.
      for (let i = 0; i < letters.length; i++) {
        const a = letters[i], ha = grabber.isHeld(a.item);
        for (let j = i + 1; j < letters.length; j++) {
          const b = letters[j], hb = grabber.isHeld(b.item);
          if (ha && hb) continue;
          const minD = SEP * (a.group.scale.x + b.group.scale.x);
          tmp.subVectors(a.group.position, b.group.position);
          const d = tmp.length();
          if (d >= minD) continue;
          if (d < 1e-4) tmp.set(1, 0, 0);
          else tmp.divideScalar(d);
          const push = (minD - d) * 7 * dt;
          if (!ha) a.vel.addScaledVector(tmp, hb ? push * 2 : push);
          if (!hb) b.vel.addScaledVector(tmp, ha ? -push * 2 : -push);
        }
      }

      const damp = Math.exp(-1.4 * dt);
      for (const l of letters) {
        const g = l.group, held = grabber.isHeld(l.item);
        // Feedback target: hover rises with pinchStrength (anticipation), held = full.
        let target = 0;
        if (held) target = 1;
        else for (const h of input.hands) if (grabber.hovered.get(h.id) === l.item) target = Math.max(target, 0.35 + 0.55 * h.pinchStrength);
        l.hover += (target - l.hover) * (1 - Math.exp(-14 * dt));
        l.item.radius = RADIUS * 1.15 * g.scale.x;

        if (held) {
          l.vel.set(0, 0, 0);
          l.spin.set(0, 0, 0);
        } else {
          const arranging = arrangeT >= l.delay;
          if (arranging) {
            const k = 1 - Math.exp(-5 * dt);
            l.vel.addScaledVector(tmp.subVectors(l.home, g.position), 28 * dt).multiplyScalar(Math.exp(-8 * dt));
            g.quaternion.slerp(IDENT, k);
            g.scale.lerp(ONE, k);
            l.spin.multiplyScalar(Math.exp(-8 * dt));
          } else {
            // Idle drift: a slow wander that damping keeps small.
            const p = l.phase;
            l.vel.x += Math.sin(time * 0.31 + p) * 0.12 * motion * dt;
            l.vel.y += Math.cos(time * 0.43 + p * 1.7) * 0.14 * motion * dt;
            l.vel.z += Math.sin(time * 0.23 + p * 0.6) * 0.1 * motion * dt;
            l.vel.multiplyScalar(damp);
          }
          // Soft walls: screen edges, floor, depth.
          const r = RADIUS * g.scale.x;
          const pos = g.position;
          const xLim = halfW - r, yLo = FLOOR + r * 1.2, yHi = halfH - r * 0.5;
          if (pos.x > xLim) l.vel.x -= (pos.x - xLim) * 10 * dt;
          if (pos.x < -xLim) l.vel.x -= (pos.x + xLim) * 10 * dt;
          if (pos.y > yHi) l.vel.y -= (pos.y - yHi) * 10 * dt;
          if (pos.y < yLo) l.vel.y -= (pos.y - yLo) * 14 * dt;
          if (pos.z > 2.5) l.vel.z -= (pos.z - 2.5) * 10 * dt;
          if (pos.z < -4) l.vel.z -= (pos.z + 4) * 10 * dt;
          pos.addScaledVector(l.vel, dt);
          const w = l.spin.length();
          if (w > 1e-4) {
            q.setFromAxisAngle(tmp2.copy(l.spin).divideScalar(w), w * dt);
            g.quaternion.premultiply(q);
            l.spin.multiplyScalar(Math.exp(-1.8 * dt));
          }
        }

        // Body: lift toward the camera on hover, pop spring, idle wobble.
        // Stiff spring: substep so frame drops (dt up to 0.1) can't blow it up.
        const steps = Math.ceil(dt * 120);
        for (let s = 0, h = dt / steps; s < steps; s++) {
          l.popV += ((1 + 0.06 * l.hover - l.pop) * 220 - l.popV * 14) * h;
          l.pop += l.popV * h;
        }
        l.body.scale.setScalar(l.pop);
        l.body.position.z = l.hover * 0.35;
        const wob = (1 - l.hover) * motion;
        l.body.rotation.set(Math.sin(time * 0.5 + l.phase) * 0.08 * wob, Math.sin(time * 0.37 + l.phase * 1.3) * 0.12 * wob, 0);
        l.mat.emissiveIntensity = held ? 0.55 : l.hover * 0.12;
        l.outline.uniforms.width.value = 0.012 + 0.03 * l.hover;
        l.outline.uniforms.opacity.value = Math.min(1, l.hover * 1.6);
        (l.body.children[1] as THREE.Mesh).visible = l.hover > 0.02;
      }

      // 3D pinch cursors: at the hovered/held letter depth, else on the z=0 plane.
      let n = 0;
      for (const h of input.hands) {
        if (n >= MAX_CURSORS) break;
        const c = cursors[n++];
        const p = grabber.points.get(h.id);
        if (p) c.position.copy(p);
        else {
          const ray = grabber.rayAt(h.pinchPoint.x, h.pinchPoint.y);
          c.position.copy(ray.origin).addScaledVector(ray.direction, ray.direction.z < -1e-3 ? -ray.origin.z / ray.direction.z : 8);
        }
        c.quaternion.copy(camera.quaternion);
        c.scale.setScalar(c.position.distanceTo(camera.position) * 0.05);
        const u = (c.material as THREE.ShaderMaterial).uniforms;
        u.pinch.value = h.pinchStrength;
        u.held.value = grabber.held.has(h.id) ? 1 : 0;
        u.hover.value = grabber.hovered.has(h.id) ? 1 : 0;
        u.progress.value = fired.has(h.id) ? 1 : Math.min(1, Math.max(0, ((emptyHold.get(h.id) ?? 0) - 0.15) / (HOLD_S - 0.15)));
        u.opacity.value = fired.has(h.id) ? 0.6 : 1;
        c.visible = true;
      }
      for (; n < MAX_CURSORS; n++) cursors[n].visible = false;

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      const aspect = width / height;
      halfH = Math.max(2.7, 3.1 / aspect); // fit the 'MOVE' row on portrait screens
      halfW = halfH * aspect;
      const d = halfH / Math.tan(THREE.MathUtils.degToRad(20));
      camera.aspect = aspect;
      camera.position.set(0, 0.7, d);
      camera.lookAt(0, -0.3, 0);
      camera.updateProjectionMatrix();
      const fog = scene.fog as THREE.Fog;
      fog.near = d + 1;
      fog.far = d + 16;
    },
    dispose() {
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      });
      key.shadow.map?.dispose();
      envRT?.dispose();
      if (prev && renderer) {
        renderer.shadowMap.enabled = prev.shadow;
        renderer.shadowMap.type = prev.type;
        renderer.toneMapping = prev.tone;
        renderer.toneMappingExposure = prev.exposure;
      }
    },
  };
};
