import * as THREE from 'three';
import type { Experience, Hand } from '../../core/types.ts';
import meta from './meta.ts';

// A fogged window over a warm poster. Fog amount lives in a 1/4-res ping-pong target (r = fog, g = wet bead).
// A pinch writes a crisp thin line (fingertip on a fogged window; closing fingers first breathe a faint clear spot),
// an open palm wipes wide, a pressed pointer writes and scrubs wide when swiped. CPU drips run down and leave
// streaks, fog re-condenses in ~6 s.
const MAX_HANDS = 8;
const MAX_SEGS = 64;
const MAX_DRIPS = 16;
const TIPS = [4, 8, 12, 16, 20];
const LINE_R = 0.009; // pinch-writing half width, screen heights
const REFOG_SECONDS = 6;
const POSTER_BG = '#ff5533';
const POSTER_INK = '#121519';
const POSTER_CREAM = '#fff1de';
const FONT = '"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';

const vertexShader = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

interface HandState { tips: Float32Array; palm: Float32Array; line: Float32Array; drawing: boolean; stamp: number }

export default (): Experience => {
  let renderer: THREE.WebGLRenderer;
  let read!: THREE.WebGLRenderTarget;
  let write!: THREE.WebGLRenderTarget;
  let poster: THREE.CanvasTexture | null = null;
  const canvas = document.createElement('canvas');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduced ? 0.5 : 1;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      state: { value: null as THREE.Texture | null },
      dt: { value: 0 },
      aspect: { value: 1 },
      reset: { value: 1 },
      count: { value: 0 },
      segs: { value: Array.from({ length: MAX_SEGS }, () => new THREE.Vector4()) }, // a.xy, b.xy in uv (y up)
      params: { value: Array.from({ length: MAX_SEGS }, () => new THREE.Vector3()) }, // radius, erase, bead
    },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D state;
      uniform float dt, aspect, reset;
      uniform int count;
      uniform vec4 segs[${MAX_SEGS}];
      uniform vec3 params[${MAX_SEGS}];
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
      }
      void main() {
        if (reset > 0.5) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }
        vec2 s = texture2D(state, vUv).rg;
        vec2 k = vec2(aspect, 1.0);
        vec2 p = vUv * k;
        // Uneven re-condensation: blotchy rate so fog creeps back in patches.
        float v = vnoise(p * 5.0) * 0.6 + vnoise(p * 17.0) * 0.4;
        float fog = min(1.0, s.r + dt * (0.5 + v) / ${REFOG_SECONDS.toFixed(1)});
        float bead = max(0.0, s.g - dt * 0.7);
        for (int i = 0; i < ${MAX_SEGS}; i++) {
          if (i >= count) break;
          vec2 a = segs[i].xy * k, ab = segs[i].zw * k - a;
          float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
          float d = length(p - a - ab * t), r = params[i].x;
          float w = 1.0 - smoothstep(r * 0.55, r, d);
          fog *= 1.0 - w * params[i].y;
          bead = max(bead, w * params[i].z);
        }
        gl_FragColor = vec4(fog, bead, 0.0, 1.0);
      }`,
  });

  const viewMat = new THREE.ShaderMaterial({
    uniforms: {
      fogTex: { value: null as THREE.Texture | null },
      poster: { value: null as THREE.Texture | null },
      texel: { value: new THREE.Vector2() },
      aspect: { value: 1 },
      spots: { value: Array.from({ length: MAX_HANDS }, () => new THREE.Vector4()) }, // x, y (uv), radius, amount
    },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform sampler2D fogTex, poster;
      uniform vec2 texel;
      uniform float aspect;
      uniform vec4 spots[${MAX_HANDS}];
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      vec3 hash3(vec2 p) {
        return fract(sin(vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)))) * 43758.5453);
      }
      // Static condensation droplets on one grid layer; returns offset from droplet center (in radii) and coverage.
      vec3 droplet(vec2 q, float density) {
        vec2 id = floor(q);
        vec3 h = hash3(id);
        vec2 dv = (fract(q) - 0.5 - (h.xy - 0.5) * 0.5) / (0.1 + 0.28 * h.z * h.z);
        return vec3(dv, step(dot(dv, dv), 1.0) * step(1.0 - density, hash(id + 7.3)));
      }
      void main() {
        vec2 c = texture2D(fogTex, vUv).rg;
        vec2 e = texture2D(fogTex, vUv + vec2(texel.x, 0.0)).rg, w = texture2D(fogTex, vUv - vec2(texel.x, 0.0)).rg;
        vec2 n = texture2D(fogTex, vUv + vec2(0.0, texel.y)).rg, s = texture2D(fogTex, vUv - vec2(0.0, texel.y)).rg;
        float f = (c.r * 2.0 + e.r + w.r + n.r + s.r) / 6.0;
        // Breath spots: fog thins softly under fingers that are about to touch the glass (display only).
        for (int i = 0; i < ${MAX_HANDS}; i++) {
          vec4 sp = spots[i];
          if (sp.w <= 0.0) continue;
          float d = length((vUv - sp.xy) * vec2(aspect, 1.0)) / sp.z;
          f *= 1.0 - sp.w * exp(-d * d * 2.0);
        }
        vec2 fg = vec2(e.r - w.r, n.r - s.r);
        vec2 bg = vec2(e.g - w.g, n.g - s.g);
        float bead = c.g;

        vec2 k = vec2(aspect, 1.0);
        vec3 d1 = droplet(vUv * k * 90.0, 0.55);
        vec3 d2 = droplet(vUv * k * 34.0 + 3.1, 0.2);
        vec3 dr = d2.z > 0.0 ? d2 : d1;
        float drop = dr.z * smoothstep(0.35, 0.8, f);

        // Refraction: droplets lens, wet bead trails bend, fog rims bend slightly.
        vec2 refr = -dr.xy * drop * 0.004 - bg * 0.02 - fg * 0.01;
        vec3 sharp = texture2D(poster, vUv + refr).rgb;

        // Frosted glass: jittered disk taps on a mip-biased poster.
        float ang = hash(gl_FragCoord.xy) * 6.2831853;
        vec3 blur = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          float fi = float(i);
          float a = ang + fi * 2.3999632;
          vec2 o = vec2(cos(a), sin(a)) * 0.024 * sqrt((fi + 0.5) / 8.0) / k;
          blur += texture2D(poster, vUv + o, 2.5).rgb;
        }
        blur /= 8.0;
        vec3 fogCol = mix(vec3(0.56, 0.63, 0.69), vec3(0.72, 0.78, 0.82), vUv.y);
        vec3 frost = mix(blur, fogCol, 0.6) + (hash(gl_FragCoord.xy + 1.7) - 0.5) * 0.035;
        // Droplets are clearer lenses with a bright top-left rim and a dark lower edge.
        frost = mix(frost, mix(sharp, fogCol, 0.3), drop * 0.75);
        frost += drop * (0.22 * smoothstep(0.3, 1.0, dot(dr.xy, vec2(-0.6, 0.8))) - 0.08 * smoothstep(0.4, 1.0, -dr.y));

        vec3 col = mix(sharp, frost, smoothstep(0.08, 0.8, f));
        // Water pushed to the edge of a wipe: a faint bright rim.
        col += vec3(0.9, 0.95, 1.0) * 0.18 * smoothstep(0.03, 0.3, length(fg)) * smoothstep(0.15, 0.5, f);
        // Running drips: a glossy bead lit from the upper left.
        vec3 nrm = normalize(vec3(-bg * 3.0, 1.0));
        float spec = pow(max(dot(nrm, normalize(vec3(-0.35, 0.45, 1.0))), 0.0), 40.0);
        col += vec3(1.0) * spec * bead * 0.5 + vec3(0.85, 0.92, 1.0) * 0.08 * bead;

        float vig = smoothstep(1.35, 0.35, length((vUv - 0.5) * k));
        gl_FragColor = vec4(col * mix(0.72, 1.0, vig), 1.0);
      }`,
  });

  const simScene = new THREE.Scene().add(new THREE.Mesh(geometry, simMat));
  const viewScene = new THREE.Scene().add(new THREE.Mesh(geometry, viewMat));
  const su = simMat.uniforms;
  const vu = viewMat.uniforms;

  const state = new Map<string, HandState>();
  let stamp = 0;
  let count = 0;
  let aspect = 1;
  let time = 0;
  let idle = 0;
  let frameScale = 1;
  const ghost = new Float32Array(2);
  let nspot = 0;

  // Drips as a fixed pool: position (uv, y up), speed, radius, phase seed, remaining life.
  const dx = new Float32Array(MAX_DRIPS), dy = new Float32Array(MAX_DRIPS);
  const dSpd = new Float32Array(MAX_DRIPS), dRad = new Float32Array(MAX_DRIPS);
  const dSeed = new Float32Array(MAX_DRIPS), dLife = new Float32Array(MAX_DRIPS);

  // Per-frame erase amount, frame-rate independent.
  const erase = (base: number) => 1 - Math.pow(1 - base, frameScale);

  const seg = (ax: number, ay: number, bx: number, by: number, radius: number, strength: number, bead: number) => {
    if (count >= MAX_SEGS || strength <= 0) return;
    su.segs.value[count].set(ax, ay, bx, by);
    su.params.value[count].set(radius, strength, bead);
    count++;
  };

  const spawnDrip = (x: number, y: number) => {
    for (let i = 0; i < MAX_DRIPS; i++) {
      if (dLife[i] > 0) continue;
      dx[i] = x;
      dy[i] = y;
      dSpd[i] = (0.04 + Math.random() * 0.08) * motion;
      dRad[i] = 0.0035 + Math.random() * 0.003;
      dSeed[i] = Math.random();
      dLife[i] = 2 + Math.random() * 3;
      return;
    }
  };

  // Wipe along last→current; drips occasionally start at the lower edge of the swath.
  const wipe = (st: Float32Array, o: number, x: number, y: number, radius: number, gate: number, dt: number, dripRate: number) => {
    const speed = Math.hypot((x - st[o]) * aspect, y - st[o + 1]) / Math.max(dt, 1e-3);
    const s = Math.min(Math.max((speed - 0.04) / 0.2, 0), 1) * gate;
    seg(st[o], st[o + 1], x, y, radius, erase(0.85) * s, 0.2 * s);
    if (s > 0.3 && Math.random() < dt * dripRate * motion) spawnDrip(x + (Math.random() - 0.5) * radius / aspect, y - radius * 0.8);
    st[o] = x;
    st[o + 1] = y;
  };

  // Pinch writing: a full-strength thin segment from the last pinch point; a drip may run from the stroke.
  const writeLine = (st: HandState, x: number, y: number, pinch: boolean, dt: number) => {
    if (pinch) {
      if (!st.drawing) (st.line[0] = x), (st.line[1] = y), (st.drawing = true);
      const moved = Math.hypot((x - st.line[0]) * aspect, y - st.line[1]);
      seg(st.line[0], st.line[1], x, y, LINE_R, 1, 0.6);
      if (moved > 0.002 && Math.random() < dt * 0.5 * motion) spawnDrip(x, y - LINE_R);
      st.line[0] = x;
      st.line[1] = y;
    } else if (st.drawing) {
      st.drawing = false;
      if (Math.random() < 0.6 * motion) spawnDrip(st.line[0], st.line[1] - LINE_R); // water gathers where the stroke ends
    }
  };

  // Anticipation spot: wide and faint as fingers start to close, tight while writing.
  const spot = (x: number, y: number, strength: number, drawing: boolean) => {
    const a = drawing ? 0.5 : Math.min(Math.max((strength - 0.25) / 0.75, 0), 1) * 0.45;
    if (a <= 0 || nspot >= MAX_HANDS) return;
    vu.spots.value[nspot++].set(x, y, drawing ? 0.02 : 0.06 - 0.035 * a / 0.45, a);
  };

  const handWipe = (hand: Hand, dt: number) => {
    let st = state.get(hand.id);
    const fresh = !st;
    if (!st) state.set(hand.id, (st = { tips: new Float32Array(10), palm: new Float32Array(2), line: new Float32Array(2), drawing: false, stamp }));
    st.stamp = stamp;
    const g = hand.gestures;
    if (hand.kind === 'pointer') {
      const x = hand.cursor.x, y = 1 - hand.cursor.y;
      if (fresh) (st.tips[0] = x), (st.tips[1] = y);
      // Pressed = writing; pressed and swiped fast = a wide scrub (the mouse's palm). Hover leaves the glass alone.
      const scrub = g.pinch && g.swipe;
      writeLine(st, x, y, g.pinch && !scrub, dt);
      wipe(st.tips, 0, x, y, 0.075, scrub ? 1 : 0, dt, 2.5);
      spot(x, y, 0, st.drawing);
      return;
    }
    const lm = hand.landmarks;
    const open = g.open && !g.pinch;
    const qx = hand.pinchPoint.x, qy = 1 - hand.pinchPoint.y;
    writeLine(st, qx, qy, g.pinch && !g.fist, dt); // a fist can read as a pinch; don't let it stamp dots
    spot(qx, qy, hand.pinchStrength, st.drawing);
    // Fingertips wipe only with the palm, so stray fingers don't smudge the writing.
    for (let t = 0; t < TIPS.length; t++) {
      const p = lm[TIPS[t]];
      if (fresh) { st.tips[t * 2] = p.x; st.tips[t * 2 + 1] = 1 - p.y; }
      wipe(st.tips, t * 2, p.x, 1 - p.y, 0.022, open ? 1 : 0, dt, 0.4);
    }
    const a = lm[0], b = lm[9];
    const px = a.x * 0.35 + b.x * 0.65, py = 1 - (a.y * 0.35 + b.y * 0.65);
    if (fresh) { st.palm[0] = px; st.palm[1] = py; }
    const r = Math.min(Math.max(Math.hypot((b.x - a.x) * aspect, b.y - a.y) * 1.1, 0.05), 0.16);
    wipe(st.palm, 0, px, py, r, open ? 1 : 0, dt, 3);
  };

  const drawPoster = (width: number, height: number) => {
    const scale = Math.min(1, 2048 / Math.max(width, height));
    const W = (canvas.width = Math.max(1, Math.round(width * scale)));
    const H = (canvas.height = Math.max(1, Math.round(height * scale)));
    const g = canvas.getContext('2d')!;
    const font = (px: number, weight: number) => `${weight} ${px}px ${FONT}`;
    const fit = (text: string, maxW: number, maxH: number) => {
      g.font = font(100, 900);
      return Math.min(maxH, (100 * maxW) / g.measureText(text).width);
    };
    const m = Math.min(W, H) * 0.06;
    const small = Math.max(12, Math.min(W, H) * 0.028);
    g.fillStyle = POSTER_BG;
    g.fillRect(0, 0, W, H);

    g.fillStyle = POSTER_INK;
    g.textBaseline = 'top';
    g.font = font(small, 700);
    g.textAlign = 'left';
    g.fillText('fogged typography', m, m);
    g.textAlign = 'right';
    g.fillText('no. 05', W - m, m);

    g.textAlign = 'left';
    const ko = fit('움직임', W - 2 * m, H * 0.42);
    g.font = font(ko, 900);
    g.fillText('움직임', m - ko * 0.04, m + small * 2);

    g.textBaseline = 'alphabetic';
    const en = fit('MOVE', W - 2 * m, H * 0.48);
    g.fillStyle = POSTER_CREAM;
    g.font = font(en, 900);
    g.fillText('MOVE', m - en * 0.03, H - m - small * 2.2);

    g.fillStyle = POSTER_INK;
    g.font = font(small, 700);
    g.fillText(meta.date, m, H - m);
    g.textAlign = 'right';
    g.fillText('wipe the window', W - m, H - m);

    // shortcut: new texture per resize, since three keeps immutable storage sized to the first upload.
    poster?.dispose();
    poster = new THREE.CanvasTexture(canvas);
    vu.poster.value = poster;
  };

  return {
    id: 'wiper',
    title: meta.title,
    hint: { text: '손가락을 집어 성에 위에 글씨를 쓰고, 손바닥으로 닦아 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      dt = Math.min(dt, 0.1);
      time += dt;
      frameScale = Math.min(dt * 60, 3);
      stamp++;
      count = 0;
      nspot = 0;

      const n = Math.min(input.hands.length, MAX_HANDS);
      for (let i = 0; i < n; i++) handWipe(input.hands[i], dt);
      for (let i = nspot; i < MAX_HANDS; i++) vu.spots.value[i].w = 0;
      for (const [id, st] of state) {
        if (st.stamp === stamp) continue;
        writeLine(st, 0, 0, false, dt); // a lifted touch ends its stroke
        state.delete(id);
      }

      // Idle: after a few seconds without hands an unseen finger wanders over the glass, so the poster peeks through.
      idle = n === 0 ? idle + dt : 0;
      const gt = time * 0.25 * motion;
      const gx = 0.5 + 0.36 * Math.sin(gt * 1.3), gy = 0.5 + 0.28 * Math.sin(gt * 2.1 + 1.0);
      if (idle > 3) {
        const s = Math.min((idle - 3) / 2, 1);
        seg(ghost[0], ghost[1], gx, gy, 0.05, erase(0.5) * s, 0.15 * s);
        if (Math.random() < dt * 0.8 * motion) spawnDrip(gx, gy - 0.04);
      }
      ghost[0] = gx;
      ghost[1] = gy;
      // Heavy condensation occasionally runs on its own.
      if (Math.random() < dt * 0.35 * motion) spawnDrip(Math.random(), 0.3 + Math.random() * 0.7);

      // Drips: stop-and-go fall with a slight wobble, each step erases a thin wet streak.
      for (let i = 0; i < MAX_DRIPS; i++) {
        if (dLife[i] <= 0) continue;
        const px = dx[i], py = dy[i];
        const go = 0.5 + 0.5 * Math.sin(time * 2.3 + dSeed[i] * 40);
        dy[i] -= dt * dSpd[i] * (0.15 + go * go);
        dx[i] += Math.sin(time * 1.7 + dSeed[i] * 20) * 0.004 * dt;
        dLife[i] -= dt;
        if (dy[i] < -0.02) dLife[i] = 0;
        seg(px, py, dx[i], dy[i], dRad[i], erase(0.9), 1);
      }

      su.count.value = count;
      su.dt.value = dt;
      su.state.value = read.texture;
      renderer.setRenderTarget(write);
      renderer.render(simScene, camera);
      [read, write] = [write, read];
      su.reset.value = 0;

      vu.fogTex.value = read.texture;
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
      su.reset.value = 1; // new targets start fully fogged
      vu.texel.value.set(1 / w, 1 / h);
      aspect = su.aspect.value = vu.aspect.value = width / height;
      drawPoster(width, height);
    },
    dispose() {
      read?.dispose();
      write?.dispose();
      poster?.dispose();
      geometry.dispose();
      simMat.dispose();
      viewMat.dispose();
    },
  };
};
