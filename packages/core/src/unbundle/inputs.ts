import path from "node:path";
import type { DetectContext } from "../detect/context.js";
import type { BundleRanges } from "../detect/ranges.js";
import { indexer, mapLoader } from "../detect/ranges.js";
import { breathe } from "../fs-util.js";
import { lineStartsOf, renameFromMap, type TextEdit } from "../maps/rename.js";
import { ByteOffsets } from "./ast.js";
import { detectChunkBundler } from "./bundler.js";
import type { ChunkInput, SourceSpan, VendorSpan } from "./types.js";

/** A first-party file Stage 2 recovered exactly; linked in `modules.json`, not reprocessed. */
export interface ExactSource {
  /** Path under the workspace, `recovered/sourcemap/…`. */
  file: string;
  chunkUrl: string;
  pages: string[];
}

interface SourcemapsReport {
  maps: {
    file: string;
    generatedHash: string | null;
    sources: { raw: string; kind: string | null; output: string | null; confidence: string }[];
  }[];
  renamed: { file: string; bodyHash: string; output: string | null }[];
}

interface BoundaryFile {
  file: string;
  bodyHash: string;
  ranges: {
    source: string;
    start: { line: number; column: number };
    end: { line: number; column: number };
  }[];
}

export interface Inputs {
  chunks: ChunkInput[];
  exact: ExactSource[];
  /** Chunks left out because their first-party code is all exact sources. */
  exactChunks: string[];
}

/**
 * The first-party JS chunks, each with the best input the earlier stages left: exact sources
 * (linked, not reprocessed), else the chunk Stage 2 renamed from a partial map, else the raw
 * body. Vendor ranges and map boundaries are translated into the chosen text's positions.
 */
export async function loadInputs(ctx: DetectContext): Promise<Inputs> {
  const report = (await ctx.readJson<SourcemapsReport>(ctx.paths.sourcemapsReport)) ?? {
    maps: [],
    renamed: [],
  };
  const vendor =
    (
      await ctx.readJson<{ bundles: BundleRanges[] }>(
        path.join(ctx.paths.analysis, "vendor-ranges.json"),
      )
    )?.bundles ?? [];
  const boundaries = (await ctx.readJson<BoundaryFile[]>(ctx.paths.sourcemapBoundaries)) ?? [];
  const mapFor = await mapLoader(ctx);
  const names = new Set<string>();
  const chunks: ChunkInput[] = [];
  const exact: ExactSource[] = [];
  const exactChunks: string[] = [];

  const js = ctx.assets.filter((a) => a.kind === "js" && a.origin === "first-party");
  for (const asset of js) {
    await breathe();
    const url = asset.urls[0] ?? "";
    const raw = await ctx.text(asset.hash);
    if (raw === undefined) continue;
    const maps = report.maps.filter((m) => m.generatedHash === asset.hash);
    const firstParty = maps.flatMap((m) => m.sources).filter((s) => s.kind === "first-party");
    if (firstParty.length > 0 && firstParty.every((s) => s.output)) {
      exactChunks.push(url);
      for (const source of firstParty) {
        const file = `recovered/sourcemap/${source.output}`;
        if (!exact.some((e) => e.file === file))
          exact.push({ file, chunkUrl: url, pages: asset.pages });
      }
      continue;
    }

    let code = raw;
    let origin: ChunkInput["origin"] = "unbundled";
    let edits: TextEdit[] = [];
    const renamed = report.renamed.find((r) => r.bodyHash === asset.hash && r.output);
    if (renamed) {
      const map = await mapFor(asset);
      if (map) {
        try {
          const result = renameFromMap(raw, map);
          code = result.code;
          edits = result.edits;
          origin = "renamed";
        } catch {
          // Stage 2 renamed it, so this should not happen; fall back to the raw body.
        }
      }
    }
    const toNew = shifter(edits, "forward");
    const toOld = shifter(edits, "back");
    const rawBytes = new ByteOffsets(raw);
    const fromBytes = indexer(raw);

    const spans: VendorSpan[] = [];
    for (const range of vendor.find((b) => b.bodyHash === asset.hash)?.ranges ?? []) {
      spans.push({
        package: range.package,
        version: range.version,
        start: toNew(fromBytes(range.start)),
        end: toNew(fromBytes(range.end)),
        method: range.method,
        moduleKind: range.module?.kind ?? null,
      });
    }
    const sourceSpans: SourceSpan[] = [];
    const lineStarts = lineStartsOf(raw);
    const at = (p: { line: number; column: number }) => (lineStarts[p.line - 1] ?? 0) + p.column;
    for (const range of boundaries.find((b) => b.bodyHash === asset.hash)?.ranges ?? []) {
      sourceSpans.push({
        source: range.source,
        start: toNew(at(range.start)),
        end: toNew(at(range.end)),
      });
    }
    sourceSpans.sort((a, b) => a.start - b.start);

    chunks.push({
      url,
      bodyHash: asset.hash,
      name: chunkName(url, names),
      code,
      origin,
      pages: asset.pages,
      bundler: detectChunkBundler(raw),
      vendor: healSpans(spans.sort((a, b) => a.start - b.start)),
      boundaries: sourceSpans,
      bodyOffset: (index) => rawBytes.of(toOld(index)),
    });
  }
  return { chunks, exact, exactChunks };
}

