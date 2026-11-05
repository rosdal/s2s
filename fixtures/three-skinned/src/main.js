import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.querySelector("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.name = "Studio";
scene.background = new THREE.Color(0x202428);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 50);
camera.name = "Camera";
camera.position.set(0, 1.4, 5);
camera.lookAt(0, 0.8, 0);
scene.add(camera);
const key = new THREE.DirectionalLight(0xffffff, 2.5);
key.name = "Key";
key.position.set(2, 4, 3);
scene.add(key);
scene.add(Object.assign(new THREE.HemisphereLight(0xffffff, 0x404040, 0.8), { name: "Sky" }));

let mixer;
new GLTFLoader().load("/models/stage.glb", (gltf) => {
  gltf.scene.name = "Stage";
  scene.add(gltf.scene);
  mixer = new THREE.AnimationMixer(gltf.scene);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  mixer?.update(clock.getDelta());
  renderer.render(scene, camera);
});
