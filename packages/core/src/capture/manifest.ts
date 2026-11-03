import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../fs-util.js";

export const MANIFEST_SCHEMA_VERSION = 1;

export const StageStatus = z.enum(["pending", "partial", "complete", "failed"]);
export type StageStatus = z.infer<typeof StageStatus>;

export const StageState = z.object({
  status: StageStatus,
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  stats: z.record(z.string(), z.number()).default({}),
  error: z.string().optional(),
  /** Things that went wrong without stopping the stage, for the user to read. */
  warnings: z.array(z.string()).default([]),
  /** Named results that are not counts, such as the lockfile an install wrote. */
  details: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
export type StageState = z.infer<typeof StageState>;

const pendingStage = (): StageState => ({ status: "pending", stats: {}, warnings: [] });

export const Manifest = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  s2sVersion: z.string(),
  targetUrl: z.url(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** The options the last run used, as plain JSON. */
  options: z.record(z.string(), z.unknown()),
  stages: z.object({
    capture: StageState,
    /** Stage 2. Workspaces written before it existed read as `pending`. */
    maps: StageState.default(pendingStage),
    /** Stage 3. Workspaces written before it existed read as `pending`. */
    detect: StageState.default(pendingStage),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

export function newManifest(input: {
  s2sVersion: string;
  targetUrl: string;
  options: Record<string, unknown>;
}): Manifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    s2sVersion: input.s2sVersion,
    targetUrl: input.targetUrl,
    createdAt: now,
    updatedAt: now,
    options: input.options,
    stages: { capture: pendingStage(), maps: pendingStage(), detect: pendingStage() },
  };
}

/** Read and validate a manifest. Returns `undefined` when the file does not exist. */
export async function readManifest(file: string): Promise<Manifest | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return Manifest.parse(JSON.parse(text));
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  const next = Manifest.parse({ ...manifest, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(file, next);
}
