import {
  FaceLandmarker, FilesetResolver, HandLandmarker, ImageSegmenter, PoseLandmarker,
  type FaceLandmarkerResult, type HandLandmarkerResult, type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { Need } from '../types.ts';

// IN-1/IN-2: one fileset for the app, one task per need, created on first use and kept for reuse.
const BASE = `${import.meta.env.BASE_URL}models/`;
// tasks-vision declares WasmFileset but does not export it.
let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | undefined;
const fileset = () => (filesetPromise ??= FilesetResolver.forVisionTasks(`${BASE}wasm`));

type Task = HandLandmarker | ImageSegmenter | PoseLandmarker | FaceLandmarker;
const tasks: Partial<Record<Need, Task>> = {};
const loading = new Set<Need>();

async function create(need: Need, delegate: 'GPU' | 'CPU'): Promise<Task> {
  const fs = await fileset();
  const base = (file: string) => ({ baseOptions: { modelAssetPath: BASE + file, delegate }, runningMode: 'VIDEO' as const });
  switch (need) {
    // 4 hands = two people. Hand inference cost grows per hand (PRD §12.3).
    case 'hands': return HandLandmarker.createFromOptions(fs, { ...base('hand_landmarker.task'), numHands: 4 });
    case 'segmentation': return ImageSegmenter.createFromOptions(fs, { ...base('selfie_segmenter.tflite'), outputConfidenceMasks: true, outputCategoryMask: false });
    case 'pose': return PoseLandmarker.createFromOptions(fs, { ...base('pose_landmarker_lite.task'), numPoses: 1 });
    case 'face': return FaceLandmarker.createFromOptions(fs, { ...base('face_landmarker.task'), numFaces: 1, outputFaceBlendshapes: true });
  }
}

/** Starts loading any missing tasks without blocking; detect() skips needs that are not ready yet. */
export function ensure(needs: Iterable<Need>): void {
  for (const need of needs) {
    if (tasks[need] || loading.has(need)) continue;
    loading.add(need);
    // GPU first; Safari GPU may be unstable (PRD §11), so fall back to CPU.
    create(need, 'GPU')
      .catch((e) => (console.warn(`[vision] ${need}: GPU failed, using CPU`, e), create(need, 'CPU')))
      .then((t) => (tasks[need] = t), (e) => console.error(`[vision] ${need} failed to load`, e))
      .finally(() => loading.delete(need));
  }
}

export interface Detection {
  hands?: HandLandmarkerResult;
  /** Raw (unmirrored) confidence mask, row 0 = top. */
  mask?: { data: Float32Array; width: number; height: number };
  pose?: PoseLandmarkerResult;
  face?: FaceLandmarkerResult;
}

export function detect(video: HTMLVideoElement, timestamp: number, needs: Iterable<Need>): Detection {
  const out: Detection = {};
  for (const need of needs) {
    const task = tasks[need];
    if (!task) continue;
    if (task instanceof HandLandmarker) out.hands = task.detectForVideo(video, timestamp);
    else if (task instanceof PoseLandmarker) out.pose = task.detectForVideo(video, timestamp);
    else if (task instanceof FaceLandmarker) out.face = task.detectForVideo(video, timestamp);
    else {
      const res = task.segmentForVideo(video, timestamp);
      const m = res.confidenceMasks?.[0];
      // shortcut: GPU→CPU mask copy every frame; switch to getAsWebGLTexture if M0 proves context sharing works.
      if (m) out.mask = { data: m.getAsFloat32Array(), width: m.width, height: m.height };
      res.close();
    }
  }
  return out;
}
