# AGENTS.md

MOVE: WebGL pieces that react to the body via webcam (MediaPipe). Spec: `PRD.md`.

## Commands

```sh
npm install          # also fetches MediaPipe wasm + models into public/models (self-hosted, gitignored)
npm run dev          # http://localhost:5173
npm run typecheck
npm test             # gesture classifier tests (node --test)
npm run build        # dist/, static, deploy anywhere
```

Check loop: open `http://localhost:5173/#!/exp/<id>?src=fixture:<name>&debug`, read fps / detect ms in the overlay, take a screenshot. URL params are read at page load: reload after changing them.

## Rules

- **Do not edit `src/core/`** unless all three agree. Work only in `src/experiences/<your-id>/`.
- New experience = new folder `src/experiences/<id>/` with `index.ts` and `meta.ts` (poster data, `ExperienceMeta` in `src/core/types.ts`; import nothing else there, it loads eagerly). Folders with a `meta.ts` appear on the main poster grid automatically, sorted by `order`; without one (like `sample/`) they are reachable by URL only. Use `title: meta.title` in `index.ts`. Optional poster art: `public/posters/<id>.webp`.
- `index.ts` default-exports a **factory** `() => Experience`. A fresh instance is created per visit.
- **Never draw the raw camera image** (`input.camera`) recognizably. Users find it uncomfortable. The shell offers an optional small preview window instead. Use the camera only transformed (glyphs, flow, colors) or not at all; prefer hands/mask.
- `dispose()` must free every GPU resource you created (geometries, materials, textures, render targets). Do not dispose `input.camera` / `input.mask`: core owns them.
- Render to the screen yourself in `frame()` (`renderer.setRenderTarget(null)` then render). The renderer is shared; do not change its size or pixel ratio.
- Idle animation must keep running with zero hands / no camera (PRD §5.3). Everything must work with mouse/touch only (G4).
- Flashing effects: max 3 flashes per second; tone down when `matchMedia('(prefers-reduced-motion: reduce)').matches`.

## Interface (`src/core/types.ts`)

```ts
export default (): Experience => ({
  id, title,
  hint: { text: '한 줄 힌트', gesture: 'open' | 'fist' | 'pinch' | 'point' | 'swipe' },
  needs: ['segmentation' | 'hands' | 'pose' | 'face'],   // only these models load; [] = camera image only
  filter?: { minCutoff, beta },                            // One Euro smoothing for landmarks
  async init({ renderer }) {}, frame(input, dt) {}, resize(w, h) {}, dispose() {},
});
```

`resize` receives drawing-buffer pixels.

## Coordinates

- Landmarks and `hand.cursor`: 0..1, origin **top-left**, already **mirrored** (selfie view). They are relative to the camera frame stretched over the full screen, so they line up with mouse coordinates. If you crop the camera image (cover-fit), remap landmarks the same way.
- `input.camera`, `input.mask` (red channel 0..1): mirrored, standard GL orientation. To sample at landmark `p`: `texture2D(tex, vec2(p.x, 1.0 - p.y))`.
- `input.source`: `'camera' | 'fixture' | 'pointer'`. `camera`/`mask`/`pose`/`face` are undefined in pointer mode.

## Hands and gestures

`input.hands` contains up to 4 tracked hands (`kind: 'tracked'`, id `hand-<n>`, stable while the hand stays in view) and every mouse/touch pointer (`kind: 'pointer'`, multi-touch gives several). Same shape for both:

| Field | Tracked hand | Pointer |
|---|---|---|
| `cursor` | index fingertip | pointer position |
| `pinchPoint` | thumb–index midpoint | pointer position |
| `pinchStrength` | 0 apart … 1 touching | 0 / 1 (released / pressed) |
| `size` | wrist→middle knuckle (bigger = closer) | 0 |
| `landmarks` | 21 MediaPipe points | 21 copies of `cursor` |
| `gestures.pinch`, `gestures.fist` | detected | button / touch held |
| `gestures.open`, `gestures.point` | detected | button released |
| `gestures.swipe` | wrist speed | pointer speed |

Thresholds (with hysteresis) live in `src/core/input/gestures.ts`.

## Interaction language: pinch first

- **Pinch is the main verb.** Hover → pinch = select/grab (fires the moment the fingers close) → move while pinched → release = drop or throw.
- Select and grab at `hand.pinchPoint`, not `cursor`: the index tip jumps when the fingers close.
- Show anticipation: make hover targets react as `pinchStrength` rises, before the pinch fires. Make the held state obvious and give release a visible response.
- UI: shell targets carry `data-hand`. A hand clicks one the moment it pinches over it. There is no dwell-to-click and no click on release.
- 3D pieces: use `Grabber` from `src/core/grab.ts` for hover, grab, depth push/pull, roll, two-hand scale and throw. Every piece should then feel the same. Draw an in-scene 3D pinch cursor.

## Fixtures

Recorded videos in `fixtures/<name>.webm` (or `.mp4`), dev server only. Planned set: 1 person full body, hand close-up, 3 people, low light, empty room. Use `?src=fixture:<name>`.
