// A rigged, animated character and two static props, written deterministically.
import { mkdirSync, writeFileSync } from "node:fs";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";

const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);

function noisePng(size, seed) {
  const png = new PNG({ width: size, height: size });
  let a = seed;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  for (let i = 0; i < size * size; i++) {
    const v = 90 + Math.floor(rnd() * 80);
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v - 20;
    png.data[i * 4 + 2] = v - 40;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// The character: a 2-bone cylinder, weighted by height.
const radial = 24;
const rings = 24;
const height = 2;
const pos = [];
const nor = [];
const joints = [];
const weights = [];
const idx = [];
for (let y = 0; y <= rings; y++) {
  const h = (y / rings) * height;
  const w = h / height;
  for (let x = 0; x <= radial; x++) {
    const t = (x / radial) * Math.PI * 2;
    pos.push(Math.cos(t) * 0.3, h, Math.sin(t) * 0.3);
    nor.push(Math.cos(t), 0, Math.sin(t));
    joints.push(0, 1, 0, 0);
    weights.push(1 - w, w, 0, 0);
  }
}
for (let y = 0; y < rings; y++)
  for (let x = 0; x < radial; x++) {
    const a = y * (radial + 1) + x;
    const b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
const skinMaterial = doc.createMaterial("Skin").setBaseColorFactor([0.8, 0.6, 0.5, 1]);
const bodyPrim = doc
  .createPrimitive()
  .setAttribute("POSITION", acc("VEC3", new Float32Array(pos)))
  .setAttribute("NORMAL", acc("VEC3", new Float32Array(nor)))
  .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(joints)))
  .setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array(weights)))
  .setIndices(acc("SCALAR", new Uint16Array(idx)))
  .setMaterial(skinMaterial);
const hips = doc.createNode("Hips").setTranslation([0, 0, 0]);
const spine = doc.createNode("Spine").setTranslation([0, 1, 0]);
hips.addChild(spine);
const inverse = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
]);
const skin = doc
  .createSkin("CharacterSkin")
  .addJoint(hips)
  .addJoint(spine)
  .setInverseBindMatrices(acc("MAT4", inverse));
const body = doc
  .createNode("Body")
  .setMesh(doc.createMesh("BodyMesh").addPrimitive(bodyPrim))
  .setSkin(skin);
const character = doc
  .createNode("Character")
  .addChild(hips)
  .addChild(body)
  .setTranslation([-1.2, 0, 0]);

const times = acc("SCALAR", new Float32Array([0, 1, 2]));
const turn = Math.sin(Math.PI / 8);
const rot = acc(
  "VEC4",
  new Float32Array([0, 0, 0, 1, 0, 0, turn, Math.cos(Math.PI / 8), 0, 0, 0, 1]),
);
const sampler = doc
  .createAnimationSampler()
  .setInput(times)
  .setOutput(rot)
  .setInterpolation("LINEAR");
const channel = doc
  .createAnimationChannel()
  .setTargetNode(spine)
  .setTargetPath("rotation")
  .setSampler(sampler);
doc.createAnimation("Wave").addSampler(sampler).addChannel(channel);

// Props: a dense rock (worth simplifying) with a texture and an occlusion map, and a crate.
function sphere(radius, w, h) {
  const p = [];
  const n = [];
  const uv = [];
  const ix = [];
  for (let y = 0; y <= h; y++)
    for (let x = 0; x <= w; x++) {
      const u = x / w;
      const v = y / h;
      const nx = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const ny = Math.cos(v * Math.PI);
      const nz = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const bump = 1 + 0.08 * Math.sin(u * 40) * Math.sin(v * 30);
      p.push(nx * radius * bump, ny * radius * bump, nz * radius * bump);
      n.push(nx, ny, nz);
      uv.push(u, v);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = y * (w + 1) + x;
      const b = a + w + 1;
      ix.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return { p, n, uv, ix };
}
const rock = sphere(0.7, 96, 48);
const rockTexture = doc
  .createTexture("RockColor")
  .setImage(noisePng(256, 7))
  .setMimeType("image/png");
const rockAo = doc
  .createTexture("RockOcclusion")
  .setImage(noisePng(256, 9))
  .setMimeType("image/png");
const stone = doc
  .createMaterial("Stone")
  .setBaseColorTexture(rockTexture)
  .setOcclusionTexture(rockAo)
  .setRoughnessFactor(0.9);
const rockPrim = doc
  .createPrimitive()
  .setAttribute("POSITION", acc("VEC3", new Float32Array(rock.p)))
  .setAttribute("NORMAL", acc("VEC3", new Float32Array(rock.n)))
  .setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(rock.uv)))
  .setIndices(acc("SCALAR", new Uint16Array(rock.ix)))
  .setMaterial(stone);
const rockNode = doc
  .createNode("Rock")
  .setMesh(doc.createMesh("RockMesh").addPrimitive(rockPrim))
  .setTranslation([1.2, 0.7, 0]);
const crateGeo = sphere(0.3, 6, 4);
const wood = doc.createMaterial("Wood").setBaseColorFactor([0.6, 0.4, 0.2, 1]);
const cratePrim = doc
  .createPrimitive()
  .setAttribute("POSITION", acc("VEC3", new Float32Array(crateGeo.p)))
  .setIndices(acc("SCALAR", new Uint16Array(crateGeo.ix)))
  .setMaterial(wood);
const crate = doc
  .createNode("Crate")
  .setMesh(doc.createMesh("CrateMesh").addPrimitive(cratePrim))
  .setTranslation([0, 0.3, 1]);
doc.createScene("Stage").addChild(character).addChild(rockNode).addChild(crate);

mkdirSync("public/models", { recursive: true });
writeFileSync("public/models/stage.glb", await new NodeIO().writeBinary(doc));
