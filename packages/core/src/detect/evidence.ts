import { z } from "zod";

/**
 * How much one piece of evidence says about a package, strongest first:
 * - `exact`: names the package and its version from structure (a pnpm path, a CDN URL, a runtime
 *   `version` property)
 * - `strong`: names a version, but from text that could be wrong or planted (a banner, a version
 *   string next to its anchors)
 * - `weak`: names the package from text without a version
 * - `name-only`: says the package is present, nothing more (a framework marker)
 */
export const Strength = z.enum(["exact", "strong", "weak", "name-only"]);
export type Strength = z.infer<typeof Strength>;

export const STRENGTH_RANK: Record<Strength, number> = {
  exact: 3,
  strong: 2,
  weak: 1,
  "name-only": 0,
};

export const Signal = z.enum([
  "cdn-url",
  "sourcemap-path",
  "banner",
  "license-file",
  "version-string",
  "runtime",
  "framework-marker",
  "project-hint",
]);
export type Signal = z.infer<typeof Signal>;

export const EvidenceLocation = z.object({
  /** URL of the captured file (or page), or a source path for source-map evidence. */
  file: z.string(),
  bodyHash: z.string().nullable(),
  /** UTF-8 byte offset of the match inside the file, when the signal has a position. */
  offset: z.number().int().nullable(),
  length: z.number().int().nullable(),
});
export type EvidenceLocation = z.infer<typeof EvidenceLocation>;

export const Evidence = z.object({
  /** Unique inside one run: `<collector>:<n>`. */
  id: z.string(),
  package: z.string(),
  /** An exact version, an x-range like `0.187.x`, or `null` when the signal carries none. */
  version: z.string().nullable(),
  signal: Signal,
  strength: Strength,
  /**
   * True when the package name comes from structure s2s controls the reading of (a source-map
   * path, a CDN URL, a signature or probe key). False when the site's own text named it (a
   * banner), which a hostile site can plant.
   */
  trusted: z.boolean(),
  location: EvidenceLocation,
  /** Bytes of shipped code this evidence accounts for; 0 when it covers no file. */
  bytes: z.number().int(),
  /** Page slugs the evidence was seen on. */
  pages: z.array(z.string()),
  /** A short excerpt of the matched text, for `--explain`. */
  excerpt: z.string().nullable(),
  /** The signal names a build-time tool (tailwindcss), not a runtime dependency. */
  dev: z.boolean().default(false),
  /** Packages this one was nested under (`node_modules/a/node_modules/b`), from source maps. */
  parents: z.array(z.string()).default([]),
});
export type Evidence = z.infer<typeof Evidence>;
export type EvidenceInput = Omit<Evidence, "id" | "dev" | "parents"> & {
  dev?: boolean;
  parents?: string[];
};

export const EvidenceFile = z.object({
  collector: z.string(),
  evidence: z.array(Evidence),
});
export type EvidenceFile = z.infer<typeof EvidenceFile>;

/** Assign ids and defaults to one collector's raw evidence. */
export function finalizeEvidence(collector: string, items: EvidenceInput[]): EvidenceFile {
  return {
    collector,
    evidence: items.map((item, i) => ({
      ...item,
      dev: item.dev ?? false,
      parents: item.parents ?? [],
      id: `${collector}:${i}`,
    })),
  };
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** True when `name` is a valid npm package name (lowercase, at most 214 characters). */
export function isNpmName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name);
}

const EXCERPT_MAX = 160;

/** Collapse whitespace and cap the length, so an excerpt fits on one terminal line. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
}

/**
 * Maps string indices to UTF-8 byte offsets. Bodies are read as strings, but ranges are stored
 * in bytes so they stay correct for any reader of the raw file.
 */
export class ByteIndex {
  readonly #text: string;
  readonly #ascii: boolean;
  #cacheIndex = 0;
  #cacheBytes = 0;

  constructor(text: string) {
    this.#text = text;
    this.#ascii = Buffer.byteLength(text) === text.length;
  }

  bytes(index: number): number {
    if (this.#ascii) return index;
    // Most lookups move forward through the file, so count on from the last one.
    if (index < this.#cacheIndex) {
      this.#cacheIndex = 0;
      this.#cacheBytes = 0;
    }
    this.#cacheBytes += Buffer.byteLength(this.#text.slice(this.#cacheIndex, index));
    this.#cacheIndex = index;
    return this.#cacheBytes;
  }
}
