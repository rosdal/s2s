import { readFile } from "node:fs/promises";
import path from "node:path";
import { assetKind } from "../capture/recorder.js";
import { type RequestRecord, readRequestLog } from "../capture/request-log.js";
import type { WorkspacePaths } from "../capture/workspace.js";
import { writeJsonAtomic } from "../fs-util.js";
import {
  type FrameworkFile,
  RECOVERER_API_VERSION,
  type Recoverer,
  type RecovererContext,
} from "./api.js";
import { genericRecoverer } from "./generic/index.js";
import { threeRecoverer } from "./three/index.js";

/** Most specific first; `generic` always last. */
export function builtinRecoverers(): Recoverer[] {
  return [threeRecoverer, genericRecoverer];
}

export function recovererByName(name: string): Recoverer {
  return builtinRecoverers().find((r) => r.name === name) ?? genericRecoverer;
}

export const CHOOSE_THRESHOLD = 0.5;

const word = (n: number): FrameworkFile["confidence"] =>
  n >= 0.8 ? "high" : n >= 0.5 ? "medium" : "low";

export function frameworkPath(paths: WorkspacePaths): string {
  return path.join(paths.analysis, "framework.json");
}

export const GENERIC_FRAMEWORK: FrameworkFile = {
  recoverer: "generic",
  flavour: null,
  version: null,
  confidence: "low",
  evidence: ["fallback"],
  unsupported: [],
  details: {},
};

/** `analysis/framework.json`, or the generic recoverer for workspaces written before it existed. */
export async function readFramework(paths: WorkspacePaths): Promise<FrameworkFile> {
  try {
    const file = JSON.parse(await readFile(frameworkPath(paths), "utf8")) as FrameworkFile;
    return { ...GENERIC_FRAMEWORK, ...file };
  } catch {
    return GENERIC_FRAMEWORK;
  }
}

export async function writeFramework(paths: WorkspacePaths, file: FrameworkFile): Promise<void> {
  await writeJsonAtomic(frameworkPath(paths), file);
}

/** Context for `detect` hooks, read from the workspace once. */
export async function recovererContext(
  paths: WorkspacePaths,
  packages: RecovererContext["packages"],
): Promise<RecovererContext> {
  const requests = await readRequestLog(paths.requests).catch(() => [] as RequestRecord[]);
  const runtime = await readFile(paths.runtime, "utf8")
    .then((t) => JSON.parse(t) as Record<string, unknown>[])
    .catch(() => []);
  let scripts: Promise<{ url: string; hash: string; text: string }[]> | undefined;
  return {
    paths,
    packages,
    requests,
    runtime: Array.isArray(runtime) ? runtime : [],
    scripts() {
      scripts ??= (async () => {
        const seen = new Set<string>();
        const out: { url: string; hash: string; text: string }[] = [];
        for (const r of requests) {
          if (!r.bodyHash || seen.has(r.bodyHash) || r.status < 200 || r.status >= 300) continue;
          if (r.origin !== "first-party" && r.origin !== "cdn-library") continue;
          if (assetKind(r.mimeType, r.url) !== "js") continue;
          seen.add(r.bodyHash);
          const text = await readFile(path.join(paths.bodies, r.bodyHash), "utf8").catch(() => "");
          out.push({ url: r.url, hash: r.bodyHash, text });
        }
        return out;
      })();
      return scripts;
    },
  };
}

/** Ask every recoverer and keep the most confident one at or above the threshold. */
export async function chooseRecoverer(
  ctx: RecovererContext,
  recoverers: Recoverer[] = builtinRecoverers(),
): Promise<{ recoverer: Recoverer; file: FrameworkFile }> {
  let best: { recoverer: Recoverer; file: FrameworkFile; score: number } | undefined;
  for (const recoverer of recoverers) {
    if (recoverer.apiVersion !== RECOVERER_API_VERSION || recoverer.name === "generic") continue;
    const result = await recoverer.detect(ctx);
    if (!result || result.confidence < CHOOSE_THRESHOLD) continue;
    if (best && best.score >= result.confidence) continue;
    best = {
      recoverer,
      score: result.confidence,
      file: {
        recoverer: recoverer.name,
        flavour: result.flavour ?? null,
        version: result.version ?? null,
        confidence: word(result.confidence),
        evidence: result.evidence,
        unsupported: result.unsupported ?? [],
        details: result.details ?? {},
      },
    };
  }
  if (best) return { recoverer: best.recoverer, file: best.file };
  // Even without a recoverer, report what other recoverers saw but cannot handle.
  const unsupported = new Set<string>();
  for (const recoverer of recoverers) {
    if (recoverer.name === "generic") continue;
    for (const u of (await recoverer.detect(ctx))?.unsupported ?? []) unsupported.add(u);
  }
  return {
    recoverer: genericRecoverer,
    file: { ...GENERIC_FRAMEWORK, unsupported: [...unsupported].sort() },
  };
}
