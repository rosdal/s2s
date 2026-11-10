import { type Document, type Node, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

/** gltf-transform IO with every extension registered and Draco and meshopt codecs loaded. */
let io: Promise<NodeIO> | undefined;
export function gltfIO(): Promise<NodeIO> {
  io ??= (async () => {
    const draco = (await import("draco3dgltf")).default;
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "draco3d.decoder": await draco.createDecoderModule(),
      "draco3d.encoder": await draco.createEncoderModule(),
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
  })();
  return io;
}

/**
 * Read a captured model: a GLB, or a `.gltf` whose buffers and images are fetched by URL from
 * `resource` (the capture's bodies).
 */
export async function readModel(
  bytes: Uint8Array,
  url: string,
  resource: (absoluteUrl: string) => Promise<Uint8Array | undefined>,
): Promise<Document> {
  const reader = await gltfIO();
  const magic = Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString("ascii");
  if (magic === "glTF") return reader.readBinary(bytes);
  const json = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (!item.uri || item.uri.startsWith("data:")) continue;
    const data = await resource(new URL(item.uri, url).href);
    if (data) resources[item.uri] = new Uint8Array(data);
  }
  return reader.readJSON({ json: json as never, resources });
}

/** three's `PropertyBinding.sanitizeNodeName`: what GLTFLoader turns a glTF node name into. */
export function sanitizeNodeName(name: string): string {
  return name.replace(/\s/g, "_").replace(/[[\].:/]/g, "");
}

export interface ModelSummary {
  nodes: string[];
  meshes: number;
  triangles: number;
  /** Triangles in meshes that are neither skinned nor morphed. */
  staticTriangles: number;
  materials: string[];
  textures: {
    name: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    bytes: number;
  }[];
  animations: { name: string; channels: number; weights: boolean }[];
  skins: number;
  morphs: boolean;
  extensions: string[];
}

export function trianglesOf(doc: Document, filter?: (node: Node) => boolean): number {
  let n = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || (filter && !filter(node))) continue;
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0);
      if (prim.getMode() === 4) n += Math.floor(count / 3);
    }
  }
  return n;
}

export const isAnimatedMesh = (node: Node) =>
  node.getSkin() !== null ||
  (node
    .getMesh()
    ?.listPrimitives()
    .some((p) => p.listTargets().length > 0) ??
    false);

export function summarize(doc: Document): ModelSummary {
  const root = doc.getRoot();
  return {
    nodes: root
      .listNodes()
      .map((n) => sanitizeNodeName(n.getName()))
      .filter(Boolean),
    meshes: root.listMeshes().length,
    triangles: trianglesOf(doc),
    staticTriangles: trianglesOf(doc, (n) => !isAnimatedMesh(n)),
    materials: root.listMaterials().map((m) => m.getName()),
    textures: root.listTextures().map((t) => {
      const size = t.getSize();
      return {
        name: t.getName() || t.getURI(),
        mimeType: t.getMimeType(),
        width: size?.[0] ?? null,
        height: size?.[1] ?? null,
        bytes: t.getImage()?.byteLength ?? 0,
      };
    }),
    animations: root.listAnimations().map((a) => ({
      name: a.getName(),
      channels: a.listChannels().length,
      weights: a.listChannels().some((c) => c.getTargetPath() === "weights"),
    })),
    skins: root.listSkins().length,
    morphs: root
      .listMeshes()
      .some((m) => m.listPrimitives().some((p) => p.listTargets().length > 0)),
    extensions: root
      .listExtensionsUsed()
      .map((e) => e.extensionName)
      .sort(),
  };
}

/**
 * Whether a model stores its vertex attributes interleaved: a buffer view whose `byteStride` is
 * wider than the attribute it holds. three wraps those in an `InterleavedBuffer`, which takes a
 * UUID (four `Math.random()` calls), so a proxy keeps the layout the original had.
 */
export function interleavedVertices(bytes: Uint8Array): boolean {
  const json = gltfJson(bytes);
  if (!json) return false;
  for (const mesh of json.meshes ?? [])
    for (const prim of mesh.primitives ?? [])
      for (const index of Object.values(prim.attributes ?? {})) {
        const accessor = json.accessors?.[index];
        const stride =
          accessor?.bufferView === undefined
            ? undefined
            : json.bufferViews?.[accessor.bufferView]?.byteStride;
        const size =
          (COMPONENTS[accessor?.type ?? ""] ?? 0) *
          (COMPONENT_BYTES[accessor?.componentType ?? 0] ?? 0);
        if (stride && size && stride !== size) return true;
      }
  return false;
}

const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

interface GltfJson {
  bufferViews?: { byteStride?: number }[];
  accessors?: { bufferView?: number; type?: string; componentType?: number }[];
  meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
}

/** The JSON of a GLB (its first chunk) or of a `.gltf` file. */
function gltfJson(bytes: Uint8Array): GltfJson | undefined {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.toString("ascii", 0, 4) !== "glTF") return JSON.parse(buf.toString("utf8"));
    const length = buf.readUInt32LE(12);
    return JSON.parse(buf.toString("utf8", 20, 20 + length));
  } catch {
    return undefined;
  }
}
