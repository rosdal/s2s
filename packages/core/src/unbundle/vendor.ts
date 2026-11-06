import { end, type NodePath, start, type TextEdit } from "./ast.js";
import type { ImportLine, VendorSpan } from "./types.js";

/** `react-dom` → `__vendor_react_dom`; the name a vendor namespace import binds. */
/**
 * What `require("pkg")` returns, read through a namespace import of it: `module.exports`, which
 * the bundler offers as `default` (seedrandom is a function with `.alea` on it), unless the module
 * is an ES module compiled to CommonJS, whose exports the namespace already is.
 */
export function cjsValue(ns: string): string {
  return `(${ns}[${ns}.__esModule ? "" : "default"] ?? ${ns})`;
}

export function vendorNamespace(pkg: string): string {
  return `__vendor_${pkg.replace(/^@/, "").replace(/[^A-Za-z0-9_$]/g, "_")}`;
}

/**
 * Packages whose bundled code usually spans more than one entry point. Stage 3 names the package,
 * not the subpath, so a vendor namespace for `react-dom` must also carry `react-dom/client`
 * (`createRoot`) for the code that called through it to keep working.
 */
export const MERGED_ENTRIES: Record<string, { entries: string[]; sinceMajor: number }> = {
  // react-dom/client arrived in React 18.
  "react-dom": { entries: ["react-dom", "react-dom/client"], sinceMajor: 18 },
};

/** The import lines for a vendor namespace: one `import * as`, or a merge of several entry points. */
export function vendorNamespaceLines(
  namespace: string,
  pkg: string,
  version?: string | null,
): string[] {
  const merged = MERGED_ENTRIES[pkg];
  const major = version ? Number.parseInt(version, 10) : Number.NaN;
  // An unknown version gets the merge: React 18 and later are what sites ship today.
  const entries = merged && !(major < merged.sinceMajor) ? merged.entries : undefined;
  if (!entries || !namespace.startsWith("__vendor_"))
    return [`import * as ${namespace} from ${JSON.stringify(pkg)};`];
  const parts = entries.map((_, i) => `${namespace}$${i}`);
  return [
    ...entries.map((entry, i) => `import * as ${parts[i]} from ${JSON.stringify(entry)};`),
    `const ${namespace} = { ${parts.map((p) => `...${p}`).join(", ")} };`,
  ];
}

export function vendorImport(span: Pick<VendorSpan, "package" | "version">): ImportLine {
  return {
    target: { kind: "package", name: span.package },
    names: [],
    namespace: vendorNamespace(span.package),
    version: span.version,
    note: `vendor code from ${span.package}${span.version ? `@${span.version}` : ""} was removed here; the entry point is a guess, so check the import path and what is used from it`,
  };
}

/**
 * The vendor package a span of code belongs to, when one package's ranges cover nearly all of it
 * (at least `share` of its length). A module whose wrapper or padding sits outside a range still
 * counts.
 */
export function coveringPackage(
  spans: VendorSpan[],
  from: number,
  to: number,
  share = 0.9,
): VendorSpan | undefined {
  const length = to - from;
  if (length <= 0) return undefined;
  const byPackage = new Map<string, { covered: number; span: VendorSpan }>();
  for (const span of spans) {
    const overlap = Math.min(span.end, to) - Math.max(span.start, from);
    if (overlap <= 0) continue;
    const known = byPackage.get(span.package) ?? { covered: 0, span };
    known.covered += overlap;
    byPackage.set(span.package, known);
  }
  let best: { covered: number; span: VendorSpan } | undefined;
  for (const entry of byPackage.values()) if (!best || entry.covered > best.covered) best = entry;
  return best && best.covered / length >= share ? best.span : undefined;
}

/** A vendor range that is exactly one function (a CommonJS wrapper's factory), give or take. */
function matchesFunction(span: VendorSpan, node: { start?: number | null; end?: number | null }) {
  const s = node.start ?? -1;
  const e = node.end ?? -1;
  return Math.abs(span.start - s) <= 2 && Math.abs(span.end - e) <= 2;
}

/**
 * Replace CommonJS wrappers whose factory is vendor code (`var t = __commonJS((e, t) => {…})`,
 * webpack's `n.cw(e => {…})`) with a getter for the package: `() => __vendor_react`. The binding
 * keeps working as a lazy `require`, and the import makes the dependency real.
 */
export function wrapperEdits(
  functions: NodePath[],
  spans: VendorSpan[],
): {
  edits: TextEdit[];
  imports: ImportLine[];
  removed: number;
  covered: VendorSpan[];
  /** Getter bindings (`t` in `var t = ...`) and the package import each now stands for. */
  getters: Map<string, ImportLine>;
} {
  const edits: TextEdit[] = [];
  const imports = new Map<string, ImportLine>();
  const getters = new Map<string, ImportLine>();
  const covered: VendorSpan[] = [];
  let removed = 0;
  for (const span of spans) {
    const fn = functions.find((p) => matchesFunction(span, p.node));
    const call = fn?.parentPath;
    if (!fn || !call?.isCallExpression() || !call.node.arguments.includes(fn.node as never))
      continue;
    const name = vendorNamespace(span.package);
    edits.push({ start: start(call.node), end: end(call.node), text: `() => ${cjsValue(name)}` });
    // `t()` calls of the getter read the package directly.
    const declarator = call.parentPath;
    if (declarator?.isVariableDeclarator() && declarator.node.id.type === "Identifier") {
      getters.set(declarator.node.id.name, imports.get(span.package) ?? vendorImport(span));
      const binding = declarator.scope.getBinding(declarator.node.id.name);
      for (const ref of binding?.referencePaths ?? []) {
        const use = ref.parentPath;
        if (
          use?.isCallExpression() &&
          use.node.callee === ref.node &&
          use.node.arguments.length === 0
        )
          edits.push({ start: start(use.node), end: end(use.node), text: name });
      }
    }
    if (!imports.has(span.package)) imports.set(span.package, vendorImport(span));
    removed += end(call.node) - start(call.node);
    covered.push(span);
  }
  return { edits, imports: [...imports.values()], removed, covered, getters };
}
