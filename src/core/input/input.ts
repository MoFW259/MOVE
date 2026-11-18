import * as THREE from 'three';
import type { Hand, InputFrame, Need, Point3 } from '../types.ts';
import { GestureState, THRESHOLDS, noGestures, pinchStrength } from './gestures.ts';
import { OneEuro } from './oneEuro.ts';
import { VideoSource } from './video.ts';
import { matchNearest } from './track.ts';
import type * as Vision from './vision.ts';
import type { Detection } from './vision.ts';
const MATCH_DIST = 0.2; // max wrist jump between detections (~6 units/s at 30 fps)
// shortcut: defaults picked for normalized coords without measurement; tune in M0 with fixtures.
const DEFAULT_FILTER = { minCutoff: 1.2, beta: 3 };

interface Tracked { filters: OneEuro[]; gestures: GestureState; hand: Hand }
interface PointerState { x: number; y: number; down: boolean; touch: boolean; hand?: Hand }

const mirror = (p: { x: number; y: number; z: number }): Point3 => ({ x: 1 - p.x, y: p.y, z: p.z });

/** Turns webcam/fixture/pointer into InputFrames. Lives for the whole app (IN-1, SHELL-3). */
export class Input {
  readonly source = new VideoSource();
  /** Last detection, raw, for the debug overlay. */
  last: Detection = {};
  stats = { detectMs: 0, detectFps: 0 };

  private tracked = new Map<string, Tracked>();
  private pointers = new Map<number, PointerState>();
  private frame: InputFrame = { time: 0, source: 'pointer', hands: [] };
  private lastVideoTime = -1;
  private lastDetect = 0;
  private nextHandId = 0;
  private vision?: typeof Vision;
  private visionLoad?: Promise<unknown>;

