import type { Document } from "@gltf-transform/core";
import { EXTMeshoptCompression, EXTTextureWebP } from "@gltf-transform/extensions";
import { prune, quantize, simplifyPrimitive, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { placeholderPng } from "./formats.js";
import { gltfIO, isAnimatedMesh, trianglesOf } from "./gltf.js";
import type { MediaTools } from "./media.js";

export const DEFAULT_CLONE_RATIO = 0.25;
export const DEFAULT_CLONE_TEXTURE = 512;
/** Simplification error limits tried in turn until the triangle budget is met. */
export const CLONE_ERRORS = [0.001, 0.01, 0.05, 0.2];
/** A model meets its budget at up to this much over `ratio × triangles`. */
export const BUDGET_SLACK = 1.1;
/** Meshes this small are left alone; there is nothing to gain. */
const MIN_TRIANGLES = 64;

/** Extensions a clone keeps: structure, plus the ones its own encoding uses. */
const KEEP = new Set([
  "KHR_lights_punctual",
  "EXT_mesh_gpu_instancing",
  "KHR_mesh_quantization",
  "EXT_texture_webp",
  "EXT_meshopt_compression",
  "KHR_materials_emissive_strength",
]);

export interface CloneOptions {
  ratio: number;
  textureSize: number;
  /** Write meshopt-compressed buffers (only when the site's loader has a meshopt decoder). */
  meshopt: boolean;
  media: MediaTools;
}

export interface CloneReport {
  staticTriangles: [number, number];
  animatedTriangles: [number, number];
  budget: number;
  withinBudget: boolean;
  errorUsed: number;
  textures: {
    name: string;
    from: [number | null, number | null];
    to: [number, number];
    note?: string;
  }[];
  texturesWithinBudget: boolean;
  notes: string[];
}

/**
 * The clone of a captured model: static meshes simplified to `ratio` of their triangles, skinned
 * and morphed meshes welded and quantized but not simplified (rigs keep working), materials down
 * to base colour, normal and metal/roughness, textures downscaled and re-encoded as WebP. Hierarchy,
 * node names and every animation clip stay. Still the site's art: local study only.
 */
export async function cloneModel(
  doc: Document,
  options: CloneOptions,
): Promise<{ bytes: Uint8Array; report: CloneReport }> {
  const root = doc.getRoot();
  const notes: string[] = [];
  const isStatic = (n: Parameters<typeof isAnimatedMesh>[0]) => !isAnimatedMesh(n);
  const before = trianglesOf(doc, isStatic);
  const animatedBefore = trianglesOf(doc, isAnimatedMesh);
  const budget = Math.ceil(before * options.ratio * BUDGET_SLACK);

  await doc.transform(weld());
  await MeshoptSimplifier.ready;
  const staticPrims = new Set(
    root
      .listNodes()
      .filter((n) => n.getMesh() && isStatic(n))
      .flatMap((n) => n.getMesh()?.listPrimitives() ?? []),
  );
  // A mesh shared by a skinned and a static node is treated as animated.
  for (const n of root.listNodes())
    if (n.getMesh() && !isStatic(n))
      for (const p of n.getMesh()?.listPrimitives() ?? []) staticPrims.delete(p);
  const primTris = (prim: typeof staticPrims extends Set<infer P> ? P : never) => {
    const idx = prim.getIndices();
    return idx ? idx.getCount() / 3 : (prim.getAttribute("POSITION")?.getCount() ?? 0) / 3;
  };
  // Each primitive aims at its own share of the budget; later passes allow a larger error.
  const targets = new Map([...staticPrims].map((p) => [p, Math.ceil(primTris(p) * options.ratio)]));
  let errorUsed = 0;
  for (const error of CLONE_ERRORS) {
    errorUsed = error;
    for (const prim of staticPrims) {
      const now = primTris(prim);
      const target = targets.get(prim) ?? now;
      if (now < MIN_TRIANGLES || now <= target * BUDGET_SLACK) continue;
      simplifyPrimitive(prim, {
        simplifier: MeshoptSimplifier,
        ratio: target / now,
        error,
        lockBorder: false,
      });
    }
    if (trianglesOf(doc, isStatic) <= Math.max(budget, MIN_TRIANGLES)) break;
  }
  const after = trianglesOf(doc, isStatic);

  for (const material of root.listMaterials()) {
    material.setOcclusionTexture(null).setEmissiveTexture(null);
    for (const ext of material.listExtensions())
      if (!KEEP.has(ext.extensionName)) material.setExtension(ext.extensionName, null);
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }));

  const textures: CloneReport["textures"] = [];
  let webp = false;
  for (const texture of root.listTextures()) {
    const name = texture.getName() || texture.getURI() || `texture-${textures.length}`;
    const size = texture.getSize();
    const image = texture.getImage();
    const mime = texture.getMimeType();
    let result =
      image && mime !== "image/ktx2"
        ? await options.media.toWebp(image, mime, options.textureSize)
        : null;
    let note: string | undefined;
    if (!result) {
      // KTX2/Basis and anything Chromium can't decode: a flat stand-in, said so in ASSETS.md.
      note =
        mime === "image/ktx2"
          ? "KTX2 can't be decoded without native tools; replaced by a flat texture"
          : "could not be decoded; replaced by a flat texture";
      result = await options.media.toWebp(placeholderPng(4, 4), "image/png", options.textureSize);
    }
    if (!result) continue;
    texture.setImage(new Uint8Array(result.bytes)).setMimeType("image/webp");
    if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.[^./]+$/, ".webp"));
    webp = true;
    textures.push({
      name,
      from: [size?.[0] ?? null, size?.[1] ?? null],
      to: [result.width, result.height],
      ...(note ? { note } : {}),
    });
    if (note) notes.push(`${name}: ${note}`);
  }

  for (const ext of root.listExtensionsUsed()) if (!KEEP.has(ext.extensionName)) ext.dispose();
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true);
  await doc.transform(quantize());
  if (options.meshopt)
    doc
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  else
    root
      .listExtensionsUsed()
      .find((e) => e.extensionName === "EXT_meshopt_compression")
      ?.dispose();

  const io = await gltfIO();
  const bytes = await io.writeBinary(doc);
  return {
    bytes,
    report: {
      staticTriangles: [before, after],
      animatedTriangles: [animatedBefore, trianglesOf(doc, isAnimatedMesh)],
      budget,
      withinBudget: before < MIN_TRIANGLES || after <= Math.max(budget, MIN_TRIANGLES),
      errorUsed,
      textures,
      texturesWithinBudget: textures.every((t) => Math.max(...t.to) <= options.textureSize),
      notes,
    },
  };
}
