import { RoundedBox } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { createRoot } from "react-dom/client";

function Spinner({ name, position, color }) {
  const ref = useRef(null);
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.6;
  });
  return (
    <RoundedBox ref={ref} name={name} args={[1, 1, 1]} radius={0.12} position={position}>
      <meshStandardMaterial name={`${name}Material`} color={color} />
    </RoundedBox>
  );
}

function Scene() {
  return (
    <>
      <color attach="background" args={["#1c1f24"]} />
      <ambientLight name="Fill" intensity={0.4} />
      <directionalLight name="Key" position={[3, 5, 2]} intensity={2} />
      <group name="Shelf">
        <Spinner name="Left" position={[-1.5, 0, 0]} color="#e07a5f" />
        <Spinner name="Middle" position={[0, 0, 0]} color="#3d405b" />
        <Spinner name="Right" position={[1.5, 0, 0]} color="#81b29a" />
      </group>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <Canvas camera={{ position: [0, 1.5, 5], fov: 45 }} dpr={[1, 2]}>
    <Scene />
  </Canvas>,
);
