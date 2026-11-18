// Self-host MediaPipe wasm + models (PRD §7: no external CDN at runtime).
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';

const out = 'public/models';
const base = 'https://storage.googleapis.com/mediapipe-models';
const models = {
  'hand_landmarker.task': 'hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  'selfie_segmenter.tflite': 'image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  'pose_landmarker_lite.task': 'pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'face_landmarker.task': 'face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
};

await mkdir(out, { recursive: true });
await cp('node_modules/@mediapipe/tasks-vision/wasm', `${out}/wasm`, { recursive: true });

for (const [file, path] of Object.entries(models)) {
  const dest = `${out}/${file}`;
  if (await stat(dest).then(() => true, () => false)) continue;
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
  console.log(`fetched ${file}`);
}
