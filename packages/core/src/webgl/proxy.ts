import type { Document, Primitive } from "@gltf-transform/core";
import { prune } from "@gltf-transform/functions";
import { gltfIO } from "./gltf.js";

/** Extensions that carry structure, not art; proxies keep them. */
const STRUCTURAL = new Set(["KHR_lights_punctual", "EXT_mesh_gpu_instancing"]);

export type ProxyShape = "box" | "sphere" | "cylinder";

/** A sphere when the bounds are roughly cubic, a cylinder when two sides match, else a box. */
export function shapeFor(size: number[]): { shape: ProxyShape; axis: number } {
  const [x = 0, y = 0, z = 0] = size;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.2 * Math.max(a, b, 1e-9);
  if (near(x, y) && near(y, z) && near(x, z)) return { shape: "sphere", axis: 1 };
  if (near(x, z) && !near(x, y) && Math.min(x, z) > 1e-6) return { shape: "cylinder", axis: 1 };
  if (near(x, y) && !near(x, z) && Math.min(x, y) > 1e-6) return { shape: "cylinder", axis: 2 };
  if (near(y, z) && !near(x, y) && Math.min(y, z) > 1e-6) return { shape: "cylinder", axis: 0 };
  return { shape: "box", axis: 1 };
}

interface Geo {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

function unitBox(): Geo {
  const g: Geo = { pos: [], nor: [], uv: [], idx: [] };
  const faces: [number[], number[], number[]][] = [
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [n, u, v] of faces) {
    const base = g.pos.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as [number, number][]) {
      for (let i = 0; i < 3; i++)
        g.pos.push(0.5 * ((n[i] as number) + a * (u[i] as number) + b * (v[i] as number)));
      g.nor.push(...n);
      g.uv.push((a + 1) / 2, (b + 1) / 2);
    }
    g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return g;
}

function unitSphere(w = 16, h = 8): Geo {
  const g: Geo = { pos: [], nor: [], uv: [], idx: [] };
  for (let y = 0; y <= h; y++)
    for (let x = 0; x <= w; x++) {
      const u = x / w;
      const v = y / h;
      const nx = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const ny = Math.cos(v * Math.PI);
      const nz = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      g.pos.push(nx * 0.5, ny * 0.5, nz * 0.5);
      g.nor.push(nx, ny, nz);
      g.uv.push(u, 1 - v);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = y * (w + 1) + x;
      const b = a + w + 1;
      g.idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return g;
}

function unitCylinder(segments = 16): Geo {
  const g: Geo = { pos: [], nor: [], uv: [], idx: [] };
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const x = Math.cos(t);
    const z = Math.sin(t);
    for (const y of [-0.5, 0.5]) {
      g.pos.push(x * 0.5, y, z * 0.5);
      g.nor.push(x, 0, z);
      g.uv.push(i / segments, y + 0.5);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    g.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  for (const y of [-0.5, 0.5]) {
    const center = g.pos.length / 3;
    g.pos.push(0, y, 0);
    g.nor.push(0, Math.sign(y), 0);
    g.uv.push(0.5, 0.5);
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      g.pos.push(Math.cos(t) * 0.5, y, Math.sin(t) * 0.5);
      g.nor.push(0, Math.sign(y), 0);
      g.uv.push(0.5 + Math.cos(t) * 0.5, 0.5 + Math.sin(t) * 0.5);
    }
    for (let i = 0; i < segments; i++)
      if (y > 0) g.idx.push(center, center + i + 2, center + i + 1);
      else g.idx.push(center, center + i + 1, center + i + 2);
  }
  return g;
}

/** A unit shape scaled and moved to fill `min`..`max`, with the long axis of a cylinder kept. */
export function fittedShape(min: number[], max: number[]): { geo: Geo; shape: ProxyShape } {
  const size = max.map((v, i) => Math.max(v - (min[i] ?? 0), 1e-4));
  const center = max.map((v, i) => (v + (min[i] ?? 0)) / 2);
  const { shape, axis } = shapeFor(size);
  const geo = shape === "sphere" ? unitSphere() : shape === "cylinder" ? unitCylinder() : unitBox();
  // Rotate the cylinder's Y axis onto the long one.
  const swap = (v: number[]): number[] =>
    axis === 0
      ? [v[1] as number, v[0] as number, v[2] as number]
      : axis === 2
        ? [v[0] as number, v[2] as number, v[1] as number]
        : v;
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < geo.pos.length; i += 3) {
    const p = swap(geo.pos.slice(i, i + 3));
    const n = swap(geo.nor.slice(i, i + 3));
    for (let k = 0; k < 3; k++)
      pos.push((p[k] as number) * (size[k] as number) + (center[k] as number));
    const nn = n.map((v, k) => v / (size[k] as number));
    const len = Math.hypot(...nn) || 1;
    nor.push(...nn.map((v) => v / len));
  }
  // An odd number of axis swaps mirrors the shape; flip the winding back.
  const idx =
    axis === 1
      ? geo.idx
      : geo.idx.map((_, i, a) => a[i - (i % 3) + ([0, 2, 1][i % 3] as number)] as number);
  return { geo: { pos, nor, uv: geo.uv, idx }, shape };
}

export interface ProxyReport {
  meshes: { mesh: string; primitives: { shape: ProxyShape; material: string }[] }[];
  materials: string[];
  texturesDropped: { name: string; width: number | null; height: number | null }[];
  channelsDropped: number;
  skinsDropped: number;
}

/**
 * Grow `geo` to `count` vertices by repeating its own, without new triangles. Site code often
 * loops over a model's vertices (particles seeded with `Math.random()` per vertex, say), so a
 * proxy with fewer vertices shifts the seeded random sequence and everything placed after it.
 */
export function padVertices(geo: Geo, count: number): void {
  const own = geo.pos.length / 3;
  for (let i = own; i < count; i++) {
    const from = i % own;
    geo.pos.push(...geo.pos.slice(3 * from, 3 * from + 3));
    geo.nor.push(...geo.nor.slice(3 * from, 3 * from + 3));
    geo.uv.push(...geo.uv.slice(2 * from, 2 * from + 2));
  }
}

function replaceGeometry(doc: Document, prim: Primitive): ProxyShape {
  const position = prim.getAttribute("POSITION");
  // Quantized positions store normalized integers; their bounds are read normalized.
  const normalized = position?.getNormalized() ?? false;
  const min = (normalized ? position?.getMinNormalized([]) : position?.getMin([])) ?? [
    -0.5, -0.5, -0.5,
  ];
  const max = (normalized ? position?.getMaxNormalized([]) : position?.getMax([])) ?? [
    0.5, 0.5, 0.5,
  ];
  const fitted = fittedShape(min, max);
  padVertices(fitted.geo, position?.getCount() ?? 0);
  for (const semantic of prim.listSemantics()) prim.setAttribute(semantic, null);
  for (const target of prim.listTargets()) prim.removeTarget(target);
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const acc = (type: "VEC3" | "VEC2" | "SCALAR", array: Float32Array | Uint16Array | Uint32Array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  prim.setAttribute("POSITION", acc("VEC3", new Float32Array(fitted.geo.pos)));
  prim.setAttribute("NORMAL", acc("VEC3", new Float32Array(fitted.geo.nor)));
  prim.setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(fitted.geo.uv)));
  const count = fitted.geo.pos.length / 3;
  prim.setIndices(
    acc(
      "SCALAR",
      count > 65535 ? new Uint32Array(fitted.geo.idx) : new Uint16Array(fitted.geo.idx),
    ),
  );
  prim.setMode(4);
  return fitted.shape;
}

