import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

const canvas = document.querySelector("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.name = "Playground";
scene.background = new THREE.Color(0xe8ecef);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.name = "Overview";
camera.position.set(0, 4, 10);
camera.lookAt(0, 1, 0);
scene.add(camera);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.name = "Sun";
sun.position.set(4, 8, 3);
scene.add(sun);
scene.add(Object.assign(new THREE.AmbientLight(0xffffff, 0.5), { name: "Fill" }));

const floor = new THREE.Mesh(
  new THREE.BoxGeometry(12, 0.2, 12),
  new THREE.MeshStandardMaterial({ name: "Floor", color: 0x9aa5ad }),
);
floor.name = "Floor";
floor.position.y = -0.1;
scene.add(floor);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.createCollider(RAPIER.ColliderDesc.cuboid(6, 0.1, 6).setTranslation(0, -0.1, 0));

const bodies = [];
const crates = new THREE.Group();
crates.name = "Crates";
scene.add(crates);
for (let i = 0; i < 6; i++) {
  const x = (i % 3) - 1;
  const y = 2 + i * 0.9;
  const z = Math.floor(i / 3) * 0.6 - 0.3;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.6, 0.6),
    new THREE.MeshStandardMaterial({ name: `Crate${i}`, color: 0xc0874f }),
  );
  mesh.name = `Crate${i}`;
  mesh.position.set(x, y, z);
  crates.add(mesh);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: 0.1 * i, y: 0, z: 0, w: 1 }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.3, 0.3), body);
  bodies.push([mesh, body]);
}

renderer.setAnimationLoop(() => {
  world.step();
  for (const [mesh, body] of bodies) {
    mesh.position.copy(body.translation());
    mesh.quaternion.copy(body.rotation());
  }
  renderer.render(scene, camera);
});
