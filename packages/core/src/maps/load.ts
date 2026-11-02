import { decodedMappings, type SourceMapSegment, TraceMap } from "@jridgewell/trace-mapping";
import { decodeDataUrl, SOURCE_MAPPING_URL } from "../capture/discovery/run.js";
import { joinSourceRoot } from "./paths.js";

/** One generated file's map, flattened: index maps (`sections`) become a single logical map. */
export interface LogicalMap {
  /** Raw source paths, joined with `sourceRoot` but not otherwise resolved. */
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  /** Decoded mappings per generated line (0-based), each line sorted by column. */
  mappings: SourceMapSegment[][];
}

export class MapError extends Error {
  override name = "MapError";
}

interface RawMap {
  version?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: unknown;
  names?: unknown;
  mappings?: unknown;
  sections?: unknown;
}

/** Parse map text, tolerating the `)]}'` anti-XSSI prefix the spec allows. */
export function parseMapText(text: string): RawMap {
  const body = text.replace(/^﻿/, "").replace(/^\)\]\}'?[^\n]*\n?/, "");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new MapError(`not valid JSON (${(error as Error).message.split("\n")[0]})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new MapError("not a JSON object");
  return json as RawMap;
}

/** Validate and flatten a parsed map. Throws `MapError` with a readable reason when unusable. */
export function loadMap(raw: RawMap): LogicalMap {
  if (raw.version !== 3) throw new MapError(`unsupported version ${JSON.stringify(raw.version)}`);
  const out: LogicalMap = { sources: [], sourcesContent: [], names: [], mappings: [] };
  if (raw.sections !== undefined) {
    addSections(raw, out, 0, 0, 0);
  } else {
    addPlain(raw, out, 0, 0, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  }
  for (const line of out.mappings) line.sort((a, b) => a[0] - b[0]);
  return out;
}

function addSections(raw: RawMap, out: LogicalMap, line: number, column: number, depth: number) {
  if (depth > 8) throw new MapError("index map nests too deeply");
  if (!Array.isArray(raw.sections)) throw new MapError("`sections` is not an array");
  const sections = raw.sections as {
    offset?: { line?: unknown; column?: unknown };
    map?: unknown;
  }[];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const offset = section?.offset;
    if (
      !section ||
      typeof offset?.line !== "number" ||
      typeof offset.column !== "number" ||
      typeof section.map !== "object" ||
      section.map === null
    ) {
      throw new MapError(
        `section ${i} has no valid offset or map (url sections are not supported)`,
      );
    }
    const next = sections[i + 1]?.offset;
    const sLine = line + offset.line;
    const sColumn = offset.line === 0 ? column + offset.column : offset.column;
    const stopLine = typeof next?.line === "number" ? line + next.line : Number.POSITIVE_INFINITY;
    const stopColumn =
      typeof next?.column === "number"
        ? next.line === 0
          ? column + next.column
          : next.column
        : Number.POSITIVE_INFINITY;
    const map = section.map as RawMap;
    if (map.version !== 3)
      throw new MapError(`section ${i}: unsupported version ${JSON.stringify(map.version)}`);
    if (map.sections !== undefined) addSections(map, out, sLine, sColumn, depth + 1);
    else addPlain(map, out, sLine, sColumn, stopLine, stopColumn);
  }
}

function addPlain(
  raw: RawMap,
  out: LogicalMap,
  lineOffset: number,
  columnOffset: number,
  stopLine: number,
  stopColumn: number,
): void {
  if (!Array.isArray(raw.sources)) throw new MapError("`sources` is not an array");
  if (typeof raw.mappings !== "string") throw new MapError("`mappings` is not a string");
  if (!/^[A-Za-z0-9+/,;]*$/.test(raw.mappings))
    throw new MapError("`mappings` holds characters outside base64 VLQ");
  const sourceRoot = typeof raw.sourceRoot === "string" ? raw.sourceRoot : undefined;
  const sources = (raw.sources as unknown[]).map((s) => (typeof s === "string" ? s : ""));
  const contents = Array.isArray(raw.sourcesContent) ? (raw.sourcesContent as unknown[]) : [];
  const names = Array.isArray(raw.names)
    ? (raw.names as unknown[]).map((n) => (typeof n === "string" ? n : ""))
    : [];

  let decoded: Readonly<SourceMapSegment[][]>;
  try {
    decoded = decodedMappings(
      new TraceMap({ version: 3, sources, names, mappings: raw.mappings }),
    ) as Readonly<SourceMapSegment[][]>;
  } catch (error) {
    throw new MapError(`mappings do not decode (${(error as Error).message})`);
  }

  const sourceOffset = out.sources.length;
  const nameOffset = out.names.length;
  for (const [i, source] of sources.entries()) {
    out.sources.push(joinSourceRoot(sourceRoot, source));
    const content = contents[i];
    out.sourcesContent.push(typeof content === "string" ? content : null);
  }
  out.names.push(...names);

  for (let i = 0; i < decoded.length; i++) {
    const line = lineOffset + i;
    if (line > stopLine) break;
    const segments = decoded[i] ?? [];
    for (const segment of segments) {
      for (const value of segment) {
        if (!Number.isInteger(value) || value < 0)
          throw new MapError(`mappings decode to an invalid value on generated line ${i + 1}`);
      }
      const column = (i === 0 ? columnOffset : 0) + segment[0];
      if (line === stopLine && column >= stopColumn) break;
      if (segment.length === 1) {
        lineAt(out.mappings, line).push([column]);
        continue;
      }
      const sourceIndex = segment[1];
      if (sourceIndex >= sources.length) {
        throw new MapError(
          `mappings reference source ${sourceIndex} but the map lists ${sources.length}`,
        );
      }
      if (segment.length === 5) {
        if (segment[4] >= names.length) {
          throw new MapError(
            `mappings reference name ${segment[4]} but the map lists ${names.length}`,
          );
        }
        lineAt(out.mappings, line).push([
          column,
          sourceOffset + sourceIndex,
          segment[2],
          segment[3],
          nameOffset + segment[4],
        ]);
      } else {
        lineAt(out.mappings, line).push([
          column,
          sourceOffset + sourceIndex,
          segment[2],
          segment[3],
        ]);
      }
    }
  }
}

function lineAt(lines: SourceMapSegment[][], index: number): SourceMapSegment[] {
  for (let i = lines.length; i <= index; i++) lines[i] = [];
  return lines[index] as SourceMapSegment[];
}

/** The last `sourceMappingURL` in a JS or CSS body, if it is an inline `data:` URL, decoded. */
export function inlineMap(body: string): string | undefined {
  const comment = [...body.matchAll(SOURCE_MAPPING_URL)].at(-1)?.[1];
  if (!comment?.startsWith("data:")) return undefined;
  return decodeDataUrl(comment)?.toString("utf8");
}
