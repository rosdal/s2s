import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const canvas = document.querySelector("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.name = "Gallery";
scene.background = new THREE.Color(0x15171a);
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 50);
camera.name = "Viewer";
camera.position.set(0, 1.6, 6);
camera.lookAt(0, 1, 0);
scene.add(camera);
const light = new THREE.DirectionalLight(0xffffff, 3);
light.name = "Spot";
light.position.set(-2, 5, 4);
scene.add(light);
scene.add(Object.assign(new THREE.AmbientLight(0xffffff, 0.3), { name: "Fill" }));

const draco = new DRACOLoader().setDecoderPath("/draco/");
const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
// Warm the Basis transcoder up front, as sites do before their compressed textures arrive.
ktx2.init();

const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(6, 3),
  new THREE.MeshStandardMaterial({ name: "WallMaterial" }),
);
wall.name = "Wall";
wall.position.set(0, 1.5, -1.5);
scene.add(wall);
ktx2.load("/textures/wall.ktx2", (texture) => {
  texture.name = "wall";
  wall.material.map = texture;
  wall.material.needsUpdate = true;
});

const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);
let sculpture;
loader.load("/models/sculpture.glb", (gltf) => {
  gltf.scene.name = "Exhibit";
  sculpture = gltf.scene;
  scene.add(gltf.scene);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  if (sculpture) sculpture.rotation.y = clock.getElapsedTime() * 0.5;
  renderer.render(scene, camera);
});
