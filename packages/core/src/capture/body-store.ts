import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../fs-util.js";

export interface StoredBody {
  hash: string;
  size: number;
  /** False when a body with this hash was already stored. */
  written: boolean;
}

/** Content-addressed store: each body lives once at `<dir>/<sha256>`. */
export class BodyStore {
  readonly #dir: string;
  readonly #known = new Set<string>();
  #ready: Promise<unknown> | undefined;
  bytesWritten = 0;

  constructor(dir: string) {
    this.#dir = dir;
  }

  static hash(body: Uint8Array): string {
    return createHash("sha256").update(body).digest("hex");
  }

  path(hash: string): string {
    return path.join(this.#dir, hash);
  }

  async has(hash: string): Promise<boolean> {
    if (this.#known.has(hash)) return true;
    try {
      await access(this.path(hash));
      this.#known.add(hash);
      return true;
    } catch {
      return false;
    }
  }

  async put(body: Uint8Array): Promise<StoredBody> {
    const hash = BodyStore.hash(body);
    if (await this.has(hash)) return { hash, size: body.byteLength, written: false };
    this.#ready ??= mkdir(this.#dir, { recursive: true });
    await this.#ready;
    // Mark before the write so concurrent puts of the same body don't both write.
    this.#known.add(hash);
    try {
      await writeFileAtomic(this.path(hash), body);
    } catch (error) {
      this.#known.delete(hash);
      throw error;
    }
    this.bytesWritten += body.byteLength;
    return { hash, size: body.byteLength, written: true };
  }

  read(hash: string): Promise<Buffer> {
    return readFile(this.path(hash));
  }
}
