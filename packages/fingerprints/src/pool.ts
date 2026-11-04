import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  buildVersion,
  type CorpusVersion,
  loadResult,
  saveResult,
  type VersionResult,
} from "./build.js";

export interface BuildSummary extends Omit<VersionResult, "functions" | "strings"> {
  functionCount: number;
  cached: boolean;
}

export interface PoolOptions {
  cacheDir: string;
  /** Worker threads; defaults to the CPU count minus one. 1 builds on the main thread. */
  concurrency?: number;
  onResult?: (summary: BuildSummary, done: number, total: number) => void;
  signal?: AbortSignal;
}

function summarize(result: VersionResult, cached: boolean): BuildSummary {
  const { functions, strings: _strings, ...rest } = result;
  return { ...rest, functionCount: functions.length, cached };
}

/** The compiled worker next to this module; absent when running from TypeScript sources. */
function workerFile(): string | undefined {
  const file = fileURLToPath(new URL("./worker.js", import.meta.url));
  return import.meta.url.endsWith(".js") && existsSync(file) ? file : undefined;
}

/**
 * Build every package@version that has no cached result. Resumable: each finished version is
 * saved as it completes, so an interrupted run picks up where it stopped.
 */
export async function runBuilds(
  entries: CorpusVersion[],
  options: PoolOptions,
): Promise<BuildSummary[]> {
  const out: BuildSummary[] = [];
  const todo: CorpusVersion[] = [];
  for (const entry of entries) {
    const cached = await loadResult(options.cacheDir, entry.name, entry.version);
    if (cached) {
      out.push(summarize(cached, true));
      options.onResult?.(out[out.length - 1] as BuildSummary, out.length, entries.length);
    } else todo.push(entry);
  }
  const concurrency = Math.max(1, options.concurrency ?? cpus().length - 1);
  const file = workerFile();
  const report = (summary: BuildSummary) => {
    out.push(summary);
    options.onResult?.(summary, out.length, entries.length);
  };

  if (concurrency === 1 || !file) {
    for (const entry of todo) {
      options.signal?.throwIfAborted();
      const result = await buildVersion(entry, { cacheDir: options.cacheDir });
      await saveResult(options.cacheDir, result);
      report(summarize(result, false));
    }
    return out;
  }

  let next = 0;
  type Reply = { ok: boolean; result?: BuildSummary; error?: string; dead?: boolean };
  /**
   * One worker thread taking versions until none are left. A worker that crashes (out of memory
   * on one huge package) costs that version only: it is logged as failed, so the next run retries
   * it, and a fresh worker carries on with the rest.
   */
  const lane = async () => {
    let worker = new Worker(file);
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const entry = todo[next++];
        if (!entry) return;
        const reply = await new Promise<Reply>((resolve) => {
          const done = (r: Reply) => {
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
            resolve(r);
          };
          const onMessage = (m: Reply) => done(m);
          const onError = (e: Error) => done({ ok: false, error: e.message, dead: true });
          const onExit = (code: number) =>
            done({ ok: false, error: `worker exited with code ${code}`, dead: true });
          worker.on("message", onMessage);
          worker.on("error", onError);
          worker.on("exit", onExit);
          worker.postMessage({ entry, cacheDir: options.cacheDir });
        });
        if (reply.ok && reply.result) report({ ...reply.result, cached: false });
        else
          report({
            name: entry.name,
            version: entry.version,
            builder: "",
            normalizer: 0,
            entries: [],
            ms: 0,
            error: reply.error ?? "worker failed",
            functionCount: 0,
            cached: false,
          });
        if (reply.dead) {
          await worker.terminate().catch(() => 0);
          worker = new Worker(file);
        }
      }
    } finally {
      await worker.terminate().catch(() => 0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, lane));
  return out;
}