/** Translate string indices across a set of text edits, forwards (old → new) or back. */
function shifter(edits: TextEdit[], direction: "forward" | "back"): (index: number) => number {
  if (edits.length === 0) return (i) => i;
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  // Each edit as [oldStart, oldEnd, newStart, newEnd].
  const spans: [number, number, number, number][] = [];
  let delta = 0;
  for (const e of sorted) {
    spans.push([e.start, e.end, e.start + delta, e.start + delta + e.text.length]);
    delta += e.text.length - (e.end - e.start);
  }
  return (index) => {
    let shift = 0;
    for (const [os, oe, ns, ne] of spans) {
      const [from, to, target] = direction === "forward" ? [os, oe, ns] : [ns, ne, os];
      if (index < from) break;
      if (index < to) return target;
      shift = direction === "forward" ? ne - oe : oe - ne;
    }
    return index + shift;
  };
}

/** `menu-panel.22b5c690.chunk.js` → `menu-panel`, `index-z38Ersl5.js` → `index`; unique per site. */
export function chunkName(url: string, taken: Set<string>): string {
  let base: string;
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    base = url.split("/").pop() ?? "";
  }
  let name = base
    .replace(/\.(?:m?js|cjs)$/i, "")
    .replace(/\.chunk$/i, "")
    .replace(/[.-][0-9a-f]{8,}$/i, "")
    .replace(/-[A-Za-z0-9_-]{8}$/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!name || name.toLowerCase() === "styles" || name.toLowerCase() === "assets")
    name = name ? `${name}-js` : "chunk";
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name}-${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** A foreign match this small inside one package's code is a function the two share. */
const STRAY_SPAN_BYTES = 512;
/** The widest gap between two ranges of one package that a stray match may sit in. */
const STRAY_GAP_BYTES = 4096;

/**
 * A tiny match of another package between two close ranges of one package (91 bytes of "gsap"
 * between two stretches of three's TSL) is a helper both happen to share. It splits the package's
 * code, so the declarations around it stay behind as site code: drop it and close the gap.
 */
export function healSpans(spans: VendorSpan[]): VendorSpan[] {
  const out = [...spans];
  for (let i = 1; i + 1 < out.length; i++) {
    const [prev, mid, next] = [out[i - 1], out[i], out[i + 1]] as [
      VendorSpan,
      VendorSpan,
      VendorSpan,
    ];
    if (
      mid.package !== prev.package &&
      prev.package === next.package &&
      mid.end - mid.start <= STRAY_SPAN_BYTES &&
      next.start - prev.end <= STRAY_GAP_BYTES
    ) {
      out.splice(i, 1, { ...prev, start: prev.end, end: next.start });
    }
  }
  return out;
}
