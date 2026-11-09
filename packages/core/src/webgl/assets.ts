import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type RequestRecord, readRequestLog, requestTags } from "../capture/request-log.js";
import type { WorkspacePaths } from "../capture/workspace.js";
import { writeFileAtomic, writeJsonAtomic } from "../fs-util.js";
import { type WebglIndex, webglDir } from "./capture-pass.js";
import { type CloneReport, cloneModel } from "./clone.js";
import {
  decodeHdr,
  downscaleRgb,
  encodeExr,
  encodeHdr,
  gradientPixels,
  imageSize,
  isKtx2,
  ktx2Rgba,
  pcm8Wav,
  placeholderPng,
  silentWav,
} from "./formats.js";
import { type ModelSummary, readModel, sanitizeNodeName, summarize } from "./gltf.js";
import { type MediaTools, withMedia } from "./media.js";
import { type ProxyReport, proxyModel } from "./proxy.js";
import { decodeSnapshot, type SceneSnapshot, type StoredSnapshot } from "./snapshot.js";

export const ASSET_MODES = ["proxy", "clone", "original"] as const;
export type AssetMode = (typeof ASSET_MODES)[number];

export type AssetType =
  | "model"
  | "model-resource"
  | "texture"
  | "environment"
  | "audio"
  | "decoder";

export interface AssetRecord {
  /** The URL the site loaded it from, without query or hash. */
  url: string;
  /** Path under `project/`, posix, such as `public/models/hero.glb`; `null` when not written. */
  file: string | null;
  bodyHash: string;
  type: AssetType;
  bytes: number;
  mimeType: string | null;
  model?: ModelSummary;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  usedBy: { nodes: string[]; modules: string[]; keyframes: string[] };
  output: {
    kind: "proxy" | "clone" | "original" | "placeholder" | "dropped" | "decoder";
    /** Derived from (or a copy of) the site's art: local study only. */
    derived: boolean;
    bytes: number;
    hash: string | null;
    proxy?: ProxyReport;
    clone?: CloneReport;
    note?: string;
  };
}

export interface AssetsFile {
  mode: AssetMode;
  localOnly: boolean;
  assets: AssetRecord[];
  checks: {
    leak: { passed: boolean; files: string[] } | null;
    unchangedCopies: { passed: boolean; files: string[] } | null;
    budgets: { passed: boolean; failures: string[] } | null;
  };
}

export const LOCAL_ONLY_NOTICE =
  "These assets are derived from the site's own models, textures and sounds. They belong to the site's authors and are for local study only: don't publish, share or ship them.";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const strip = (u: string) => u.replace(/[?#].*$/, "");
const posix = (p: string) => p.split(path.sep).join("/");
const IMAGE = /^image\/(?:png|jpeg|webp|gif|avif|ktx2)$/;

async function listFiles(
  dir: string,
  skip: (rel: string) => boolean = () => false,
): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !skip(posix(path.relative(dir, f))))
    .sort();
}

/** Every keyframe snapshot of a page and viewport, decoded. */
export async function readKeyframes(
  paths: WorkspacePaths,
  page: string,
  viewport: string,
  ids: string[],
): Promise<Map<string, SceneSnapshot>> {
  const out = new Map<string, SceneSnapshot>();
  let base: SceneSnapshot | undefined;
  for (const id of ids) {
    const file = path.join(webglDir(paths), page, viewport, `${id}.json`);
    if (!existsSync(file)) continue;
    const stored = JSON.parse(await readFile(file, "utf8")) as StoredSnapshot;
    const snap = decodeSnapshot(stored, base);
    if (stored.full) base = snap;
    out.set(id, snap);
  }
  return out;
}

export async function readWebglIndex(paths: WorkspacePaths): Promise<WebglIndex | null> {
  try {
    return JSON.parse(
      await readFile(path.join(webglDir(paths), "index.json"), "utf8"),
    ) as WebglIndex;
  } catch {
    return null;
  }
}

