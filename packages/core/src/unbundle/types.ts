import type { ChunkBundler } from "./bundler.js";

/** One first-party JS file, with the text Stage 4 works from. */
export interface ChunkInput {
  url: string;
  bodyHash: string;
  /** Folder name under `recovered/unbundled/`, from the file name minus its hash. */
  name: string;
  /** The renamed chunk from Stage 2 when there is one, else the captured body. */
  code: string;
  origin: "renamed" | "unbundled";
  pages: string[];
  bundler: ChunkBundler;
  /** Vendor ranges from Stage 3, as string indices into `code`. */
  vendor: VendorSpan[];
  /** First-party file ranges from a partial source map, as string indices into `code`. */
  boundaries: SourceSpan[];
  /** Converts a string index in `code` to a byte offset in the captured body. */
  bodyOffset(index: number): number;
}

export interface VendorSpan {
  package: string;
  version: string | null;
  start: number;
  end: number;
  method: string;
  /** Kind of bundler module Stage 3 found the range in, if any. */
  moduleKind: string | null;
}

export interface SourceSpan {
  source: string;
  start: number;
  end: number;
}

/** Where an import line points before files are placed. */
export type ImportTarget =
  | { kind: "module"; key: string }
  | { kind: "chunk-export"; url: string; name: string }
  | { kind: "package"; name: string }
  /** A file Stage 4 writes, by workspace-relative path (`assets/logo.png`). */
  | { kind: "file"; path: string };

export interface ImportLine {
  target: ImportTarget;
  /** `import { imported as local }`; empty with no namespace for a side-effect import. */
  names: { imported: string; local: string }[];
  namespace?: string;
  defaultName?: string;
  /** An `// s2s:` note for the agent, written above the import. */
  note?: string;
  /** The vendor package's version, when Stage 3 found one. */
  version?: string | null;
}

export type Boundary = "real" | "heuristic";

/** One module as the unpacker found it, before vendor checks, transforms and placement. */
export interface Draft {
  /** Unique across the site; other modules point at it as `s2s-module:<key>`. */
  key: string;
  /** File name stem under the chunk folder. */
  id: string;
  chunk: ChunkInput;
  /** String indices of the module's code in `chunk.code`. */
  start: number;
  end: number;
  /** The code's pieces when they are not one run (a merged part); `start`/`end` span them all. */
  spans?: [number, number][];
  boundary: Boundary;
  /** Module body; references to other modules use `s2s-module:` and `s2s-chunk:` specifiers. */
  code: string;
  head: ImportLine[];
  entry: boolean;
  /** Original file, when a source map or a path comment names it. */
  source: string | null;
  notes: string[];
  /** Set when the whole module is vendor code and is dropped. */
  vendor: { package: string; version: string | null } | null;
  /** Bytes of vendor code removed from inside the module. */
  vendorBytesRemoved: number;
}

export const CHUNK_PREFIX = "s2s-chunk:";
export const chunkSpecifier = (url: string): string => `${CHUNK_PREFIX}${url}`;

export interface UnpackContext {
  keepVendor: boolean;
  heuristicSplit: boolean;
  /** Smallest heuristic part, in bytes of code. */
  minPartBytes: number;
  warn(message: string): void;
}
