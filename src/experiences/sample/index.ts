import * as THREE from 'three';
import type { Experience } from '../../core/types.ts';

// Template experience: copy this folder to start a new one. Shows silhouette mask and hand cursors (never the raw camera).
const MAX_HANDS = 8;

export default (): Experience => {
  let renderer: THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      aspect: { value: 1 },
      maskTex: { value: null as THREE.Texture | null },
      hasMask: { value: 0 },
      hands: { value: Array.from({ length: MAX_HANDS }, () => new THREE.Vector4()) }, // x, y, pinch, active
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform float time, aspect, hasMask;
      uniform sampler2D maskTex;
      uniform vec4 hands[${MAX_HANDS}];
      varying vec2 vUv;
      void main() {
        // Idle animation keeps running even with no input (PRD §5.3).
        vec3 col = 0.15 + 0.15 * cos(time * 0.5 + vUv.xyx * 3.0 + vec3(0, 2, 4));
        if (hasMask > 0.5) col += vec3(0.1, 0.3, 0.6) * texture2D(maskTex, vUv).r;
        for (int i = 0; i < ${MAX_HANDS}; i++) {
          if (hands[i].w < 0.5) continue;
          vec2 d = (vUv - vec2(hands[i].x, 1.0 - hands[i].y)) * vec2(aspect, 1.0);
          col += mix(vec3(0.2, 0.6, 1.0), vec3(1.0, 0.4, 0.2), hands[i].z) * 0.02 / max(length(d), 0.002);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const u = material.uniforms;

  return {
    id: 'sample',
    title: '샘플',
    hint: { text: '손을 흔들어 보세요', gesture: 'swipe' },
    needs: ['segmentation', 'hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      u.time.value += dt;
      u.maskTex.value = input.mask ?? null;
      u.hasMask.value = input.mask ? 1 : 0;
      u.hands.value.forEach((v: THREE.Vector4, i: number) => {
        const h = input.hands[i];
        v.set(h?.cursor.x ?? 0, h?.cursor.y ?? 0, h?.gestures.pinch ? 1 : 0, h ? 1 : 0);
      });
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      u.aspect.value = width / height;
    },
    dispose() {
      scene.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
      material.dispose();
    },
  };
};
