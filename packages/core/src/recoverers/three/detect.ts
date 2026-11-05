import type { DetectionResult, RecovererContext } from "../api.js";

/** Strings three's addons keep after minification (error messages, extension names, paths). */
export const ADDON_MARKERS: Record<string, RegExp> = {
  GLTFLoader:
    /THREE\.GLTFLoader|KHR_materials_emissive_strength|glTF versions >=2\.0 are supported/,
  DRACOLoader: /THREE\.DRACOLoader|draco_wasm_wrapper|draco_decoder/,
  KTX2Loader: /THREE\.KTX2Loader|basis_transcoder/,
  MeshoptDecoder: /\.setMeshoptDecoder\(|meshopt_decoder/,
  RGBELoader: /THREE\.RGBELoader|#\?RADIANCE/,
  EXRLoader: /THREE\.EXRLoader|EXRLoader/,
  EffectComposer: /THREE\.EffectComposer|EffectComposer/,
  UnrealBloomPass: /UnrealBloomPass|luminosityThreshold/,
  OrbitControls: /THREE\.OrbitControls|OrbitControls/,
};

/** npm packages that commonly travel with three, by markers in their code. */
export const COMPANION_MARKERS: Record<string, RegExp> = {
  "@react-three/fiber": /__r3f|R3F: |react-three-fiber/,
  "@react-three/drei": /@react-three\/drei|drei/,
  postprocessing: /EffectPass|BlendFunction|pmndrs\/postprocessing/,
  gsap: /registerPlugin|_gsap/,
  "gsap/ScrollTrigger": /ScrollTrigger/,
  lenis: /lenis-smooth|lenis-scrolling|__lenis/,
  "@dimforge/rapier3d-compat": /rapier_wasm3d|RAPIER|rawintegrationparameters/i,
  "cannon-es": /cannon-es|CANNON\./,
  howler: /howler\.js|Howler/,
};

const PHYSICS = ["@dimforge/rapier3d-compat", "cannon-es", "ammo"];

const WEBGPU =
  /getContext\(\s*["']webgpu["']\)|navigator\.gpu\.requestAdapter|WebGPURenderer|@fragment\s+fn |var<uniform>/;

const ENGINES: Record<string, RegExp> = {
  babylon: /babylonjs|BABYLON\.Engine|Babylon\.js v\d/,
  playcanvas: /playcanvas|PlayCanvas Engine/i,
};

/** three's `REVISION`, from `__THREE__ = "187"` or the devtools `register` event. */
export function revisionIn(text: string): string | null {
  const m =
    /__THREE__\s*=\s*["'`](\d{2,3})(?:dev)?["'`]/.exec(text) ??
    /revision\s*:\s*["'`](\d{2,3})(?:dev)?["'`]/.exec(text);
  return m ? (m[1] as string) : null;
}

export interface ThreeSignals {
  revision: string | null;
  addons: string[];
  companions: string[];
  r3f: boolean;
  decoders: string[];
  webgpu: boolean;
  physics: string[];
  engines: string[];
  webglContexts: number;
}

interface ProbeWebgl {
  contexts?: Record<string, number>;
  revision?: string | null;
  r3f?: boolean;
}

/** Everything a workspace says about three: probe results, shipped code and decoder requests. */
export async function threeSignals(ctx: RecovererContext): Promise<ThreeSignals> {
  let revision: string | null = null;
  let webglContexts = 0;
  let webgpu = false;
  let r3fProbe = false;
  for (const p of ctx.runtime) {
    const frameworks = (p.frameworks ?? {}) as Record<string, unknown>;
    const three = frameworks.three as { revision?: string } | undefined;
    if (three?.revision) revision ??= three.revision;
    const webgl = frameworks.webgl as ProbeWebgl | undefined;
    if (webgl) {
      webglContexts += (webgl.contexts?.webgl ?? 0) + (webgl.contexts?.webgl2 ?? 0);
      if ((webgl.contexts?.webgpu ?? 0) > 0) webgpu = true;
      if (webgl.revision) revision ??= webgl.revision;
      if (webgl.r3f) r3fProbe = true;
    }
  }
  const scripts = await ctx.scripts();
  const addons = new Set<string>();
  const companions = new Set<string>();
  const engines = new Set<string>();
  for (const { text } of scripts) {
    if (!revision) revision = revisionIn(text);
    for (const [name, re] of Object.entries(ADDON_MARKERS)) if (re.test(text)) addons.add(name);
    for (const [name, re] of Object.entries(COMPANION_MARKERS))
      if (re.test(text)) companions.add(name);
    for (const [name, re] of Object.entries(ENGINES)) if (re.test(text)) engines.add(name);
    if (WEBGPU.test(text)) webgpu = true;
  }
  // Packages Stage 3 accepted are better evidence than markers.
  for (const p of ctx.packages)
    if (p.name in COMPANION_MARKERS && p.status !== "rejected") companions.add(p.name);
  const decoders = new Set<string>();
  for (const r of ctx.requests)
    for (const tag of r.tags ?? []) if (tag.startsWith("decoder:")) decoders.add(tag.slice(8));
  const r3f = r3fProbe || companions.has("@react-three/fiber");
  return {
    revision,
    addons: [...addons].sort(),
    companions: [...companions].sort(),
    r3f,
    decoders: [...decoders].sort(),
    webgpu,
    physics: PHYSICS.filter((p) => companions.has(p)),
    engines: [...engines].sort(),
    webglContexts,
  };
}

export async function detectThree(ctx: RecovererContext): Promise<DetectionResult | null> {
  const s = await threeSignals(ctx);
  const pkg = ctx.packages.find((p) => p.name === "three" && p.status !== "rejected");
  const unsupported = [...(s.webgpu ? ["webgpu"] : []), ...s.engines];
  const evidence: string[] = [];
  let confidence = 0;
  if (pkg) {
    evidence.push(`three in analysis/packages.json (${pkg.status})`);
    confidence = Math.max(confidence, 0.8);
  }
  if (s.revision) {
    evidence.push(`REVISION ${s.revision}`);
    confidence = Math.max(confidence, 0.9);
  }
  if (s.webglContexts > 0) evidence.push(`${s.webglContexts} WebGL context(s) at runtime`);
  if (confidence === 0)
    return unsupported.length > 0 ? { confidence: 0, evidence, unsupported } : null;
  // A WebGPU-only three site still gets detected, but the deterministic pass can't snapshot it.
  return {
    confidence,
    flavour: s.r3f ? "r3f" : "vanilla",
    version: s.revision ? `0.${s.revision}` : (pkg?.version ?? null),
    evidence,
    unsupported,
    details: { ...s },
  };
}
