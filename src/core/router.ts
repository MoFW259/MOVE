// SHELL-7: `#!/main`, `#!/exp/<id>`, with an optional `?query` inside the hash (e.g. `#!/exp/smoke?src=fixture:hands-1&debug`).
export type Route = { page: 'main' } | { page: 'exp'; id: string };

export function parseRoute(hash = location.hash): Route {
  const path = hash.replace(/^#!?/, '').split('?')[0];
  const m = /^\/exp\/([\w-]+)$/.exec(path);
  return m ? { page: 'exp', id: m[1] } : { page: 'main' };
}

/** Query from both `location.search` and the hash, so either form works. */
export function params(): URLSearchParams {
  const p = new URLSearchParams(location.search);
  new URLSearchParams(location.hash.split('?')[1] ?? '').forEach((v, k) => p.set(k, v));
  return p;
}

/** Builds a hash href that keeps the current hash query (debug, src) across navigation. */
export function href(path: string): string {
  const q = location.hash.split('?')[1];
  return `#!${path}${q ? `?${q}` : ''}`;
}
