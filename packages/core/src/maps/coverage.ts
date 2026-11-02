import type { LogicalMap } from "./load.js";

export type Confidence = "exact" | "renamed" | "none";

export interface CoverageTotals {
  total: number;
  exact: number;
  renamed: number;
  none: number;
}

export function emptyTotals(): CoverageTotals {
  return { total: 0, exact: 0, renamed: 0, none: 0 };
}

export function addTotals(into: CoverageTotals, from: CoverageTotals): void {
  into.total += from.total;
  into.exact += from.exact;
  into.renamed += from.renamed;
  into.none += from.none;
}

/** Exact bytes as a share of all bytes, rounded to 4 decimals; 0 for an empty total. */
export function share(totals: CoverageTotals): number {
  return totals.total === 0 ? 0 : Math.round((totals.exact / totals.total) * 10_000) / 10_000;
}

const MAP_COMMENT =
  /\n?(?:\/\/[#@]\s*sourceMappingURL=[^\n]*|\/\*[#@]\s*sourceMappingURL=[^*]*\*\/)\s*$/;

/**
 * Label every UTF-8 byte of a generated file `exact`, `renamed` or `none`. A mapping segment
 * covers its line from its column to the next segment; bytes before the first segment and
 * segments without a source are `none`. A line's newline takes the label of its last segment.
 * A trailing `sourceMappingURL` comment is metadata, not code, and is left out of the totals.
 */
export function coverageOf(
  code: string,
  map: LogicalMap | undefined,
  labelOf: (sourceIndex: number) => Confidence,
): CoverageTotals {
  const totals = emptyTotals();
  const add = (label: Confidence, bytes: number) => {
    totals[label] += bytes;
    totals.total += bytes;
  };
  const lines = code.replace(MAP_COMMENT, "").split("\n");
  for (const [index, line] of lines.entries()) {
    const newline = index < lines.length - 1 ? 1 : 0;
    const segments = map?.mappings[index] ?? [];
    if (segments.length === 0) {
      add("none", Buffer.byteLength(line) + newline);
      continue;
    }
    const first = segments[0]?.[0] ?? 0;
    add("none", Buffer.byteLength(line.slice(0, first)));
    let last: Confidence = "none";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;
      const end = segments[i + 1]?.[0] ?? line.length;
      last = segment.length === 1 ? "none" : labelOf(segment[1]);
      add(last, Buffer.byteLength(line.slice(segment[0], Math.max(end, segment[0]))));
    }
    add(last, newline);
  }
  return totals;
}
