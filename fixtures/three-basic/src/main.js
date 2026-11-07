import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { glowFragment, glowVertex } from "./shaders.js";

gsap.registerPlugin(ScrollTrigger);

const canvas = document.querySelector("canvas.webgl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.name = "World";
scene.background = new THREE.Color(0x101418);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.name = "MainCamera";
camera.position.set(0, 2, 8);
camera.lookAt(0, 1, 0);
scene.add(camera);

const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.name = "Sun";
sun.position.set(3, 5, 2);
scene.add(sun);
const ambient = new THREE.AmbientLight(0xffffff, 0.4);
ambient.name = "Fill";
scene.add(ambient);

const groundTexture = new THREE.TextureLoader().load("/textures/ground.png");
groundTexture.name = "ground";
groundTexture.wrapS = groundTexture.wrapT = THREE.RepeatWrapping;
groundTexture.repeat.set(4, 4);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ name: "GroundMaterial", map: groundTexture }),
);
ground.name = "Ground";
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const glow = new THREE.ShaderMaterial({
  name: "GlowMaterial",
  vertexShader: glowVertex,
  fragmentShader: glowFragment,
  transparent: true,
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x66ccff) } },
});
const halo = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.08, 16, 96), glow);
halo.name = "Halo";
halo.position.y = 1;
scene.add(halo);

let mixer;
new GLTFLoader().load("/models/hero.glb", (gltf) => {
  const hero = gltf.scene;
  hero.name = "Hero";
  scene.add(hero);
  mixer = new THREE.AnimationMixer(hero);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();
});

// Scroll choreography: the camera moves closer, rises, and the halo tips over.
const timeline = gsap.timeline({
  scrollTrigger: { trigger: "#content", start: "top top", end: "bottom bottom", scrub: true },
});
timeline
  .to(camera.position, { z: 4, y: 1.5, ease: "none" })
  .to(camera.position, { y: 6, z: 5, ease: "none" })
  .to(halo.rotation, { x: Math.PI / 2, ease: "none" }, "<");

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  const elapsed = clock.elapsedTime;
  mixer?.update(delta);
  glow.uniforms.uTime.value = elapsed;
  halo.rotation.z = elapsed * 0.3;
  camera.lookAt(0, 1, 0);
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
