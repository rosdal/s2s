import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Write a file so readers only ever see the old or the new content: write a sibling temp file,
 * then rename over the target. Windows can briefly lock the target (antivirus, indexer), so the
 * rename is retried a few times.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !code || !RETRYABLE.has(code)) {
        await rm(tmp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
