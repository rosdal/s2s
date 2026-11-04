import { parentPort } from "node:worker_threads";
import { buildVersion, type CorpusVersion, saveResult } from "./build.js";

/** One build per message; the result is saved here and only its summary goes back. */
parentPort?.on("message", async (message: { entry: CorpusVersion; cacheDir: string }) => {
  try {
    const result = await buildVersion(message.entry, { cacheDir: message.cacheDir });
    await saveResult(message.cacheDir, result);
    parentPort?.postMessage({
      ok: true,
      result: { ...result, functions: [], strings: [], functionCount: result.functions.length },
    });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: (error as Error).message });
  }
});
