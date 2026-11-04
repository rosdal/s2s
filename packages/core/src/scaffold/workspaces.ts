import path from "node:path";

const posix = path.posix;

/** Folders a monorepo keeps its own packages in. */
const WORKSPACE_DIRS = new Set(["packages", "apps", "libs", "modules"]);
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

/**
 * A package the recovered code imports by name that is really one of the site's own monorepo
 * packages: `@excalidraw/element` with its sources recovered under `packages/element/`. The
 * scaffold aliases it to that folder instead of installing whatever npm has under the name.
 */
export interface WorkspacePackage {
  name: string;
  /** Project-relative folder the name and its subpaths resolve in (`project/src/.../src`). */
  root: string;
}

/**
 * Packages in `imported` with a recovered `packages/<name>/` folder (or `apps/`, `libs/`,
 * `modules/`) and no `node_modules` evidence: Stage 3 never saw them installed, so they were
 * built from the workspace. Subpath imports resolve under `src/` when the folder has one.
 */
export function findWorkspacePackages(
  imported: Iterable<string>,
  files: Iterable<string>,
  installed: Set<string>,
): WorkspacePackage[] {
  const folders = new Set<string>();
  for (const file of files) {
    if (!file.startsWith("project/src/_recovered/") || file.includes("/_vendor/")) continue;
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const out: WorkspacePackage[] = [];
  for (const name of [...new Set(imported)].sort()) {
    if (installed.has(name) || name.startsWith("node:")) continue;
    const base = name.split("/").at(-1) ?? name;
    const candidates = [...folders]
      .filter((f) => {
        const parts = f.split("/");
        return parts.at(-1) === base && WORKSPACE_DIRS.has(parts.at(-2) ?? "");
      })
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    const folder = candidates[0];
    if (!folder) continue;
    out.push({ name, root: folders.has(`${folder}/src`) ? `${folder}/src` : folder });
  }
  return out;
}

/** Where a bare specifier lands among workspace packages, or undefined for a real package. */
export function resolveWorkspaceSpecifier(
  spec: string,
  packages: WorkspacePackage[],
): string | undefined {
  for (const pkg of packages) {
    if (spec === pkg.name) return pkg.root;
    if (spec.startsWith(`${pkg.name}/`))
      return posix.join(pkg.root, spec.slice(pkg.name.length + 1));
  }
  return undefined;
}

/** The file a bare `import "<name>"` should load: the root's index file, when there is one. */
export function workspaceEntry(pkg: WorkspacePackage, files: Set<string>): string {
  const lower = new Set([...files].map((f) => f.toLowerCase()));
  for (const index of INDEX_FILES) {
    const file = `${pkg.root}/${index}`;
    if (lower.has(file.toLowerCase())) return file;
  }
  return pkg.root;
}