/** Where an asset goes in the project: its own URL path under `public/`, so the code still finds it. */
export function publicPath(url: string, siteOrigin: string): string {
  const u = new URL(url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  return u.origin === siteOrigin ? `public/${rel}` : `public/_external/${u.host}/${rel}`;
}

interface Planned {
  record: RequestRecord;
  type: AssetType;
}

/** The 3D assets in a capture: tagged models, textures, environment maps, audio and decoders. */
export function planAssets(records: RequestRecord[], textureUrls: Set<string>): Planned[] {
  const seen = new Map<string, Planned>();
  for (const r of records) {
    if (!r.bodyHash || r.status < 200 || r.status >= 300) continue;
    const url = strip(r.url);
    if (seen.has(url)) continue;
    // Tags as captured, and as today's rules read the URL (a capture made before `.ktx` counted).
    const tags = [...new Set([...(r.tags ?? []), ...requestTags(r.url, r.mimeType)])];
    let type: AssetType | undefined;
    if (tags.some((t) => t.startsWith("decoder:"))) type = "decoder";
    else if (tags.includes("asset:model")) type = "model";
    else if (tags.includes("asset:environment")) type = "environment";
    else if (tags.includes("asset:audio")) type = "audio";
    else if (tags.includes("asset:texture")) type = "texture";
    else if (textureUrls.has(url) && IMAGE.test(r.mimeType ?? "")) type = "texture";
    if (type) seen.set(url, { record: r, type });
  }
  return [...seen.values()].sort((a, b) => a.record.url.localeCompare(b.record.url));
}

export interface AssetBuildOptions {
  mode: AssetMode;
  cloneRatio: number;
  cloneTexture: number;
  headless?: boolean;
  executablePath?: string;
  warn: (message: string) => void;
}

/**
 * Write the project's assets for the chosen mode, the asset map (`analysis/assets.json`) and the
 * swap guide (`ASSETS.md`), then run the mode's checks.
 */
export async function buildAssets(
  paths: WorkspacePaths,
  siteUrl: string,
  options: AssetBuildOptions,
): Promise<AssetsFile> {
  const records = await readRequestLog(paths.requests).catch(() => [] as RequestRecord[]);
  const bodyOf = new Map<string, string>();
  for (const r of records)
    if (r.bodyHash && r.status >= 200 && r.status < 300) bodyOf.set(strip(r.url), r.bodyHash);
  const readBody = (hash: string) => readFile(path.join(paths.bodies, hash));
  const index = await readWebglIndex(paths);
  const origin = new URL(siteUrl).origin;

  // Every snapshot of the primary viewport, by page, for "where is it used".
  const snaps: { page: string; keyframe: string; snap: SceneSnapshot }[] = [];
  for (const page of index?.pages ?? []) {
    const v = page.viewports[0];
    if (!v) continue;
    const decoded = await readKeyframes(
      paths,
      page.slug,
      v.viewport,
      v.keyframes.map((k) => k.id),
    );
    for (const [keyframe, snap] of decoded) snaps.push({ page: page.slug, keyframe, snap });
  }
  const textureUrls = new Set<string>();
  for (const { snap } of snaps)
    for (const t of snap.textures) if (t.url) textureUrls.add(strip(t.url));

  const planned = planAssets(records, textureUrls);
  const projectCode = await listFiles(path.join(paths.project, "src"));
  const codeTexts = new Map<string, string>();
  for (const f of projectCode)
    if (/\.[cm]?[jt]sx?$/.test(f))
      codeTexts.set(posix(path.relative(paths.project, f)), await readFile(f, "utf8"));
  const modulesUsing = (url: string) => {
    const base = path.posix.basename(new URL(url).pathname);
    return [...codeTexts]
      .filter(([, text]) => text.includes(base))
      .map(([f]) => f)
      .sort();
  };
  const meshoptInCode = [...codeTexts.values()].some((t) => /\.setMeshoptDecoder\(/.test(t));

  const assets: AssetRecord[] = [];
  const pending: Pending = new Map();
  await withMedia(
    {
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    },
    async (media) => {
      for (const { record, type } of planned) {
        const url = strip(record.url);
        const body = await readBody(record.bodyHash as string);
        const asset: AssetRecord = {
          url,
          file: type === "decoder" ? null : publicPath(url, origin),
          bodyHash: record.bodyHash as string,
          type,
          bytes: body.length,
          mimeType: record.mimeType,
          usedBy: { nodes: [], modules: modulesUsing(url), keyframes: [] },
          output: { kind: "dropped", derived: false, bytes: 0, hash: null },
        };
        assets.push(asset);
        try {
          await buildOne(asset, body, {
            media,
            options,
            snaps,
            bodyOf,
            readBody,
            meshopt: meshoptInCode,
            assets,
            origin,
            pending,
          });
        } catch (error) {
          options.warn(
            `${url}: could not make its ${options.mode} asset (${(error as Error).message.split("\n")[0]}); wrote a placeholder.`,
          );
          await writeOutput(
            paths,
            asset,
            placeholderFor(asset, body),
            "placeholder",
            false,
            "generation failed",
          );
        }
      }
    },
  );
  for (const [asset, out] of pending)
    await writeOutput(paths, asset, out.bytes, out.kind, out.derived, out.note);

  // Copies of the originals elsewhere in the project (Stage 4 pulls images into src/assets/)
  // become the new bytes too, so imports keep working and nothing original is left behind.
  const outputs = new Map<string, Buffer>();
  for (const a of assets)
    if (a.file && a.output.hash)
      outputs.set(a.bodyHash, await readFile(path.join(paths.project, a.file)));
  for (const file of await listFiles(paths.project, (rel) =>
    /^(?:node_modules|dist)\//.test(rel),
  )) {
    const rel = posix(path.relative(paths.project, file));
    if (assets.some((a) => a.file === rel)) continue;
    const hash = sha(await readFile(file));
    const replacement = outputs.get(hash);
    if (replacement && options.mode !== "original") await writeFile(file, replacement);
  }

  const file: AssetsFile = {
    mode: options.mode,
    localOnly: options.mode !== "proxy",
    assets,
    checks: {
      leak: options.mode === "proxy" ? await leakCheck(paths, assets) : null,
      unchangedCopies: options.mode === "clone" ? await leakCheck(paths, assets) : null,
      budgets:
        options.mode === "clone"
          ? (() => {
              const failures: string[] = [];
              for (const a of assets) {
                const c = a.output.clone;
                if (!c) continue;
                if (!c.withinBudget)
                  failures.push(
                    `${a.url}: ${c.staticTriangles[1]} static triangles, budget ${c.budget}`,
                  );
                if (!c.texturesWithinBudget)
                  failures.push(`${a.url}: a texture is over ${options.cloneTexture} px`);
              }
              return { passed: failures.length === 0, failures };
            })()
          : null,
    },
  };
  await writeJsonAtomic(path.join(paths.analysis, "assets.json"), file);
  await writeFileAtomic(path.join(paths.root, "ASSETS.md"), assetsMd(file, snaps.length > 0));
  if (file.checks.leak && !file.checks.leak.passed)
    options.warn(
      `Proxy leak check failed: ${file.checks.leak.files.join(", ")} hold original asset bytes.`,
    );
  if (file.checks.unchangedCopies && !file.checks.unchangedCopies.passed)
    options.warn(
      `Clone check failed: ${file.checks.unchangedCopies.files.join(", ")} are unchanged copies of captured assets.`,
    );
  if (file.checks.budgets && !file.checks.budgets.passed)
    for (const f of file.checks.budgets.failures) options.warn(`Clone budget: ${f}`);
  return file;
}

type Pending = Map<
  AssetRecord,
  { bytes: Uint8Array; kind: AssetRecord["output"]["kind"]; derived: boolean; note?: string }
>;

async function writeOutput(
  paths: WorkspacePaths,
  asset: AssetRecord,
  bytes: Uint8Array,
  kind: AssetRecord["output"]["kind"],
  derived: boolean,
  note?: string,
): Promise<void> {
  if (!asset.file) return;
  const out = path.join(paths.project, asset.file);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, bytes);
  asset.output = {
    ...asset.output,
    kind,
    derived,
    bytes: bytes.byteLength,
    hash: sha(bytes),
    ...(note ? { note } : {}),
  };
}

/** The stand-in environment map's size. */
const ENV_W = 128;
const ENV_H = 64;

function placeholderFor(asset: AssetRecord, body: Buffer): Uint8Array {
  if (asset.type === "audio") return silentWav(asset.durationMs ?? 1000);
  // PMREM needs a cube face of 16px or more (`width / 4`; r139 sizes its target `4 * face - 32`
  // high), so a smaller stand-in compiles shaders with `1 / 0` texel sizes.
  if (asset.type === "environment")
    return /\.exr$/i.test(asset.url)
      ? encodeExr(ENV_W, ENV_H, gradientPixels(ENV_W, ENV_H))
      : encodeHdr(ENV_W, ENV_H, gradientPixels(ENV_W, ENV_H));
  if (asset.type === "texture" && isKtx2(body)) return ktx2Rgba(4, 4, new Uint8Array(64).fill(128));
  return placeholderPng();
}

interface BuildContext {
  media: MediaTools;
  options: AssetBuildOptions;
  snaps: { page: string; keyframe: string; snap: SceneSnapshot }[];
  bodyOf: Map<string, string>;
  readBody: (hash: string) => Promise<Buffer>;
  meshopt: boolean;
  assets: AssetRecord[];
  origin: string;
  /** Outputs to write once every asset is built. */
  pending: Pending;
}

async function buildOne(asset: AssetRecord, body: Buffer, ctx: BuildContext): Promise<void> {
  const { mode } = ctx.options;
  const { pending } = ctx;
  const queue = (
    bytes: Uint8Array,
    kind: AssetRecord["output"]["kind"],
    derived: boolean,
    note?: string,
  ) => {
    pending.set(asset, { bytes, kind, derived, ...(note ? { note } : {}) });
  };
  if (asset.type === "decoder") {
    asset.output = {
      kind: "decoder",
      derived: false,
      bytes: 0,
      hash: null,
      note: "served from the three package, not copied from the site",
    };
    return;
  }
  if (asset.type === "model") {
    const resources: string[] = [];
    const load = async () =>
      readModel(new Uint8Array(body), asset.url, async (u) => {
        const hash = ctx.bodyOf.get(strip(u));
        if (!hash) return undefined;
        resources.push(strip(u));
        return new Uint8Array(await ctx.readBody(hash));
      });
    const doc = await load();
    asset.model = summarize(doc);
    // The snapshot nodes under the object this model was loaded into.
    const names = new Set(asset.model.nodes);
    const nodes = new Set<string>();
    const keyframes = new Set<string>();
    for (const { page, keyframe, snap } of ctx.snaps)
      for (const scene of snap.scenes) {
        const roots = scene.nodes
          .filter((n) => n.source && strip(n.source) === asset.url)
          .map((n) => n.path);
        for (const n of scene.nodes) {
          const under = roots.some((r) => n.path === r || n.path.startsWith(`${r}/`));
          const named = !roots.length && n.name !== null && names.has(sanitizeNodeName(n.name));
          if (!under && !named) continue;
          if (n.geometry) nodes.add(n.path);
          if (n.geometry && n.visible && n.frustum !== false) keyframes.add(`${page}/${keyframe}`);
        }
      }
    asset.usedBy.nodes = [...nodes].sort();
    asset.usedBy.keyframes = [...keyframes].sort();
    for (const r of resources) {
      const hash = ctx.bodyOf.get(r) as string;
      ctx.assets.push({
        url: r,
        file: null,
        bodyHash: hash,
        type: "model-resource",
        bytes: (await ctx.readBody(hash)).length,
        mimeType: null,
        usedBy: { nodes: [], modules: [], keyframes: [] },
        output: {
          kind: mode === "original" ? "original" : "dropped",
          derived: mode !== "proxy",
          bytes: 0,
          hash: null,
          note: `part of ${asset.url}`,
        },
      });
      const added = ctx.assets.at(-1);
      if (added && mode === "original") added.file = publicPath(r, ctx.origin);
    }
    if (mode === "original") {
      queue(body, "original", true);
      for (const a of ctx.assets)
        if (a.type === "model-resource" && a.file && a.output.note === `part of ${asset.url}`)
          pending.set(a, {
            bytes: await ctx.readBody(a.bodyHash),
            kind: "original",
            derived: true,
          });
      return;
    }
    if (mode === "proxy") {
      const out = await proxyModel(doc);
      queue(out.bytes, "proxy", false);
      asset.output.proxy = out.report;
      return;
    }
    const out = await cloneModel(await load(), {
      ratio: ctx.options.cloneRatio,
      textureSize: ctx.options.cloneTexture,
      meshopt: ctx.meshopt,
      media: ctx.media,
    });
    queue(out.bytes, "clone", true, out.report.notes.join("; ") || undefined);
    asset.output.clone = out.report;
    return;
  }
  if (asset.type === "texture") {
    const size = imageSize(body);
    asset.width = size?.width ?? null;
    asset.height = size?.height ?? null;
    const keyframes = new Set<string>();
    const nodes = new Set<string>();
    for (const { page, keyframe, snap } of ctx.snaps) {
      const idx = snap.textures
        .map((t, i) => (t.url && strip(t.url) === asset.url ? i : -1))
        .filter((i) => i >= 0);
      if (idx.length === 0) continue;
      for (const scene of snap.scenes)
        for (const n of scene.nodes)
          if (
            n.material?.some(
              (m) => m && Object.values(m.maps).some((v) => v !== null && idx.includes(v)),
            )
          ) {
            nodes.add(n.path);
            if (n.visible && n.frustum !== false) keyframes.add(`${page}/${keyframe}`);
          }
    }
    asset.usedBy.nodes = [...nodes].sort();
    asset.usedBy.keyframes = [...keyframes].sort();
    if (mode === "original") return queue(body, "original", true);
    if (mode === "proxy") return queue(placeholderFor(asset, body), "placeholder", false);
    if (isKtx2(body))
      return queue(
        placeholderFor(asset, body),
        "placeholder",
        true,
        "KTX2 can't be decoded without native tools; replaced by a flat texture",
      );
    const webp = await ctx.media.toWebp(
      body,
      asset.mimeType ?? "image/png",
      ctx.options.cloneTexture,
    );
    if (!webp)
      return queue(
        placeholderFor(asset, body),
        "placeholder",
        true,
        "could not be decoded; replaced by a flat texture",
      );
    return queue(webp.bytes, "clone", true);
  }
  if (asset.type === "environment") {
    if (mode === "original") return queue(body, "original", true);
    if (mode === "proxy")
      return queue(placeholderFor(asset, body), "placeholder", false, "neutral gradient");
    const hdr = /\.hdr$/i.test(asset.url) ? decodeHdr(body) : null;
    if (!hdr)
      return queue(
        placeholderFor(asset, body),
        "placeholder",
        true,
        "EXR can't be downscaled without native tools; replaced by a neutral gradient",
      );
    asset.width = hdr.width;
    asset.height = hdr.height;
    const small = downscaleRgb(hdr.width, hdr.height, hdr.rgb, 256);
    return queue(encodeHdr(small.width, small.height, small.rgb), "clone", true);
  }
  if (asset.type === "audio") {
    const info = await ctx.media.audioInfo(body);
    asset.durationMs = info?.durationMs ?? null;
    if (mode === "original") return queue(body, "original", true);
    if (mode === "proxy")
      return queue(
        silentWav(info?.durationMs ?? 1000),
        "placeholder",
        false,
        "silence, same duration",
      );
    const mono = await ctx.media.audioMono(body, 12_000);
    if (!mono)
      return queue(
        silentWav(info?.durationMs ?? 1000),
        "placeholder",
        true,
        "could not be decoded; replaced by silence",
      );
    return queue(pcm8Wav(mono, 12_000), "clone", true, "mono 12 kHz 8-bit WAV (96 kbps)");
  }
}

/**
 * Every file under `project/` (minus `node_modules` and `dist`) whose bytes equal a captured
 * model, texture, environment map or audio file. Proxy mode must have none; clone mode none either
 * (its files are all re-encoded).
 */
export async function leakCheck(
  paths: WorkspacePaths,
  assets: AssetRecord[],
): Promise<{ passed: boolean; files: string[] }> {
  const art = new Set(assets.filter((a) => a.type !== "decoder").map((a) => a.bodyHash));
  const files: string[] = [];
  for (const file of await listFiles(paths.project, (rel) => /^(?:node_modules|dist)\//.test(rel)))
    if (art.has(sha(await readFile(file)))) files.push(posix(path.relative(paths.project, file)));
  return { passed: files.length === 0, files };
}

const kb = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

const MODE_LINE: Record<AssetMode, string> = {
  proxy:
    "Mode: **proxy**. Every model, texture, environment map and sound is a generated stand-in with the original's name, bounds and timing. None of the site's art is in `project/`; restyle freely.",
  clone:
    "Mode: **clone**. Models are simplified copies of the originals, textures downscaled, sounds downsampled.",
  original: "Mode: **original**. The captured files are in `project/` unchanged.",
};

const SECTIONS: [AssetType, string][] = [
  ["model", "Models"],
  ["texture", "Textures"],
  ["environment", "Environment maps"],
  ["audio", "Audio"],
];

/** The swap guide: one section per asset with what it is, where it's used and how to replace it. */
export function assetsMd(file: AssetsFile, haveSnapshots: boolean): string {
  const lines: string[] = ["# ASSETS.md", "", MODE_LINE[file.mode], ""];
  if (file.localOnly) lines.push(`> **Local study only.** ${LOCAL_ONLY_NOTICE}`, "");
  lines.push(
    "Each asset below lists where it is used and what a replacement must keep. Tick it once you have replaced it with your own. The data behind this file is `analysis/assets.json`.",
    "",
  );
  if (!haveSnapshots)
    lines.push("No scene snapshots were captured, so node and keyframe usage is missing.", "");
  for (const [type, title] of SECTIONS) {
    const list = file.assets.filter((a) => a.type === type);
    if (list.length === 0) continue;
    lines.push(`## ${title}`, "");
    for (const a of list) {
      const name = path.posix.basename(new URL(a.url).pathname);
      lines.push(`### ${name}`, "");
      lines.push(`- [ ] Replaced with my own`);
      const facts = [`\`${a.file ?? a.url}\``, a.mimeType ?? type, `${kb(a.bytes)} original`];
      if (a.width && a.height) facts.push(`${a.width}×${a.height}`);
      if (a.durationMs) facts.push(`${(a.durationMs / 1000).toFixed(1)} s`);
      if (a.model) facts.push(`${a.model.triangles} triangles`, `${a.model.nodes.length} nodes`);
      lines.push(`- File: ${facts.join(" · ")}`);
      if (a.model) {
        lines.push(`- Nodes: ${a.model.nodes.map((n) => `\`${n}\``).join(", ") || "none"}`);
        lines.push(
          `- Material slots: ${a.model.materials.map((m) => `\`${m}\``).join(", ") || "none"}`,
        );
        if (a.model.animations.length > 0)
          lines.push(
            `- Animations: ${a.model.animations.map((c) => `\`${c.name || "unnamed"}\` (${c.channels} channels)`).join(", ")}`,
          );
      }
      if (a.output.proxy) {
        const shapes = a.output.proxy.meshes.flatMap((m) =>
          m.primitives.map((p) => `${m.mesh || "mesh"}: ${p.shape}`),
        );
        lines.push(
          `- Stand-in: ${shapes.join(", ") || "no meshes"}; flat materials ${a.output.proxy.materials.map((m) => `\`${m}\``).join(", ")}`,
        );
      } else if (a.output.clone) {
        const c = a.output.clone;
        lines.push(
          `- Clone: ${c.staticTriangles[0]} → ${c.staticTriangles[1]} static triangles (budget ${c.budget}), ${c.animatedTriangles[1]} in skinned or morphed meshes kept`,
        );
      } else if (a.output.kind !== "original") {
        lines.push(`- Stand-in: ${a.output.note ?? a.output.kind}`);
      }
      if (a.output.note && (a.output.proxy || a.output.clone))
        lines.push(`- Note: ${a.output.note}`);
      if (a.usedBy.nodes.length > 0)
        lines.push(
          `- Scene nodes: ${a.usedBy.nodes
            .slice(0, 12)
            .map((n) => `\`${n}\``)
            .join(
              ", ",
            )}${a.usedBy.nodes.length > 12 ? ` and ${a.usedBy.nodes.length - 12} more` : ""}`,
        );
      if (a.usedBy.modules.length > 0)
        lines.push(`- Loaded by: ${a.usedBy.modules.map((m) => `\`project/${m}\``).join(", ")}`);
      if (a.usedBy.keyframes.length > 0)
        lines.push(`- Visible at: ${a.usedBy.keyframes.join(", ")}`);
      const keep =
        type === "model"
          ? "keep the node names and pivots, fit the bounding boxes, keep the material slot names (or update the code that looks them up)"
          : type === "texture"
            ? "keep the aspect ratio and colour space; power-of-two sizes if the code sets mipmaps or repeat wrapping"
            : type === "environment"
              ? "keep the format (equirectangular, same extension) so the loader still reads it"
              : "keep the duration if the timeline is synced to it";
      lines.push(`- To replace: ${keep}.`, "");
    }
  }
  const decoders = file.assets.filter((a) => a.type === "decoder");
  if (decoders.length > 0)
    lines.push("## Decoders", "", ...decoders.map((d) => `- \`${d.url}\`: ${d.output.note}`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}
