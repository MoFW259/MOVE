import type { InputFrame } from './types.ts';
import type { Input } from './input/input.ts';

/** SHELL-8: `?debug` overlay with landmarks, mask, fps and detection latency. */
export class DebugOverlay {
  private canvas = Object.assign(document.createElement('canvas'), { className: 'debug' });
  private ctx = this.canvas.getContext('2d')!;
  private maskCanvas = document.createElement('canvas');
  private fps = 60;

  constructor() {
    document.body.append(this.canvas);
  }

  draw(frame: InputFrame, input: Input, dt: number): void {
    const { canvas, ctx } = this;
    const w = (canvas.width = innerWidth), h = (canvas.height = innerHeight);
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    const dots = (pts: { x: number; y: number }[] | undefined, color: string, r = 3) => {
      ctx.fillStyle = color;
      for (const p of pts ?? []) ctx.fillRect(p.x * w - r / 2, p.y * h - r / 2, r, r);
    };
    dots(frame.pose, '#0f0', 6);
    dots(frame.face?.landmarks.filter((_, i) => i % 4 === 0), '#ff0', 2);
    for (const hand of frame.hands) dots(hand.landmarks, hand.kind === 'tracked' ? '#f0f' : '#0ff', 6);

    const mask = input.last.mask;
    if (mask && frame.mask) {
      const mc = this.maskCanvas;
      mc.width = mask.width;
      mc.height = mask.height;
      const mctx = mc.getContext('2d')!;
      const img = mctx.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.data.length; i++) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = mask.data[i] * 255;
        img.data[i * 4 + 3] = 255;
      }
      mctx.putImageData(img, 0, 0);
      ctx.save();
      ctx.translate(w - 8, h - 8 - 120); // mirrored thumbnail, bottom-right
      ctx.scale(-1, 1);
      ctx.drawImage(mc, 0, 0, 120 * (mask.width / mask.height), 120);
      ctx.restore();
    }

    const lines = [
      `render ${this.fps.toFixed(0)} fps · source ${frame.source}`,
      `detect ${input.stats.detectFps.toFixed(0)} fps · ${input.stats.detectMs.toFixed(1)} ms`,
      ...frame.hands.map((hd) => `${hd.id}: ${Object.entries(hd.gestures).filter(([, v]) => v).map(([k]) => k).join(' ') || '-'}`),
    ];
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(8, 8, 280, lines.length * 16 + 8);
    ctx.fillStyle = '#fff';
    lines.forEach((l, i) => ctx.fillText(l, 14, 24 + i * 16));
  }
}
