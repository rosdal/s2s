import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { VignetteShader } from "./vignette.js";

const canvas = document.querySelector("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.name = "Neon";
scene.background = new THREE.Color(0x05060a);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.name = "Lens";
camera.position.set(0, 0, 6);
scene.add(camera);

const rings = new THREE.Group();
rings.name = "Rings";
scene.add(rings);
for (let i = 0; i < 5; i++) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.6 + i * 0.35, 0.03, 12, 96),
    new THREE.MeshBasicMaterial({
      name: `Glow${i}`,
      color: new THREE.Color().setHSL(0.55 + i * 0.08, 1, 0.6),
    }),
  );
  ring.name = `Ring${i}`;
  rings.add(ring);
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.2, 0.4, 0.1),
);
const vignette = new ShaderPass(VignetteShader);
vignette.uniforms.uStrength.value = 0.6;
composer.addPass(vignette);
composer.addPass(new OutputPass());

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  rings.children.forEach((ring, i) => {
    ring.rotation.x = t * (0.2 + i * 0.1);
    ring.rotation.y = t * 0.15 * (i % 2 ? 1 : -1);
  });
  composer.render();
});
