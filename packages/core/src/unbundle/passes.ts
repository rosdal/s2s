import type { LibraryAdapter } from "./adapter.js";
import { parses } from "./ast.js";

export const PASSES = ["deobfuscate", "unminify", "detranspile", "jsx", "esm", "prettier"] as const;
export type PassName = (typeof PASSES)[number];

export interface PassResult {
  pass: PassName;
  /**
   * `skipped` by `--skip`; `not-needed` when the pass does not apply (no obfuscation found);
   * `too-large` when the module is over the size the AST rewrites handle in reasonable time.
   */
  status: "applied" | "skipped" | "not-needed" | "too-large" | "error";
  /** Lines in the output that were not in the input. */
  changes: number;
  error?: string;
}

/** Identifier shapes javascript-obfuscator and friends leave behind. */
export function looksObfuscated(code: string): boolean {
  const hex = code.match(/\b_0x[0-9a-f]{4,}\b/g)?.length ?? 0;
  if (hex >= 10) return true;
  // A long array of strings read through a decoder function with numeric offsets.
  return /\[\s*(?:'[^']*'\s*,\s*|"[^"]*"\s*,\s*){30,}/.test(code) && /\(0x[0-9a-f]+\)/.test(code);
}

/** Added lines, counted as a multiset difference: cheap, stable, and good enough for a report. */
export function changedLines(before: string, after: string): number {
  if (before === after) return 0;
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) {
    const key = line.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let added = 0;
  for (const line of after.split("\n")) {
    const key = line.trim();
    const n = counts.get(key) ?? 0;
    if (n > 0) counts.set(key, n - 1);
    else added++;
  }
  return added;
}

/**
 * The wakaru passes take minutes on a few hundred KB of code. Modules this big are almost always
 * library code that slipped past vendor detection (or `--keep-vendor`); they still get Prettier.
 */
export const MAX_TRANSFORM_BYTES = 150_000;
const HEAVY = new Set<PassName>(["unminify", "detranspile", "jsx", "esm"]);

export interface TransformOutput {
  code: string;
  obfuscated: boolean;
  passes: PassResult[];
}

/**
 * Run the transform passes over one module, in order. A pass that throws, or returns code that
 * no longer parses, leaves the module as the previous pass wrote it; the error is reported and
 * the next pass carries on.
 */
export async function transform(
  code: string,
  adapter: LibraryAdapter,
  skip: ReadonlySet<PassName>,
): Promise<TransformOutput> {
  let current = code;
  const obfuscated = looksObfuscated(code);
  const passes: PassResult[] = [];
  for (const pass of PASSES) {
    if (skip.has(pass)) {
      passes.push({ pass, status: "skipped", changes: 0 });
      continue;
    }
    if (pass === "deobfuscate" && !obfuscated) {
      passes.push({ pass, status: "not-needed", changes: 0 });
      continue;
    }
    if (HEAVY.has(pass) && current.length > MAX_TRANSFORM_BYTES) {
      passes.push({ pass, status: "too-large", changes: 0 });
      continue;
    }
    try {
      const next = await run(adapter, pass, current);
      if (!parses(next)) throw new Error("output does not parse");
      passes.push({ pass, status: "applied", changes: changedLines(current, next) });
      current = next;
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      passes.push({ pass, status: "error", changes: 0, error: message ?? "error" });
    }
  }
  return { code: current, obfuscated, passes };
}

function run(adapter: LibraryAdapter, pass: PassName, code: string): Promise<string> {
  switch (pass) {
    case "deobfuscate":
      return adapter.deobfuscate(code);
    case "unminify":
      return adapter.unminify(code);
    case "detranspile":
      return adapter.detranspile(code);
    case "jsx":
      return adapter.jsx(code);
    case "esm":
      return adapter.esm(code);
    case "prettier":
      return adapter.format(code, "babel");
  }
}
