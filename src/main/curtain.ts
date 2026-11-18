import type { ExperienceMeta } from '../core/types.ts';

/** A poster on screen: center and size in px, rotation in rad. */
export interface Geom { x: number; y: number; w: number; h: number; a: number }

// MAIN-3: a solid sheet in the poster's color grows out of the poster, holds as a title card while the piece loads, then fades.
const ZOOM_MS = 520;
const FADE_MS = 360;
const EASE = 'cubic-bezier(0.75, 0, 0.2, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const el = document.getElementById('curtain')!;
const sheet = el.querySelector<HTMLElement>('.sheet')!;
const label = el.querySelector<HTMLElement>('.label')!;

const fromPoster = (g: Geom) =>
  `translate(${g.x - innerWidth / 2}px, ${g.y - innerHeight / 2}px) rotate(${g.a}rad) scale(${g.w / innerWidth}, ${g.h / innerHeight})`;

function paint(meta?: ExperienceMeta): void {
  for (const a of el.getAnimations({ subtree: true })) a.cancel();
  el.style.setProperty('--bg', meta?.bg ?? '#0b0b0c');
  el.style.setProperty('--ink', meta?.ink ?? '#f2f0eb');
  label.querySelector('.title')!.textContent = meta?.title ?? '';
  label.querySelector('.sub')!.textContent = meta?.subtitle ?? '';
  label.querySelector('.date')!.textContent = meta?.date ?? '';
  el.hidden = false;
}

/** Grows the poster into a fullscreen title card. Rejects if interrupted by another curtain call. */
export async function expand(from: Geom, meta: ExperienceMeta): Promise<void> {
  paint(meta);
  if (reduced.matches) {
    await el.animate({ opacity: [0, 1] }, { duration: 160 }).finished;
    return;
  }
  label.animate({ opacity: [0, 1], transform: ['translateY(12px)', 'none'] }, { duration: 280, delay: ZOOM_MS * 0.55, easing: 'ease-out', fill: 'backwards' });
  await sheet.animate({ transform: [fromPoster(from), 'none'] }, { duration: ZOOM_MS, easing: EASE }).finished;
}

/** Keeps the screen covered while a piece loads (also for direct links, where no expand ran). */
export function hold(meta?: ExperienceMeta): void {
  const wasHidden = el.hidden;
  paint(meta);
  if (wasHidden && !reduced.matches) el.animate({ opacity: [0, 1] }, { duration: 160 });
}

/** The piece is ready: fade the title card away. `onfinish` runs before paint, so the filled end frame never flashes back. */
export function reveal(): void {
  if (el.hidden) return;
  for (const a of el.getAnimations({ subtree: true })) a.cancel();
  const a = el.animate({ opacity: [1, 0] }, { duration: reduced.matches ? 120 : FADE_MS, easing: 'ease-out', fill: 'forwards' });
  a.onfinish = () => {
    el.hidden = true;
    a.cancel();
  };
}

/** Back to the grid: shrink the sheet into its poster (`to`), or just fade when there is none. */
export function collapse(to: Geom | undefined, meta: ExperienceMeta | undefined): void {
  if (!to || !meta || reduced.matches) return reveal();
  paint(meta);
  label.animate({ opacity: [1, 0] }, { duration: 160, fill: 'forwards' });
  const a = sheet.animate({ transform: ['none', fromPoster(to)] }, { duration: ZOOM_MS * 0.85, easing: EASE, fill: 'forwards' });
  a.onfinish = () => {
    el.hidden = true;
    for (const b of el.getAnimations({ subtree: true })) b.cancel();
  };
}
