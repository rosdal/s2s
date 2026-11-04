import path from "node:path";
import type * as t from "@babel/types";
import type { Root } from "postcss";
import type { RequestRecord } from "../capture/request-log.js";
import { applyEdits, end, parseCode, start, type TextEdit, traverse } from "./ast.js";
import type { Draft, ImportLine } from "./types.js";

export interface AssetFile {
  url: string;
  bodyHash: string;
  /** Workspace-relative path, `assets/logo.png`. */
  file: string;
  kind: "fonts" | "media";
  bytes: number;
}

const strip = (u: string) => u.replace(/[?#].*$/, "");

/** Images, fonts and media the capture stored, named by their URL minus the build hash. */
export function planAssets(records: RequestRecord[]): AssetFile[] {
  const out: AssetFile[] = [];
  const seen = new Set<string>();
  const taken = new Set<string>();
  const sorted = [...records].sort((a, b) => a.url.localeCompare(b.url));
  for (const r of sorted) {
    if (
      (r.origin !== "fonts" && r.origin !== "media") ||
      !r.bodyHash ||
      r.status < 200 ||
      r.status >= 300
    )
      continue;
    const url = strip(r.url);
    if (seen.has(url) || url.startsWith("data:")) continue;
    seen.add(url);
    out.push({
      url,
      bodyHash: r.bodyHash,
      file: `assets/${readableName(url, r.mimeType, taken)}`,
      kind: r.origin,
      bytes: r.size ?? 0,
    });
  }
  return out;
}

const EXT_OF: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
};

/** `logo-DkYr1V8R.png` → `logo.png`, `font.3b1f0a9c.woff2` → `font.woff2`. */
export function readableName(url: string, mime: string | null, taken: Set<string>): string {
  let base: string;
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    base = url.split("/").pop() ?? "";
  }
  let ext = path.extname(base).toLowerCase();
  let stem = base.slice(0, base.length - ext.length);
  if (!ext || ext.length > 6) {
    ext = EXT_OF[mime ?? ""] ?? "";
    stem = base;
  }
  stem = stem
    .replace(/[.-][0-9a-f]{8,}$/i, "")
    .replace(/-[A-Za-z0-9_-]{8}$/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!stem) stem = "asset";
  let name = `${stem}${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

export function assetIndex(
  assets: AssetFile[],
): (spec: string, base: string) => AssetFile | undefined {
  const byUrl = new Map(assets.map((a) => [a.url, a]));
  return (spec, base) => {
    if (!spec || spec.startsWith("data:") || (/^[a-z]+:/i.test(spec) && !/^https?:/i.test(spec)))
      return undefined;
    try {
      return byUrl.get(strip(new URL(spec, base).href));
    } catch {
      return undefined;
    }
  };
}

const posix = (p: string) => p.split(path.sep).join("/");

export function relativeFile(fromFile: string, toFile: string): string {
  const rel = posix(path.posix.relative(path.posix.dirname(fromFile), toFile));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Point `url(…)` references in a stylesheet at the copied assets. Returns how many changed. */
export function rewriteCssUrls(
  root: Root,
  cssUrl: string,
  outFile: string,
  find: ReturnType<typeof assetIndex>,
): number {
  let changed = 0;
  root.walkDecls((decl) => {
    if (!decl.value.includes("url(")) return;
    decl.value = decl.value.replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
      (whole, quote: string, spec: string) => {
        const asset = find(spec.trim(), cssUrl);
        if (!asset) return whole;
        changed++;
        return `url(${quote || '"'}${relativeFile(outFile, asset.file)}${quote || '"'})`;
      },
    );
  });
  root.walkAtRules("import", () => {});
  return changed;
}

/**
 * Replace string literals in a module that name a copied asset (`"/assets/logo-x.png"`, or the
 * webpack public path plus a file) with an imported binding, so the bundler handles the file.
 */
export function rewriteJsAssets(draft: Draft, find: ReturnType<typeof assetIndex>): number {
  let ast: t.File;
  try {
    ast = parseCode(draft.code);
  } catch {
    return 0;
  }
  const edits: TextEdit[] = [];
  const lines: ImportLine[] = [];
  const names = new Map<string, string>();
  const used = new Set<string>();
  traverse(ast, {
    Identifier(p) {
      used.add(p.node.name);
    },
  });
  const bindingFor = (file: string) => {
    let name = names.get(file);
    if (name) return name;
    const stem = file.replace(/^assets\//, "").replace(/[^A-Za-z0-9_$]/g, "_");
    name = `asset_${stem}`;
    while (used.has(name)) name = `_${name}`;
    used.add(name);
    names.set(file, name);
    lines.push({ target: { kind: "file", path: file }, names: [], defaultName: name });
    return name;
  };
  const value = (node: t.Node): string | undefined => {
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0)
      return node.quasis[0]?.value.cooked ?? undefined;
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const l = value(node.left);
      const r = value(node.right);
      return l !== undefined && r !== undefined ? l + r : undefined;
    }
    return undefined;
  };
  const visit = (p: { node: t.Node; parent: t.Node | null | undefined; skip(): void }) => {
    const parent = p.parent;
    // Module specifiers and object keys are not asset references.
    if (
      parent?.type === "ImportDeclaration" ||
      parent?.type === "ExportNamedDeclaration" ||
      parent?.type === "ExportAllDeclaration" ||
      parent?.type === "ImportExpression" ||
      (parent?.type === "CallExpression" &&
        parent.callee.type === "Identifier" &&
        parent.callee.name === "require") ||
      (parent?.type === "ObjectProperty" && parent.key === p.node)
    )
      return;
    const v = value(p.node);
    if (v === undefined || !/\.[A-Za-z0-9]{2,5}(?:[?#]|$)/.test(v)) return;
    const asset = find(v, draft.chunk.url);
    if (!asset) return;
    edits.push({ start: start(p.node), end: end(p.node), text: bindingFor(asset.file) });
    p.skip();
  };
  traverse(ast, {
    BinaryExpression(p) {
      if (p.parent.type === "BinaryExpression" && p.parent.operator === "+") return;
      visit(p);
    },
    StringLiteral(p) {
      visit(p);
    },
    TemplateLiteral(p) {
      visit(p);
    },
  });
  if (edits.length === 0) return 0;
  draft.code = applyEdits(draft.code, edits);
  draft.head.push(...lines);
  return edits.length;
}