/**
 * The proxy of a captured model: the same scenes, nodes, names, transforms, cameras, lights and
 * transform animations; every mesh primitive a box, sphere or cylinder filling its bounds; every
 * material a flat one named after the original slot; no textures, skins or morph targets. The art
 * is gone, the choreography stays.
 */
export async function proxyModel(
  doc: Document,
): Promise<{ bytes: Uint8Array; report: ProxyReport }> {
  const root = doc.getRoot();
  const report: ProxyReport = {
    meshes: [],
    materials: [],
    texturesDropped: [],
    channelsDropped: 0,
    skinsDropped: 0,
  };
  for (const mesh of root.listMeshes()) {
    const prims = mesh.listPrimitives().map((prim) => ({
      shape: replaceGeometry(doc, prim),
      material: prim.getMaterial()?.getName() ?? "",
    }));
    mesh.setWeights([]);
    report.meshes.push({ mesh: mesh.getName(), primitives: prims });
  }
  for (const material of root.listMaterials()) {
    material
      .setBaseColorTexture(null)
      .setNormalTexture(null)
      .setOcclusionTexture(null)
      .setEmissiveTexture(null)
      .setMetallicRoughnessTexture(null);
    for (const ext of material.listExtensions()) material.setExtension(ext.extensionName, null);
    report.materials.push(material.getName());
  }
  for (const texture of root.listTextures()) {
    const size = texture.getSize();
    report.texturesDropped.push({
      name: texture.getName() || texture.getURI(),
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
    });
    texture.dispose();
  }
  for (const node of root.listNodes()) {
    if (node.getSkin()) node.setSkin(null);
    node.setWeights([]);
  }
  for (const skin of root.listSkins()) {
    skin.dispose();
    report.skinsDropped++;
  }
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels())
      if (channel.getTargetPath() === "weights") {
        channel.dispose();
        report.channelsDropped++;
      }
    if (animation.listChannels().length === 0) animation.dispose();
  }
  for (const ext of root.listExtensionsUsed())
    if (!STRUCTURAL.has(ext.extensionName)) ext.dispose();
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }));
  const io = await gltfIO();
  return { bytes: await io.writeBinary(doc), report };
}
