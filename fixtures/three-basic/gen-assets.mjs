// Writes the fixture's model and texture deterministically, so the build output never changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";

export function sphere(radius, wSeg, hSeg) {
  const pos = [];
  const idx = [];
  for (let y = 0; y <= hSeg; y++) {
    const v = y / hSeg;
    for (let x = 0; x <= wSeg; x++) {
      const u = x / wSeg;
      pos.push(
        -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI),
        radius * Math.cos(v * Math.PI),
        radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI),
      );
    }
  }
  for (let y = 0; y < hSeg; y++)
    for (let x = 0; x < wSeg; x++) {
      const a = y * (wSeg + 1) + x;
      const b = a + wSeg + 1;
      if (y !== 0) idx.push(a, b, a + 1);
      if (y !== hSeg - 1) idx.push(b, b + 1, a + 1);
    }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) };
}

export function box(w, h, d) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const c = [
    [-x, -y, -z],
    [x, -y, -z],
    [x, y, -z],
    [-x, y, -z],
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  const pos = [];
  const idx = [];
  for (const f of faces) {
    const base = pos.length / 3;
    for (const i of f) pos.push(...c[i]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) };
}

export function mesh(doc, name, geo, material) {
  const buffer = doc.getRoot().listBuffers()[0];
  const position = doc.createAccessor().setType("VEC3").setArray(geo.pos).setBuffer(buffer);
  const indices = doc.createAccessor().setType("SCALAR").setArray(geo.idx).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute("POSITION", position).setIndices(indices);
  prim.setMaterial(material);
  return doc.createMesh(name).addPrimitive(prim);
}

export function checker(size, a, b) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? a : b;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

const doc = new Document();
doc.createBuffer();
const paint = doc
  .createMaterial("Paint")
  .setBaseColorFactor([0.9, 0.3, 0.2, 1])
  .setRoughnessFactor(0.4);
const metal = doc
  .createMaterial("Metal")
  .setBaseColorFactor([0.6, 0.6, 0.65, 1])
  .setMetallicFactor(1);
const body = doc
  .createNode("Body")
  .setMesh(mesh(doc, "BodyMesh", sphere(0.8, 48, 24), paint))
  .setTranslation([0, 1, 0]);
const base = doc.createNode("Base").setMesh(mesh(doc, "BaseMesh", box(2, 0.3, 2), metal));
const rig = doc.createNode("Rig").addChild(body).addChild(base);
doc.createScene("HeroScene").addChild(rig);

// One clip: the rig bobs (a transform track, so proxies keep it).
const buffer = doc.getRoot().listBuffers()[0];
const times = doc
  .createAccessor()
  .setType("SCALAR")
  .setArray(new Float32Array([0, 1, 2]))
  .setBuffer(buffer);
const moves = doc
  .createAccessor()
  .setType("VEC3")
  .setArray(new Float32Array([0, 0, 0, 0, 0.3, 0, 0, 0, 0]))
  .setBuffer(buffer);
const sampler = doc
  .createAnimationSampler()
  .setInput(times)
  .setOutput(moves)
  .setInterpolation("LINEAR");
const channel = doc
  .createAnimationChannel()
  .setTargetNode(rig)
  .setTargetPath("translation")
  .setSampler(sampler);
doc.createAnimation("Bob").addSampler(sampler).addChannel(channel);

mkdirSync("public/models", { recursive: true });
mkdirSync("public/textures", { recursive: true });
writeFileSync("public/models/hero.glb", await new NodeIO().writeBinary(doc));
writeFileSync("public/textures/ground.png", checker(64, [70, 120, 70], [40, 80, 40]));
