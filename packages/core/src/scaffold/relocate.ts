import path from "node:path";
import type * as t from "@babel/types";
import { parseCode, traverse } from "../unbundle/ast.js";

const posix = path.posix;

/** Whether a module uses JSX, so it needs a `.jsx` name for Vite to compile it. */
export function hasJsx(code: string): boolean {
  if (!/<[A-Za-z>]/.test(code)) return false;
  let ast: t.File;
  try {
    ast = parseCode(code);
  } catch {
    return false;
  }
  let found = false;
  traverse(ast, {
    "JSXElement|JSXFragment"(p) {
      found = true;
      p.stop();
    },
  });
  return found;
}

function relative(fromFile: string, toFile: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Rewrite relative references in a moved file (import specifiers, `import()`, CSS `url()`) so they
 * point at where their targets moved. `moves` maps old workspace-relative paths (lower case) to new
 * ones; a reference to anything that did not move is re-pointed at its old location.
 */
export function relocateReferences(
  text: string,
  oldFile: string,
  newFile: string,
  moves: Map<string, string>,
): string {
  const target = (spec: string): string | undefined => {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
    const [bare = spec, suffix = ""] = spec.split(/(?=[?#])/, 2);
    const resolved = posix.normalize(posix.join(posix.dirname(oldFile), bare));
    const moved = moves.get(resolved.toLowerCase());
    if (!moved) return undefined;
    return relative(newFile, moved) + suffix;
  };
  return text
    .replace(/(["'`])(\.\.?\/[^"'`\n]*)\1/g, (whole, quote: string, spec: string) => {
      const next = target(spec);
      return next ? `${quote}${next}${quote}` : whole;
    })
    .replace(/url\(\s*(\.\.?\/[^)"'\s]+)\s*\)/g, (whole, spec: string) => {
      const next = target(spec);
      return next ? `url(${next})` : whole;
    });
}
