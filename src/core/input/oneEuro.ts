// One Euro filter (Casiez et al. 2012): adaptive low-pass, smooth at rest, responsive when moving.
const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private x?: number;
  private dx = 0;
  minCutoff: number;
  beta: number;
  constructor(minCutoff = 1, beta = 0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  filter(value: number, dt: number): number {
    if (this.x === undefined || dt <= 0) return (this.x = value);
    const dx = (value - this.x) / dt;
    this.dx += alpha(1, dt) * (dx - this.dx); // derivative cutoff fixed at 1 Hz (paper default)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    return (this.x += alpha(cutoff, dt) * (value - this.x));
  }
}
