// A Draco-compressed model, an uncompressed KTX2 texture, and three's own decoders under public/.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);

function torusKnot(segments, radial) {
  const pos = [];
  const idx = [];
  const p = 2;
  const q = 3;
  const point = (u) => {
    const r = 0.6 * (2 + Math.cos((q * u) / p)) * 0.5;
    return [r * Math.cos(u), r * Math.sin(u), 0.3 * Math.sin((q * u) / p)];
  };
  for (let i = 0; i <= segments; i++) {
    const u = (i / segments) * p * Math.PI * 2;
    const c = point(u);
    const n = point(u + 0.01);
    const t = n.map((v, k) => v - c[k]);
    const len = Math.hypot(...t);
    const tt = t.map((v) => v / len);
    const b = [tt[1], -tt[0], 0];
    const bl = Math.hypot(...b) || 1;
    const bn = b.map((v) => v / bl);
    const nn = [
      tt[1] * bn[2] - tt[2] * bn[1],
      tt[2] * bn[0] - tt[0] * bn[2],
      tt[0] * bn[1] - tt[1] * bn[0],
    ];
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const cx = -0.12 * Math.cos(v);
      const cy = 0.12 * Math.sin(v);
      pos.push(
        c[0] + cx * nn[0] + cy * bn[0],
        c[1] + cx * nn[1] + cy * bn[1],
        c[2] + cx * nn[2] + cy * bn[2],
      );
    }
  }
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx) };
}

const knot = torusKnot(160, 16);
const gold = doc
  .createMaterial("Gold")
  .setBaseColorFactor([1, 0.8, 0.3, 1])
  .setMetallicFactor(1)
  .setRoughnessFactor(0.3);
const prim = doc
  .createPrimitive()
  .setAttribute("POSITION", acc("VEC3", knot.pos))
  .setIndices(acc("SCALAR", knot.idx))
  .setMaterial(gold);
const sculpture = doc
  .createNode("Sculpture")
  .setMesh(doc.createMesh("KnotMesh").addPrimitive(prim));
doc
  .createScene("Gallery")
  .addChild(doc.createNode("Plinth").addChild(sculpture).setTranslation([0, 1, 0]));
doc
  .createExtension(KHRDracoMeshCompression)
  .setRequired(true)
  .setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER });

const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});
mkdirSync("public/models", { recursive: true });
writeFileSync("public/models/sculpture.glb", await io.writeBinary(doc));

// An uncompressed KTX2 (VK_FORMAT_R8G8B8A8_SRGB): KTX2Loader reads it without the transcoder.
function ktx2(width, height, rgba) {
  const id = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  const dfdBlock = 24 + 16 * 4;
  const dfdLength = 4 + dfdBlock;
  const dfdOffset = 80 + 24;
  const dataOffset = Math.ceil((dfdOffset + dfdLength) / 16) * 16;
  const out = Buffer.alloc(dataOffset + rgba.length);
  id.forEach((v, i) => {
    out[i] = v;
  });
  out.writeUInt32LE(43, 12);
  out.writeUInt32LE(1, 16);
  out.writeUInt32LE(width, 20);
  out.writeUInt32LE(height, 24);
  out.writeUInt32LE(1, 36);
  out.writeUInt32LE(1, 40);
  out.writeUInt32LE(dfdOffset, 48);
  out.writeUInt32LE(dfdLength, 52);
  out.writeBigUInt64LE(BigInt(dataOffset), 80);
  out.writeBigUInt64LE(BigInt(rgba.length), 88);
  out.writeBigUInt64LE(BigInt(rgba.length), 96);
  const o = dfdOffset;
  out.writeUInt32LE(dfdLength, o);
  out.writeUInt16LE(2, o + 8);
  out.writeUInt16LE(dfdBlock, o + 10);
  out[o + 12] = 1;
  out[o + 13] = 1;
  out[o + 14] = 2;
  out[o + 20] = 4;
  for (let i = 0; i < 4; i++) {
    const s = o + 28 + i * 16;
    out.writeUInt16LE(i * 8, s);
    out[s + 2] = 7;
    out[s + 3] = [0, 1, 2, 15][i] | (i === 3 ? 0x10 : 0);
    out.writeUInt32LE(255, s + 12);
  }
  Buffer.from(rgba).copy(out, dataOffset);
  return out;
}
const size = 64;
const rgba = new Uint8Array(size * size * 4);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const stripe = ((x + y) >> 3) % 2 === 0;
    rgba[i] = stripe ? 200 : 60;
    rgba[i + 1] = stripe ? 190 : 60;
    rgba[i + 2] = stripe ? 170 : 70;
    rgba[i + 3] = 255;
  }
mkdirSync("public/textures", { recursive: true });
writeFileSync("public/textures/wall.ktx2", ktx2(size, size, rgba));

// The decoders, as the site would ship them.
const require = createRequire(import.meta.url);
const libs = path.join(path.dirname(require.resolve("three")), "..", "examples", "jsm", "libs");
cpSync(path.join(libs, "draco", "gltf"), "public/draco", { recursive: true });
cpSync(path.join(libs, "basis"), "public/basis", { recursive: true });
