type XY = { x: number; y: number };

/** For each `next` point, the index of its matched `prev` point or -1. Globally greedy: closest pairs first, each prev used once. */
export function matchNearest(prev: XY[], next: XY[], maxDist: number): number[] {
  const pairs: [number, number, number][] = [];
  prev.forEach((a, i) => next.forEach((b, j) => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < maxDist) pairs.push([d, i, j]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const out = next.map(() => -1);
  const used = new Set<number>();
  for (const [, i, j] of pairs) {
    if (out[j] >= 0 || used.has(i)) continue;
    out[j] = i;
    used.add(i);
  }
  return out;
}
