import type { PackageManager } from "../detect/project.js";
import type { ModuleKind, ModuleOrigin } from "../unbundle/graph.js";

export const TARGETS = ["react", "vue", "preact", "vanilla"] as const;
export type Target = (typeof TARGETS)[number];

export interface Thresholds {
  /** Largest share of differing pixels per page and viewport, 0 to 1. */
  maxPixelDiff: number;
  /** Smallest DOM-tree similarity to the captured hydrated DOM, 0 to 1. */
  minDomSimilarity: number;
  /** Console errors the capture did not have. */
  maxNewConsoleErrors: number;
  /** Requests to the rebuilt site that failed (404s, broken imports); blocked requests don't count. */
  maxFailedRequests: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxPixelDiff: 0.02,
  minDomSimilarity: 0.95,
  maxNewConsoleErrors: 0,
  maxFailedRequests: 0,
};

/** A stack line in AGENTS.md: what was detected, how sure, and the file that says so. */
export interface StackFact {
  label: string;
  value: string;
  confidence: string;
  source: string;
}

export interface PackageFact {
  name: string;
  version: string | null;
  confidence: string;
  dev: boolean;
}

export interface ReviewFact {
  name: string;
  version: string | null;
  confidence: string;
  reason: string | null;
}

export interface GroupModuleFact {
  /** Path inside `project/`, where the agent edits it. */
  file: string;
  /** Path in the read-only workspace copy (`recovered/…`). */
  original: string;
  kind: ModuleKind;
  origin: ModuleOrigin;
}

export interface GroupFact {
  id: string;
  bytes: number;
  modules: GroupModuleFact[];
}

/** Everything the agent files say, gathered from `analysis/` and the manifest. */
export interface AgentFacts {
  site: string;
  pages: { slug: string; url: string }[];
  viewports: string[];
  target: Target;
  /** The SSR framework the site was built with, when the scaffold is a Vite SPA stand-in for it. */
  fallbackFrom: string | null;
  stack: StackFact[];
  packageManager: PackageManager;
  packages: PackageFact[];
  review: ReviewFact[];
  modules: {
    total: number;
    exact: number;
    renamed: number;
    unbundled: number;
    obfuscated: number;
    styles: number;
  };
  groups: GroupFact[];
  /** `// s2s:` notes left in the recovered code. */
  notes: number;
  thresholds: Thresholds;
  /** A section from the chosen recoverer's `agentNotes`; absent for the generic recoverer. */
  framework?: { name: string; lines: string[] };
}

/** `pnpm --dir project run build` and friends: one command form per manager, run from the workspace root. */
export function projectScript(pm: PackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm --dir project run ${script}`;
    case "npm":
      return `npm --prefix project run ${script}`;
    case "yarn":
      return `yarn --cwd project run ${script}`;
    case "bun":
      return `bun --cwd project run ${script}`;
  }
}
