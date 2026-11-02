import { createHash } from "node:crypto";
import path from "node:path";

const MAX_SLUG = 80;

function slugPart(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function capSlug(slug: string, seed: string): string {
  if (slug.length <= MAX_SLUG) return slug;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG - 9).replace(/-+$/, "")}-${hash}`;
}

/** Workspace folder name for a target URL: host (minus `www.`) plus path, e.g. `shopify-com-editions-winter2026`. */
export function workspaceSlug(target: string | URL): string {
  const url = new URL(target);
  const host = url.hostname.replace(/^www\./, "");
  const port = url.port ? `-${url.port}` : "";
  const slug = slugPart(`${host}${port} ${url.pathname}`) || "site";
  return capSlug(slug, url.href);
}

/** Folder name for one captured page inside `raw/pages/`; the site root is `index`. */
export function pageSlug(target: string | URL): string {
  const url = new URL(target);
  let slug = slugPart(url.pathname) || "index";
  if (url.search) {
    const hash = createHash("sha256").update(url.search).digest("hex").slice(0, 8);
    slug = `${slug}-q${hash}`;
  }
  return capSlug(slug, url.href);
}

export interface WorkspacePaths {
  root: string;
  manifest: string;
  raw: string;
  requests: string;
  bodies: string;
  maps: string;
  pages: string;
  screenshots: string;
  runtime: string;
  cdnPackages: string;
  discovery: string;
  har: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const abs = path.resolve(root);
  const raw = path.join(abs, "raw");
  return {
    root: abs,
    manifest: path.join(abs, "manifest.json"),
    raw,
    requests: path.join(raw, "requests.jsonl"),
    bodies: path.join(raw, "bodies"),
    maps: path.join(raw, "maps"),
    pages: path.join(raw, "pages"),
    screenshots: path.join(raw, "screenshots"),
    runtime: path.join(raw, "runtime.json"),
    cdnPackages: path.join(raw, "cdn-packages.json"),
    discovery: path.join(raw, "discovery.json"),
    har: path.join(raw, "capture.har"),
  };
}
