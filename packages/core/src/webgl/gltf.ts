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
