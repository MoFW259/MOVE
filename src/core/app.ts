import * as THREE from 'three';
import { DebugOverlay } from './debug.ts';
import { Input } from './input/input.ts';
import { href, params, parseRoute } from './router.ts';
import { drawHandFlesh, drawSkeleton } from './skeleton.ts';
import type { Experience, GestureName, Hand, InputFrame } from './types.ts';
import * as curtain from '../main/curtain.ts';
import { createGrid, metaOf } from '../main/grid.ts';

/** Each experience folder default-exports a factory; a fresh instance is created per visit. */
type Factory = () => Experience;
const modules = import.meta.glob<{ default: Factory }>('../experiences/*/index.ts');

const GESTURE_ICON: Record<GestureName, string> = { open: '✋', fist: '✊', pinch: '🤏', point: '☝️', swipe: '👋' };
const HINT_MS = 5000;
const LOST_MS = 1000;
const MAGNET = 40; // px: a hand cursor this close to a target's rect hovers it
const PULL = 0.35; // how far the drawn cursor leans toward the hovered target's center
const HAND_VIEWS = { flesh: '가상 손', off: '끄기', skeleton: '뼈대' } as const; // cycle order of the 손 표시 button
type HandView = keyof typeof HAND_VIEWS;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function start(): void {
  if (!document.createElement('canvas').getContext('webgl2')) {
    $('nogl').hidden = false; // SHELL-9
    $('camera').hidden = true;
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  $('stage').append(renderer.domElement);

  const input = new Input(renderer);
  const debug = params().has('debug') ? new DebugOverlay() : undefined;

  let current: Experience | undefined;
  let visit = 0; // guards against a slow init finishing after the user already left
  let hintUntil = 0;
  let lastTracked = 0;
  let consentAsked = false;

  // --- toast / camera ---------------------------------------------------------
  let toastTimer = 0;
  const toast = (msg: string) => {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (el.hidden = true), 4000);
  };
  const preview = $('preview');
  const previewToggle = $('preview-toggle');
  const handViewButton = $('hand-view');
  preview.append(input.source.video);
  const syncCameraButton = () => {
    const off = input.source.kind === 'off';
    $('camera').textContent = off ? '카메라로 조작하기' : '카메라 끄기';
    document.body.classList.toggle('hands-on', !off); // bigger hit targets for hand cursors
    previewToggle.hidden = handViewButton.hidden = off;
    if (off) preview.hidden = true;
    previewToggle.textContent = preview.hidden ? '내 화면 보기' : '내 화면 숨기기';
    previewToggle.setAttribute('aria-pressed', String(!preview.hidden));
  };
  previewToggle.onclick = () => {
    preview.hidden = !preview.hidden;
    syncCameraButton();
  };

  // How tracked hands are drawn over the piece; the preview window always shows the skeleton.
  const savedView = localStorage.getItem('move.handView');
  let handView: HandView = savedView === 'skeleton' || savedView === 'off' ? savedView : 'flesh';
  handViewButton.textContent = `손 표시: ${HAND_VIEWS[handView]}`;
  handViewButton.onclick = () => {
    const views = Object.keys(HAND_VIEWS) as HandView[];
    handView = views[(views.indexOf(handView) + 1) % views.length];
    localStorage.setItem('move.handView', handView);
    handViewButton.textContent = `손 표시: ${HAND_VIEWS[handView]}`;
  };

  const askConsent = () => {
    consentAsked = true;
    $('consent').hidden = false;
    $('consent-yes').focus();
  };
  $('consent-yes').onclick = async () => {
    $('consent').hidden = true;
    if (!(await input.source.startCamera())) toast('카메라를 사용할 수 없어 마우스/터치 모드로 전환했습니다.'); // SHELL-2
    syncCameraButton();
  };
  $('consent-no').onclick = () => {
    $('consent').hidden = true;
    toast('마우스/터치 모드로 체험합니다.');
  };
  $('camera').onclick = () => {
    if (input.source.kind === 'off') return askConsent();
    input.source.stop(); // SHELL-3: stop immediately when the user turns it off
    syncCameraButton();
  };

  const src = params().get('src');
  if (src?.startsWith('fixture:')) {
    consentAsked = true;
    input.source.startFixture(src.slice('fixture:'.length)).then(syncCameraButton, (e) => toast(`녹화 영상을 열 수 없습니다: ${e.message ?? e}`));
  }

  // --- routing ----------------------------------------------------------------
  const grid = createGrid($('main'));
  let lastExp: string | undefined; // piece we are leaving, so the curtain can shrink back into its poster

  const goMain = () => {
    location.hash = href('/main');
  };
  $('back').onclick = goMain;
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('consent').hidden) $('consent-no').click();
    else if (current) goMain();
  });

  async function route(): Promise<void> {
    const r = parseRoute();
    const myVisit = ++visit;
    current?.dispose();
    current = undefined;
    $('hint').hidden = true;
    $('back').hidden = $('exp-title').hidden = r.page === 'main';
    if (r.page === 'main') {
      grid.show(lastExp);
      lastExp = undefined;
      return;
    }
    grid.hide();

    const load = modules[`../experiences/${r.id}/index.ts`];
    if (!load) return location.replace(href('/main')); // replace: browser back must not bounce into the bad route
    lastExp = r.id;
    const meta = metaOf(r.id);
    curtain.hold(meta);
    try {
      const exp = (await load()).default();
      await exp.init({ renderer });
      if (myVisit !== visit) return exp.dispose();
      exp.resize(renderer.domElement.width, renderer.domElement.height);
      current = exp;
      curtain.reveal();
    } catch (e) {
      console.error(e);
      toast('작품을 불러오지 못했습니다.');
      return location.replace(href('/main'));
    }
    $('hint').querySelector('.icon')!.textContent = GESTURE_ICON[current.hint.gesture];
    $('exp-title').querySelector('.title')!.textContent = current.title;
    $('exp-title').querySelector('.sub')!.textContent = meta?.subtitle ?? '';
    $('hint').querySelector('.text')!.textContent = current.hint.text;
    hintUntil = performance.now() + HINT_MS;
    lastTracked = performance.now();
    if (input.source.kind === 'off' && !consentAsked) askConsent();
  }
  addEventListener('hashchange', route);
  if (!location.hash) history.replaceState(null, '', href('/main'));
  route();

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    current?.resize(renderer.domElement.width, renderer.domElement.height);
  });

  // --- hand cursors: hover + pinch click (SHELL-4, MAIN-4) -----------------------------------
  // A tracked hand clicks the moment its fingers close over a [data-hand] target (pinch rising edge), once per pinch.
  // Targets within MAGNET px count as hovered and the drawn ring leans toward them, so jitter cannot shake it off.
  interface HandUi { dot: HTMLElement; hover?: HTMLElement; pinch: number; pinched: boolean; pressed?: HTMLElement; mag: number; mx: number; my: number }
  const cursorLayer = $('cursors');
  const handUi = new Map<string, HandUi>();
  const marked = new Set<HTMLElement>(); // targets carrying .hand-hover this frame

  /** Visible target under (x, y), else the nearest unobstructed one within MAGNET px. */
  const targetAt = (x: number, y: number): HTMLElement | undefined => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-hand]');
    if (hit) return hit;
    let best: HTMLElement | undefined;
    let bestD = MAGNET;
    for (const el of document.querySelectorAll<HTMLElement>('[data-hand]')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue; // hidden
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      // Not covered (e.g. by the consent dialog): its own center must hit it.
      if (d < bestD && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-hand]') === el) {
        best = el;
        bestD = d;
      }
    }
    return best;
  };

  const clickBurst = (dot: HTMLElement) =>
    dot.lastElementChild!.animate(
      reduced.matches ? { opacity: [0.8, 0] } : { transform: ['scale(0.5)', 'scale(2.4)'], opacity: [0.9, 0] },
      { duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );

  const updateCursors = (hands: Hand[], dt: number) => {
    const k = 1 - Math.exp(-14 * dt);
    for (const h of hands) {
      if (h.kind !== 'tracked') continue;
      let ui = handUi.get(h.id);
      if (!ui) {
        const dot = document.createElement('div');
        dot.className = 'hc';
        dot.innerHTML = '<span class="ring"></span><span class="burst"></span>';
        cursorLayer.append(dot);
        ui = { dot, pinch: 0, pinched: h.gestures.pinch, mag: 0, mx: 0, my: 0 }; // a hand entering already pinched must not click
        handUi.set(h.id, ui);
      }
      const x = h.pinchPoint.x * innerWidth, y = h.pinchPoint.y * innerHeight;
      const el = (ui.hover = targetAt(x, y));
      if (h.gestures.pinch !== ui.pinched) {
        ui.pinched = h.gestures.pinch;
        ui.pressed = ui.pinched ? el : undefined;
        if (ui.pressed) {
          ui.pressed.click();
          clickBurst(ui.dot);
        }
      }

      if (el) {
        const r = el.getBoundingClientRect();
        ui.mx = r.left + r.width / 2;
        ui.my = r.top + r.height / 2;
      }
      ui.mag += ((el ? 1 : 0) - ui.mag) * k;
      // Lean toward the target, capped so big targets (posters) do not drag the ring far from the hand.
      const ox = (ui.mx - x) * PULL * ui.mag, oy = (ui.my - y) * PULL * ui.mag;
      const cap = Math.min(1, MAGNET / (Math.hypot(ox, oy) || 1));
      ui.dot.style.transform = `translate(${x + ox * cap}px, ${y + oy * cap}px)`;
      ui.pinch = h.pinchStrength;
      ui.dot.style.setProperty('--p', ui.pinch.toFixed(2));
      ui.dot.classList.toggle('hover', !!el);
      ui.dot.classList.toggle('press', h.gestures.pinch);
    }
    for (const [id, ui] of handUi) {
      if (hands.some((h) => h.id === id)) continue;
      ui.dot.remove();
      handUi.delete(id);
    }

    // Re-mark hovered targets; --pinch lets them tighten as the fingers close, before the click fires.
    for (const el of marked) {
      el.classList.remove('hand-hover', 'hand-press');
      el.style.removeProperty('--pinch');
    }
    marked.clear();
    for (const ui of handUi.values()) {
      if (!ui.hover) continue;
      marked.add(ui.hover);
      ui.hover.classList.add('hand-hover');
      if (ui.pressed === ui.hover) ui.hover.classList.add('hand-press');
      ui.hover.style.setProperty('--pinch', ui.pinch.toFixed(2));
    }
  };

  const guides = $<HTMLCanvasElement>('hand-guides').getContext('2d')!;
  const previewCtx = preview.querySelector('canvas')!.getContext('2d')!;
  const fit = (c: HTMLCanvasElement, w: number, h: number) => {
    if (c.width !== w || c.height !== h) Object.assign(c, { width: w, height: h });
  };
  const drawGuides = (frame: InputFrame) => {
    fit(guides.canvas, innerWidth, innerHeight);
    if (handView === 'flesh') drawHandFlesh(guides, frame, innerWidth, innerHeight);
    else if (handView === 'skeleton') drawSkeleton(guides, frame, innerWidth, innerHeight, 0.18, false);
    else guides.clearRect(0, 0, innerWidth, innerHeight);
    if (preview.hidden) return;
    const { clientWidth: w, clientHeight: h } = preview;
    fit(previewCtx.canvas, w, h);
    drawSkeleton(previewCtx, frame, w, h, 0.9, true);
  };

  // --- loop (SHELL-6: stops while the tab is hidden) ---------------------------------
  let raf = 0;
  let last = performance.now();
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    // Pose only runs while the preview is open, to draw body guide lines there.
    const needs = current?.needs ?? [];
    const frame = input.update(now / 1000, dt, preview.hidden ? needs : [...needs, 'pose'], current?.filter);
    updateCursors(frame.hands, dt);
    drawGuides(frame);

    if (current) {
      // SHELL-5: re-show the hint when tracking is lost.
      // shortcut: only hand-based experiences detect "lost"; add mask coverage for segmentation-only ones if needed.
      if (frame.source === 'pointer' || !current.needs.includes('hands') || frame.hands.some((h) => h.kind === 'tracked')) lastTracked = now;
      $('hint').hidden = !(now < hintUntil || now - lastTracked > LOST_MS);
      current.frame(frame, dt);
    } else {
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000);
      renderer.clear();
      grid.update(frame, dt);
    }
    debug?.draw(frame, input, dt);
  };
  const run = () => {
    cancelAnimationFrame(raf);
    if (document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', run);
  run();
}
