import type { RequestRecord } from "../capture/request-log.js";
import type { WorkspacePaths } from "../capture/workspace.js";

/**
 * A recoverer teaches the pipeline about one kind of site (a framework, a rendering engine). Each
 * hook is optional and plugs into an existing stage; `generic` is the fallback with no hooks.
 * Bump the version whenever a hook's signature changes.
 */
export const RECOVERER_API_VERSION = 1;

/** `analysis/framework.json`: the recoverer detect chose and why. */
export interface FrameworkFile {
  recoverer: string;
  /** A variant inside the recoverer, such as `r3f` for React Three Fiber. */
  flavour: string | null;
  version: string | null;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  /** Things the site uses that s2s detects but cannot recover, such as `webgpu`. */
  unsupported: string[];
  details: Record<string, unknown>;
}

export interface DetectionResult {
  /** 0 to 1; a recoverer is chosen from 0.5. */
  confidence: number;
  flavour?: string | null;
  version?: string | null;
  evidence: string[];
  unsupported?: string[];
  details?: Record<string, unknown>;
}

export interface RecovererContext {
  paths: WorkspacePaths;
  packages: { name: string; version: string | null; status: string }[];
  requests: RequestRecord[];
  /** `raw/runtime.json`: one probe result per page and viewport. */
  runtime: Record<string, unknown>[];
  /** First-party and CDN JavaScript bodies, as text. */
  scripts(): Promise<{ url: string; hash: string; text: string }[]>;
}

export interface CaptureHintContext {
  /** Runtime probe results so far, one per page and viewport. */
  probes: Record<string, unknown>[];
}

export interface CaptureHints {
  /** Extra URLs to fetch through discovery. */
  urls?: string[];
  /** Run the deterministic WebGL pass (scene snapshots, keyframes, shaders). */
  webgl?: boolean;
}

export interface UnbundleHookContext {
  paths: WorkspacePaths;
  framework: FrameworkFile;
  warn(message: string): void;
}

export interface ScaffoldHookContext {
  paths: WorkspacePaths;
  framework: FrameworkFile;
  /** Recoverer-specific scaffold options, such as `assets` for three. */
  options: Record<string, unknown>;
  warn(message: string): void;
  /** Stats merged into the scaffold stage's own. */
  stats: Record<string, number>;
  /** Details merged into the scaffold stage's own (strings, numbers, booleans). */
  details: Record<string, string | number | boolean | null>;
}

export interface VerifyHints {
  /** Replay the WebGL keyframe walk and compare scene snapshots. */
  webgl?: boolean;
}

export interface Recoverer {
  name: string;
  apiVersion: typeof RECOVERER_API_VERSION;
  detect(ctx: RecovererContext): Promise<DetectionResult | null>;
  captureHints?(ctx: CaptureHintContext): CaptureHints | undefined;
  unbundleHints?(ctx: UnbundleHookContext): Promise<void>;
  /** Runs after the generic project files are written and before install and build. */
  scaffold?(ctx: ScaffoldHookContext): Promise<void>;
  /** Lines for a framework section in `AGENTS.md`. */
  agentNotes?(framework: FrameworkFile): string[];
  verifyHints?(framework: FrameworkFile): VerifyHints;
}
