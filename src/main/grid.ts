import { href } from '../core/router.ts';
import type { ExperienceMeta, InputFrame } from '../core/types.ts';
import * as curtain from './curtain.ts';
import type { Geom } from './curtain.ts';

// MAIN-1..4: a grid of posters under a Dock-style lens; each poster swells by its distance to the nearest
// cursor (mouse, touch, tracked hand, keyboard focus). DOM + transforms only (MAIN-5: no WebGL here).
const metas = import.meta.glob<{ default: ExperienceMeta }>('../experiences/*/meta.ts', { eager: true });
const posters = Object.entries(metas)
  .map(([path, m]) => ({ id: path.split('/')[2], ...m.default }))
  .sort((a, b) => a.order - b.order);
export const metaOf = (id: string) => posters.find((p) => p.id === id);

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const LENS = reduced ? 0.3 : 0.7; // extra scale right under a cursor
const RADIUS = 1.5; // lens radius in poster widths
const EASE = 12; // 1/s, scale follow speed
const MAX_COLS = 8; // 16+ pieces: wider rows keep posters large on landscape screens
const MAX_PW = 300;

const pad = (k: number) => String(k).padStart(2, '0');
const geomOf = (el: HTMLElement): Geom => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, a: 0 };
};

export function createGrid(root: HTMLElement) {
  const nav = root.querySelector<HTMLElement>('#grid')!;
  const count = root.querySelector<HTMLElement>('.count')!;
  const how = root.querySelector<HTMLElement>('.how')!;
  const n = posters.length;
  count.textContent = `— / ${pad(n)}`;

  const els = posters.map((p, i) => {
    const a = document.createElement('a');
    a.className = 'poster';
    a.dataset.hand = '';
    a.draggable = false;
    a.style.setProperty('--bg', p.bg);
    a.style.setProperty('--ink', p.ink);
    a.setAttribute('aria-label', `${p.title}, ${p.subtitle} (${i + 1}/${n})`);
    a.innerHTML = `<span class="face">
      <span class="top" aria-hidden="true"><span class="no">${pad(i + 1)} / ${pad(n)}</span><span class="mark">MOVE</span></span>
      <span class="art" aria-hidden="true"><span class="num">${pad(i + 1)}</span><img alt="" draggable="false" decoding="async" /></span>
      <span class="sub" aria-hidden="true"></span><strong class="title" aria-hidden="true"></strong><span class="date" aria-hidden="true"></span></span>`;
    a.querySelector('.sub')!.textContent = p.subtitle;
    a.querySelector('.title')!.textContent = p.title;
    a.querySelector('.date')!.textContent = p.date;
    const img = a.querySelector('img')!;
    img.onerror = () => img.remove(); // poster art is optional
    img.onload = () => a.classList.add('has-art');
    img.src = `${import.meta.env.BASE_URL}posters/${p.id}.webp`;
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; // new tab etc.: let the browser handle it
      e.preventDefault();
      if (dragged && e.detail) return; // a mouse press-and-drag through the lens is browsing; hand pinch / keyboard clicks have detail 0
      open(i);
    });
    return a;
  });
  nav.replaceChildren(...els);

  // Untransformed poster centers (screen px) and current eased scales.
  const cx = new Float32Array(n), cy = new Float32Array(n), scale = new Float32Array(n).fill(1);
  let cols = 1, pw = 0, active = -1, busy = false, pointerMode = true;
  // Pointer travel since the last press; a long drag must not open the poster it ends on.
  let downX = 0, downY = 0, dragged = false;
  nav.addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
    dragged = false;
  });
  nav.addEventListener('pointermove', (e) => {
    if (e.buttons && Math.hypot(e.clientX - downX, e.clientY - downY) > 12) dragged = true;
  });

  /** Picks the column count that gives the biggest posters inside the viewport, then caches poster centers. */
  const measure = () => {
    const gap = Math.min(56, Math.max(28, innerWidth * 0.035));
    const availW = innerWidth * 0.88, availH = innerHeight - 200;
    pw = 0;
    for (let c = 1; c <= Math.min(MAX_COLS, n); c++) {
      const rows = Math.ceil(n / c);
      const w = Math.min((availW - gap * (c - 1)) / c, ((availH - gap * (rows - 1)) / rows) * 0.75, MAX_PW);
      if (w > pw) {
        pw = w;
        cols = c;
      }
    }
    nav.style.setProperty('--cols', String(cols));
    nav.style.setProperty('--pw', `${pw}px`);
    nav.style.setProperty('--gap', `${gap}px`);
    const r = nav.getBoundingClientRect();
    for (let i = 0; i < n; i++) {
      cx[i] = r.left + els[i].offsetLeft + els[i].offsetWidth / 2;
      cy[i] = r.top + els[i].offsetTop + els[i].offsetHeight / 2;
    }
  };

  function open(i: number): void {
    if (busy || root.hidden) return;
    busy = true;
    curtain
      .expand(geomOf(els[i]), posters[i])
      .then(() => (location.hash = href(`/exp/${posters[i].id}`)), () => {})
      .finally(() => (busy = false));
  }

  // Arrow keys move focus through the grid; the focused poster gets the lens.
  addEventListener('keydown', (e) => {
    if (root.hidden || busy || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLAnchorElement;
    if (t !== document.body && !root.contains(t)) return; // focus is in a dialog or on a shell button
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (!by || !n) return;
    e.preventDefault();
    const i = els.indexOf(t);
    els[i < 0 ? 0 : Math.min(n - 1, Math.max(0, i + by))].focus();
  });

  function update(frame: InputFrame, dt: number): void {
    if (root.hidden || !n) return;
    if (pointerMode !== (frame.source === 'pointer')) {
      pointerMode = frame.source === 'pointer';
      how.innerHTML = pointerMode
        ? '누른 채 움직여 살펴보고, <b>클릭</b>해서 감상하세요'
        : '손을 움직여 살펴보고, <b>손가락을 모으면 선택</b>됩니다';
    }
    const focused = document.activeElement;
    const fi = focused instanceof HTMLAnchorElement && focused.matches(':focus-visible') ? els.indexOf(focused) : -1;
    const r2 = (RADIUS * pw) ** 2;
    const k = reduced ? 1 : 1 - Math.exp(-EASE * dt);
    const hands = frame.hands;
    let top = -1;
    for (let i = 0; i < n; i++) {
      let near = i === fi ? 0 : Infinity; // squared px distance to the nearest cursor
      for (let h = 0; h < hands.length; h++) {
        const hand = hands[h];
        if (hand.kind === 'pointer' && !hand.gestures.pinch) continue; // mouse/touch: lens only while pressed; tracked hands: on hover
        const dx = hand.pinchPoint.x * innerWidth - cx[i], dy = hand.pinchPoint.y * innerHeight - cy[i];
        near = Math.min(near, dx * dx + dy * dy);
      }
      const s = scale[i] + (1 + LENS * Math.exp(-near / r2) - scale[i]) * k;
      if (top < 0 || s > scale[top]) top = i;
      if (Math.abs(s - scale[i]) < 1e-4) continue;
      scale[i] = s;
      // Style strings only while the lens moves; the DOM has no allocation-free way to set a transform.
      els[i].style.transform = `scale(${s})`;
      els[i].style.zIndex = String(Math.round(s * 100)); // bigger posters overlap their neighbours
    }
    if (top === active || scale[top] < 1 + LENS * 0.25) return;
    els[active]?.classList.remove('active');
    active = top;
    els[top].classList.add('active');
    count.textContent = `${pad(top + 1)} / ${pad(n)}`;
    root.style.setProperty('--accent', posters[top].bg);
  }

  addEventListener('resize', () => {
    if (!root.hidden) measure();
  });

  return {
    update,
    /** Shows the grid; when returning from piece `fromId`, the curtain shrinks back into its poster. */
    show(fromId?: string): void {
      root.hidden = false;
      for (let i = 0; i < n; i++) {
        els[i].href = href(`/exp/${posters[i].id}`);
        els[i].style.transform = els[i].style.zIndex = '';
      }
      scale.fill(1);
      measure();
      const i = posters.findIndex((p) => p.id === fromId);
      curtain.collapse(i >= 0 ? geomOf(els[i]) : undefined, posters[i]);
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
