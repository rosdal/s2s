import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_THRESHOLDS, type Thresholds } from "../scaffold/facts.js";

const ConfigFile = z.object({
  verify: z
    .object({
      maxPixelDiff: z.number().min(0).max(1),
      minDomSimilarity: z.number().min(0).max(1),
      maxNewConsoleErrors: z.number().int().min(0),
      maxFailedRequests: z.number().int().min(0),
    })
    .partial()
    .optional(),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Strip TypeScript types with Node's own transform (Node 22.13+), or fall back to the text as is. */
async function toJavaScript(source: string): Promise<string> {
  const mod = (await import("node:module")) as {
    stripTypeScriptTypes?: (code: string, options?: { mode?: string }) => string;
  };
  if (typeof mod.stripTypeScriptTypes !== "function") return source;
  const emit = process.emitWarning;
  // The transform is marked experimental; that warning is noise in the CLI's output.
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return mod.stripTypeScriptTypes(source, { mode: "strip" });
  } finally {
    process.emitWarning = emit;
  }
}

/** Read the thresholds from `s2s.config.ts`; a missing file means the defaults. */
export async function loadThresholds(file: string): Promise<Thresholds> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_THRESHOLDS };
    throw error;
  }
  let value: unknown;
  try {
    const js = await toJavaScript(source);
    const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
    value = ((await import(url)) as { default?: unknown }).default;
  } catch (error) {
    throw new ConfigError(
      `${file} could not be loaded: ${(error as Error).message.split("\n")[0]}. It must be plain TypeScript with a default export and no imports.`,
    );
  }
  const parsed = ConfigFile.safeParse(value ?? {});
  if (!parsed.success)
    throw new ConfigError(`${file} is invalid: ${parsed.error.issues[0]?.message ?? "bad value"}`);
  return { ...DEFAULT_THRESHOLDS, ...stripUndefined(parsed.data.verify ?? {}) } as Thresholds;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
