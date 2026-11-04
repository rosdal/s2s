import { createRequire } from "node:module";
import type { DatabaseSync as Database, StatementSync } from "node:sqlite";
import { compareVersions } from "../detect/registry.js";
import { toSigned, toUnsigned } from "./hash.js";
import { NORMALIZER_VERSION } from "./normalize.js";

/** Bumped when the tables or the posting encoding change. */
export const SCHEMA_VERSION = 2;
/** A function hash shared by more packages than this is a common helper, not evidence. */
export const MAX_SHARING = 20;
/** A distinctive string is one found in exactly one package. */
export const MAX_STRING_SHARING = 1;

export type HashKind = "function" | "string";
const KIND_CODE: Record<HashKind, number> = { function: 0, string: 1 };
const TABLE: Record<HashKind, "hashes" | "strings"> = { function: "hashes", string: "strings" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  functions INTEGER NOT NULL DEFAULT 0,
  strings INTEGER NOT NULL DEFAULT 0,
  -- JSON array: every runtime and peer dependency any indexed version declared.
  dependencies TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS versions (
  package_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (package_id, idx),
  UNIQUE (package_id, version)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hashes (hash INTEGER PRIMARY KEY, postings BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS strings (hash INTEGER PRIMARY KEY, postings BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS dropped (hash INTEGER NOT NULL, kind INTEGER NOT NULL, PRIMARY KEY (hash, kind)) WITHOUT ROWID;
`;

let sqlite: typeof import("node:sqlite") | undefined;

/**
 * `node:sqlite`, loaded on first use. Node 22 flags it experimental and prints a warning on load;
 * that one warning is swallowed so it never lands in the CLI's output.
 */
function loadSqlite(): typeof import("node:sqlite") {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

// --- Posting lists ---------------------------------------------------------------------------
//
// A posting list says which packages, and which of their versions, contain a hash:
//   varint count, then per entry: varint package id, varint bitset length, bitset bytes.
// Bit i of a bitset is the package's version with `idx` i. Most functions are unchanged across
// versions, so one row per hash with a few bytes per package keeps the index small.

export interface Posting {
  packageId: number;
  versions: Uint8Array;
}

function writeVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function encodePostings(postings: Posting[]): Uint8Array {
  const out: number[] = [];
  writeVarint(out, postings.length);
  for (const p of [...postings].sort((a, b) => a.packageId - b.packageId)) {
    const bits = trimBits(p.versions);
    writeVarint(out, p.packageId);
    writeVarint(out, bits.length);
    for (const byte of bits) out.push(byte);
  }
  return Uint8Array.from(out);
}

export function decodePostings(blob: Uint8Array): Posting[] {
  let at = 0;
  const read = (): number => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = blob[at++] ?? 0;
      value += (byte & 0x7f) * shift;
      if (byte < 0x80) return value;
      shift *= 128;
    }
  };
  const count = read();
  const out: Posting[] = [];
  for (let i = 0; i < count; i++) {
    const packageId = read();
    const length = read();
    out.push({ packageId, versions: blob.slice(at, at + length) });
    at += length;
  }
  return out;
}

function trimBits(bits: Uint8Array): Uint8Array {
  let end = bits.length;
  while (end > 0 && bits[end - 1] === 0) end--;
  return end === bits.length ? bits : bits.subarray(0, end);
}

export function setBit(bits: Uint8Array, index: number): Uint8Array {
  const byte = index >> 3;
  const out = bits.length > byte ? bits : growBits(bits, byte + 1);
  out[byte] = (out[byte] ?? 0) | (1 << (index & 7));
  return out;
}

function growBits(bits: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(bits);
  return out;
}

export function orBits(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(a.length, b.length));
  out.set(a);
  for (let i = 0; i < b.length; i++) out[i] = (out[i] ?? 0) | (b[i] ?? 0);
  return out;
}

export function bitIndices(bits: Uint8Array): number[] {
  const out: number[] = [];
  for (let byte = 0; byte < bits.length; byte++) {
    const value = bits[byte] ?? 0;
    if (value === 0) continue;
    for (let bit = 0; bit < 8; bit++) if (value & (1 << bit)) out.push(byte * 8 + bit);
  }
  return out;
}

// --- Index ---------------------------------------------------------------------------------

export interface IndexMeta {
  schemaVersion: number;
  normalizerVersion: number;
  corpusDate: string | null;
  builderVersion: string | null;
  createdAt: string | null;
}

export interface IndexPackage {
  id: number;
  name: string;
  /** Versions by `idx`. */
  versions: string[];
  functions: number;
  strings: number;
  /** Dependencies of any indexed version: code shared with one of them belongs to it. */
  dependencies: string[];
}

export class IndexError extends Error {
  override name = "IndexError";
}

const BATCH = 400;

/** A fingerprint index file, opened for reading. */
export class FingerprintIndex {
  readonly path: string;
  readonly meta: IndexMeta;
  readonly packages: Map<number, IndexPackage>;
  readonly #db: Database;
  readonly #lookups = new Map<string, StatementSync>();

  private constructor(file: string, db: Database) {
    this.path = file;
    this.#db = db;
    this.meta = readMeta(db);
    this.packages = readPackages(db);
  }

  /** Open an index read-only; throws `IndexError` when it is missing, corrupt or incompatible. */
  static open(file: string): FingerprintIndex {
    const { DatabaseSync } = loadSqlite();
    let db: Database;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch (error) {
      throw new IndexError(`Cannot open ${file}: ${(error as Error).message}`);
    }
    let index: FingerprintIndex;
    try {
      index = new FingerprintIndex(file, db);
    } catch (error) {
      db.close();
      throw new IndexError(`${file} is not a fingerprint index: ${(error as Error).message}`);
    }
    if (index.meta.schemaVersion !== SCHEMA_VERSION) {
      db.close();
      throw new IndexError(
        `${file} has schema ${index.meta.schemaVersion}; this s2s reads schema ${SCHEMA_VERSION}.`,
      );
    }
    if (index.meta.normalizerVersion !== NORMALIZER_VERSION) {
      db.close();
      throw new IndexError(
        `${file} was built with normalizer ${index.meta.normalizerVersion}; this s2s uses ${NORMALIZER_VERSION}.`,
      );
    }
    return index;
  }

  /** Posting lists for the given hashes; hashes not in the index are absent from the result. */
  lookup(kind: HashKind, hashes: bigint[]): Map<bigint, Posting[]> {
    const out = new Map<bigint, Posting[]>();
    const unique = [...new Set(hashes)];
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      const stmt = this.#lookup(kind, batch.length);
      for (const row of stmt.all(...batch.map(toSigned)) as {
        hash: bigint;
        postings: Uint8Array;
      }[])
        out.set(toUnsigned(row.hash), decodePostings(row.postings));
    }
    return out;
  }

  #lookup(kind: HashKind, size: number): StatementSync {
    const key = `${kind}:${size}`;
    let stmt = this.#lookups.get(key);
    if (!stmt) {
      stmt = this.#db.prepare(
        `SELECT hash, postings FROM ${TABLE[kind]} WHERE hash IN (${Array(size).fill("?").join(",")})`,
      );
      stmt.setReadBigInts(true);
      this.#lookups.set(key, stmt);
    }
    return stmt;
  }

  counts(): { packages: number; versions: number; hashes: number; strings: number } {
    const one = (sql: string) => Number((this.#db.prepare(sql).get() as { n: number }).n);
    return {
      packages: this.packages.size,
      versions: [...this.packages.values()].reduce((n, p) => n + p.versions.length, 0),
      hashes: one("SELECT count(*) AS n FROM hashes"),
      strings: one("SELECT count(*) AS n FROM strings"),
    };
  }

  close(): void {
    this.#db.close();
  }
}

function readMeta(db: Database): IndexMeta {
  const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    schemaVersion: Number(map.get("schema_version") ?? 0),
    normalizerVersion: Number(map.get("normalizer_version") ?? 0),
    corpusDate: map.get("corpus_date") ?? null,
    builderVersion: map.get("builder_version") ?? null,
    createdAt: map.get("created_at") ?? null,
  };
}

function readPackages(db: Database): Map<number, IndexPackage> {
  const out = new Map<number, IndexPackage>();
  for (const row of db
    .prepare("SELECT id, name, functions, strings, dependencies FROM packages")
    .all() as {
    id: number;
    name: string;
    functions: number;
    strings: number;
    dependencies: string;
  }[])
    out.set(row.id, { ...row, dependencies: JSON.parse(row.dependencies), versions: [] });
  for (const row of db.prepare("SELECT package_id, idx, version FROM versions").all() as {
    package_id: number;
    idx: number;
    version: string;
  }[]) {
    const pkg = out.get(row.package_id);
    if (pkg) pkg.versions[row.idx] = row.version;
  }
  return out;
}

/** What one package@version contributes: its function hashes and string hashes. */
export interface VersionPrints {
  name: string;
  version: string;
  functions: Iterable<bigint>;
  strings: Iterable<bigint>;
  /** Runtime and peer dependencies this version declares. */
  dependencies?: string[];
}

/**
 * Writes an index. Versions are added one package at a time; a version already in the index is
 * skipped, so the same writer serves the first build and every incremental one.
 */
export class IndexWriter {
  readonly #db: Database;
  readonly #get: Record<HashKind, StatementSync>;
  readonly #put: Record<HashKind, StatementSync>;
  readonly #delete: Record<HashKind, StatementSync>;
  readonly #isDropped: StatementSync;
  readonly #drop: StatementSync;

  constructor(file: string) {
    const { DatabaseSync } = loadSqlite();
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
    this.#db.exec(SCHEMA);
    const existing = readMeta(this.#db);
    if (existing.schemaVersion && existing.schemaVersion !== SCHEMA_VERSION)
      throw new IndexError(`${file} has schema ${existing.schemaVersion}; cannot add to it.`);
    if (existing.normalizerVersion && existing.normalizerVersion !== NORMALIZER_VERSION)
      throw new IndexError(
        `${file} was built with normalizer ${existing.normalizerVersion}; rebuild it from scratch.`,
      );
    this.setMeta({
      schema_version: String(SCHEMA_VERSION),
      normalizer_version: String(NORMALIZER_VERSION),
    });
    const each = (sql: (table: string) => string) => ({
      function: this.#db.prepare(sql("hashes")),
      string: this.#db.prepare(sql("strings")),
    });
    this.#get = each((t) => `SELECT postings FROM ${t} WHERE hash = ?`);
    this.#put = each((t) => `INSERT OR REPLACE INTO ${t} (hash, postings) VALUES (?, ?)`);
    this.#delete = each((t) => `DELETE FROM ${t} WHERE hash = ?`);
    this.#isDropped = this.#db.prepare("SELECT 1 AS x FROM dropped WHERE hash = ? AND kind = ?");
    this.#drop = this.#db.prepare("INSERT OR IGNORE INTO dropped (hash, kind) VALUES (?, ?)");
  }

  setMeta(values: Record<string, string>): void {
    const stmt = this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(values)) stmt.run(k, v);
  }

  /** `name@version` pairs already in the index. */
  has(name: string, version: string): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 AS x FROM versions v JOIN packages p ON p.id = v.package_id WHERE p.name = ? AND v.version = ?",
        )
        .get(name, version) !== undefined
    );
  }

  /** Add every new version of one package in one transaction. */
  addPackage(name: string, versions: VersionPrints[]): number {
    const seen = new Set<string>();
    // New versions only, each once even when the caller listed it twice.
    const fresh = versions.filter((v) => {
      if (v.name !== name || seen.has(v.version) || this.has(name, v.version)) return false;
      seen.add(v.version);
      return true;
    });
    if (fresh.length === 0) return 0;
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("INSERT OR IGNORE INTO packages (name) VALUES (?)").run(name);
      const known = this.#db
        .prepare("SELECT dependencies FROM packages WHERE name = ?")
        .get(name) as {
        dependencies: string;
      };
      const deps = new Set<string>(JSON.parse(known.dependencies));
      for (const v of fresh) for (const d of v.dependencies ?? []) if (d !== name) deps.add(d);
      this.#db
        .prepare("UPDATE packages SET dependencies = ? WHERE name = ?")
        .run(JSON.stringify([...deps].sort()), name);
      const { id } = this.#db.prepare("SELECT id FROM packages WHERE name = ?").get(name) as {
        id: number;
      };
      const { next } = this.#db
        .prepare("SELECT coalesce(max(idx) + 1, 0) AS next FROM versions WHERE package_id = ?")
        .get(id) as { next: number };
      const insertVersion = this.#db.prepare(
        "INSERT INTO versions (package_id, idx, version) VALUES (?, ?, ?)",
      );
      const bits: Record<HashKind, Map<bigint, Uint8Array>> = {
        function: new Map(),
        string: new Map(),
      };
      fresh.forEach((v, i) => {
        const idx = next + i;
        insertVersion.run(id, idx, v.version);
        for (const [kind, list] of [
          ["function", v.functions],
          ["string", v.strings],
        ] as const) {
          const map = bits[kind];
          for (const hash of list) map.set(hash, setBit(map.get(hash) ?? new Uint8Array(0), idx));
        }
      });
      const added: Record<HashKind, number> = { function: 0, string: 0 };
      for (const kind of ["function", "string"] as const) {
        const limit = kind === "function" ? MAX_SHARING : MAX_STRING_SHARING;
        for (const [hash, set] of bits[kind])
          if (this.#merge(kind, toSigned(hash), id, set, limit)) added[kind]++;
      }
      this.#db
        .prepare(
          "UPDATE packages SET functions = functions + ?, strings = strings + ? WHERE id = ?",
        )
        .run(added.function, added.string, id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return fresh.length;
  }

  /** Returns true when the hash is new for this package. */
  #merge(kind: HashKind, hash: bigint, packageId: number, set: Uint8Array, limit: number): boolean {
    if (this.#isDropped.get(hash, KIND_CODE[kind])) return false;
    const row = this.#get[kind].get(hash) as { postings: Uint8Array } | undefined;
    const postings = row ? decodePostings(row.postings) : [];
    const mine = postings.find((p) => p.packageId === packageId);
    if (mine) mine.versions = orBits(mine.versions, set);
    else postings.push({ packageId, versions: set });
    if (postings.length > limit) {
      this.#delete[kind].run(hash);
      this.#drop.run(hash, KIND_CODE[kind]);
      // The packages that already counted this hash no longer hold it.
      const column = kind === "function" ? "functions" : "strings";
      const uncount = this.#db.prepare(
        `UPDATE packages SET ${column} = ${column} - 1 WHERE id = ?`,
      );
      for (const p of postings) if (p.packageId !== packageId || mine) uncount.run(p.packageId);
      return false;
    }
    this.#put[kind].run(hash, encodePostings(postings));
    return !mine;
  }

  /** Shrink the file for distribution. */
  close(options: { vacuum?: boolean } = {}): void {
    this.setMeta({ created_at: new Date().toISOString() });
    if (options.vacuum) this.#db.exec("PRAGMA journal_mode = DELETE; VACUUM;");
    else this.#db.exec("PRAGMA journal_mode = DELETE;");
    this.#db.close();
  }
}

/** Versions of a package sorted oldest first, keeping their `idx`. */
export function sortedVersions(pkg: IndexPackage): { idx: number; version: string }[] {
  return pkg.versions
    .map((version, idx) => ({ idx, version }))
    .filter((v) => v.version !== undefined)
    .sort((a, b) => compareVersions(a.version, b.version));
}

export interface PackageSize {
  name: string;
  versions: number;
  functions: number;
  strings: number;
  postingBytes: number;
}

/** Per-package share of an index, largest first, to find packages that bloat it. Read-only. */
export function sizeReport(file: string): PackageSize[] {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const packages = readPackages(db);
    const bytes = new Map<number, number>();
    for (const table of ["hashes", "strings"]) {
      for (const row of db.prepare(`SELECT postings FROM ${table}`).iterate() as Iterable<{
        postings: Uint8Array;
      }>) {
        const postings = decodePostings(row.postings);
        // A row's key is shared by its packages; each is charged its own entry plus a share of it.
        for (const p of postings)
          bytes.set(
            p.packageId,
            (bytes.get(p.packageId) ?? 0) + p.versions.length + 2 + 8 / postings.length,
          );
      }
    }
    return [...packages.values()]
      .map((p) => ({
        name: p.name,
        versions: p.versions.length,
        functions: p.functions,
        strings: p.strings,
        postingBytes: Math.round(bytes.get(p.id) ?? 0),
      }))
      .sort((a, b) => b.postingBytes - a.postingBytes);
  } finally {
    db.close();
  }
}