  private videoTex = new THREE.VideoTexture(this.source.video);
  private mirrorRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private mirrorScene = new THREE.Scene();
  private mirrorCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private maskTex?: THREE.DataTexture;
  private renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.videoTex.colorSpace = THREE.SRGBColorSpace;
    this.mirrorRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.mirrorScene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { map: { value: this.videoTex } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = vec2(1.0 - uv.x, uv.y); gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv); }',
      }),
    ));

    const el = renderer.domElement.ownerDocument;
    const onPointer = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId) ?? { x: 0, y: 0, down: false, touch: e.pointerType !== 'mouse' };
      p.x = e.clientX / innerWidth;
      p.y = e.clientY / innerHeight;
      if (e.type === 'pointerdown') p.down = true;
      if (e.type === 'pointerup') p.down = false;
      if (e.type === 'pointercancel' || (p.touch && e.type === 'pointerup')) this.pointers.delete(e.pointerId);
      else this.pointers.set(e.pointerId, p);
    };
    for (const t of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'] as const) el.addEventListener(t, onPointer);
    el.documentElement.addEventListener('pointerleave', (e) => this.pointers.delete(e.pointerId));
  }

  update(time: number, dt: number, needs: Need[], filter = DEFAULT_FILTER): InputFrame {
    const f = this.frame;
    f.time = time;
    f.source = this.source.kind === 'off' ? 'pointer' : this.source.kind;

    if (this.source.ready) {
      // Hands always run with a camera so the shell can offer pinch navigation (SHELL-4).
      const all = new Set<Need>([...needs, 'hands']);
      // MediaPipe bundle loads only once a video source exists (PRD §7: fast first screen).
      if (!this.vision) this.visionLoad ??= import('./vision.ts').then((m) => (this.vision = m));
      else this.vision.ensure(all);
      const v = this.source.video;
      if (v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        const t0 = performance.now();
        this.last = this.vision?.detect(v, t0, all) ?? {};
        this.stats.detectMs = performance.now() - t0;
        this.stats.detectFps += (1000 / Math.max(1, t0 - this.lastDetect) - this.stats.detectFps) * 0.1;
        const detectDt = (t0 - this.lastDetect) / 1000;
        this.lastDetect = t0;
        this.applyDetection(detectDt, filter, needs);
        this.renderMirror();
      }
      f.camera = this.mirrorRT.texture;
    } else {
      this.last = {};
      this.tracked.clear();
      f.camera = f.mask = f.pose = f.face = undefined;
    }

    f.hands = [...[...this.tracked.values()].map((t) => t.hand), ...this.pointerHands(dt)];
    return f;
  }

  private applyDetection(dt: number, filter: { minCutoff: number; beta: number }, needs: Need[]): void {
    const d = this.last;
    const f = this.frame;

    // Stable ids by nearest wrist: handedness labels collide once several people are in frame.
    const raws = d.hands?.landmarks ?? [];
    const prev = [...this.tracked.values()];
    const match = matchNearest(prev.map((t) => t.hand.landmarks[0]), raws.map((r) => mirror(r[0])), MATCH_DIST);
    const next = new Map<string, Tracked>();
    raws.forEach((raw, i) => {
      const id = prev[match[i]]?.hand.id ?? `hand-${this.nextHandId++}`;
      const t: Tracked = prev[match[i]] ?? {
        filters: Array.from({ length: raw.length * 3 }, () => new OneEuro()),
        gestures: new GestureState(),
        hand: { id, kind: 'tracked', cursor: { x: 0, y: 0, z: 0 }, pinchPoint: { x: 0, y: 0, z: 0 }, pinchStrength: 0, size: 0, landmarks: [], velocity: { x: 0, y: 0 }, gestures: noGestures() },
      };
      next.set(id, t);
      for (const fl of t.filters) { fl.minCutoff = filter.minCutoff; fl.beta = filter.beta; }
      const lm = raw.map((p, j) => {
        const m = mirror(p);
        return { x: t.filters[j * 3].filter(m.x, dt), y: t.filters[j * 3 + 1].filter(m.y, dt), z: t.filters[j * 3 + 2].filter(m.z, dt) };
      });
      const h = t.hand;
      const fresh = h.landmarks.length === 0;
      const vx = fresh || dt <= 0 ? 0 : (lm[0].x - h.landmarks[0].x) / dt;
      const vy = fresh || dt <= 0 ? 0 : (lm[0].y - h.landmarks[0].y) / dt;
      h.velocity = { x: vx, y: vy };
      h.landmarks = lm;
      h.cursor = lm[8];
      h.pinchPoint = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2, z: (lm[4].z + lm[8].z) / 2 };
      h.size = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
      h.pinchStrength = pinchStrength(lm);
      h.gestures = t.gestures.update(lm, Math.hypot(vx, vy));
    });
    this.tracked = next;

    f.pose = needs.includes('pose') ? d.pose?.landmarks[0]?.map(mirror) : undefined;
    const face = needs.includes('face') ? d.face : undefined;
    f.face = face?.faceLandmarks[0] && {
      landmarks: face.faceLandmarks[0].map(mirror),
      blendshapes: Object.fromEntries((face.faceBlendshapes[0]?.categories ?? []).map((c) => [c.categoryName, c.score])),
    };
    f.mask = needs.includes('segmentation') && d.mask ? this.uploadMask(d.mask) : undefined;
  }

  /** Mirrors X and flips rows so the mask matches the camera texture's GL orientation. */
  private uploadMask({ data, width, height }: NonNullable<Detection['mask']>): THREE.DataTexture {
    let tex = this.maskTex;
    if (!tex || tex.image.width !== width || tex.image.height !== height) {
      tex?.dispose();
      tex = this.maskTex = new THREE.DataTexture(new Uint8Array(width * height), width, height, THREE.RedFormat);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
    }
    const out = tex.image.data as Uint8Array;
    for (let y = 0; y < height; y++) {
      const src = y * width, dst = (height - 1 - y) * width + width - 1;
      for (let x = 0; x < width; x++) out[dst - x] = data[src + x] * 255;
    }
    tex.needsUpdate = true;
    return tex;
  }

  private renderMirror(): void {
    const v = this.source.video;
    if (this.mirrorRT.width !== v.videoWidth || this.mirrorRT.height !== v.videoHeight) this.mirrorRT.setSize(v.videoWidth, v.videoHeight);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.mirrorRT);
    this.renderer.render(this.mirrorScene, this.mirrorCam);
    this.renderer.setRenderTarget(prev);
  }

  private pointerHands(dt: number): Hand[] {
    const out: Hand[] = [];
    for (const [id, p] of this.pointers) {
      const cursor = { x: p.x, y: p.y, z: 0 };
      const h = (p.hand ??= { id: `pointer-${id}`, kind: 'pointer', cursor, pinchPoint: cursor, pinchStrength: 0, size: 0, landmarks: [], velocity: { x: 0, y: 0 }, gestures: noGestures() });
      if (dt > 0) {
        h.velocity.x += ((p.x - h.cursor.x) / dt - h.velocity.x) * 0.3;
        h.velocity.y += ((p.y - h.cursor.y) / dt - h.velocity.y) * 0.3;
      }
      h.cursor = h.pinchPoint = cursor;
      h.pinchStrength = p.down ? 1 : 0;
      h.landmarks = Array.from({ length: 21 }, () => cursor);
      // Pointer vocabulary: pressed = pinch + fist (grab), released = open + point.
      const g = h.gestures;
      g.pinch = g.fist = p.down;
      g.open = g.point = !p.down;
      const speed = Math.hypot(h.velocity.x, h.velocity.y);
      g.swipe = g.swipe ? speed > THRESHOLDS.swipe[1] : speed > THRESHOLDS.swipe[0];
      out.push(h);
    }
    return out;
  }
}
