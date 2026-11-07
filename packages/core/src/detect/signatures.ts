import { z } from "zod";
import rapier from "./signatures/@dimforge__rapier3d-compat.json" with { type: "json" };
import r3f from "./signatures/@react-three__fiber.json" with { type: "json" };
import axios from "./signatures/axios.json" with { type: "json" };
import chartJs from "./signatures/chart.js.json" with { type: "json" };
import coreJs from "./signatures/core-js.json" with { type: "json" };
import d3 from "./signatures/d3.json" with { type: "json" };
import dayjs from "./signatures/dayjs.json" with { type: "json" };
import framerMotion from "./signatures/framer-motion.json" with { type: "json" };
import gsap from "./signatures/gsap.json" with { type: "json" };
import jquery from "./signatures/jquery.json" with { type: "json" };
import lenis from "./signatures/lenis.json" with { type: "json" };
import lodash from "./signatures/lodash.json" with { type: "json" };
import moment from "./signatures/moment.json" with { type: "json" };
import preact from "./signatures/preact.json" with { type: "json" };
import react from "./signatures/react.json" with { type: "json" };
import reactDom from "./signatures/react-dom.json" with { type: "json" };
import regeneratorRuntime from "./signatures/regenerator-runtime.json" with { type: "json" };
import svelte from "./signatures/svelte.json" with { type: "json" };
import swiper from "./signatures/swiper.json" with { type: "json" };
import tailwindcss from "./signatures/tailwindcss.json" with { type: "json" };
import three from "./signatures/three.json" with { type: "json" };
import vue from "./signatures/vue.json" with { type: "json" };
import zod from "./signatures/zod.json" with { type: "json" };

export const SignaturePattern = z.object({
  /** Unique inside its file; shows up in `--explain`. */
  id: z.string(),
  /**
   * A regular expression, with `{q}` for any quote (minifiers turn `"` into a backtick),
   * `{semver}` for a full version and `{semverTail}` for the part after the major. A named group
   * `version` makes the pattern version-bearing; without it, a match only names the package.
   */
  regex: z.string(),
  /** Literal tokens, at least `minAnchors` of which must appear within `window` characters. */
  anchors: z.array(z.string()).min(1),
  minAnchors: z.number().int().min(1).default(1),
  window: z.number().int().min(1),
  /** Turns a partial capture into a version, e.g. `0.{version}.x` for three's `REVISION`. */
  versionTemplate: z.string().optional(),
  files: z.enum(["js", "css", "any"]).default("js"),
  /** Matches kept per file; name-only patterns need just one. */
  maxMatches: z.number().int().min(1).default(5),
});
export type SignaturePattern = z.infer<typeof SignaturePattern>;

export const Signature = z.object({
  package: z.string(),
  /** A build-time tool (tailwindcss): matches land in `devDependencies`. */
  dev: z.boolean().default(false),
  patterns: z.array(SignaturePattern).min(1),
});
export type Signature = z.infer<typeof Signature>;

/** Every signature file under `signatures/`. A test checks that none is missing from this list. */
export const SIGNATURE_FILES: unknown[] = [
  rapier,
  r3f,
  axios,
  chartJs,
  coreJs,
  d3,
  dayjs,
  framerMotion,
  gsap,
  jquery,
  lenis,
  lodash,
  moment,
  preact,
  react,
  reactDom,
  regeneratorRuntime,
  svelte,
  swiper,
  tailwindcss,
  three,
  vue,
  zod,
];

export interface CompiledPattern {
  package: string;
  dev: boolean;
  pattern: SignaturePattern;
  regex: RegExp;
  versioned: boolean;
}

const MACROS: Record<string, string> = {
  q: "[\"'`]",
  semver: String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`,
  semverTail: String.raw`\d+\.\d+(?:-[0-9A-Za-z.-]+)?`,
};

export function compileSignatures(files: unknown[] = SIGNATURE_FILES): CompiledPattern[] {
  return files.flatMap((file) => {
    const signature = Signature.parse(file);
    return signature.patterns.map((pattern) => {
      const source = pattern.regex.replace(/\{(q|semver|semverTail)\}/g, (_, k: string) => {
        return MACROS[k] ?? "";
      });
      return {
        package: signature.package,
        dev: signature.dev,
        pattern,
        regex: new RegExp(source, "g"),
        versioned: source.includes("(?<version>"),
      };
    });
  });
}

export interface SignatureMatch {
  package: string;
  dev: boolean;
  patternId: string;
  /** `null` for name-only patterns. */
  version: string | null;
  /** String index of the match. */
  index: number;
  length: number;
  anchors: string[];
}

/**
 * Run compiled signatures over one file. A match counts only when enough of its anchor tokens
 * sit within the pattern's window, so a stray `"4.17.21"` on its own never names lodash.
 */
export function matchSignatures(
  text: string,
  kind: "js" | "css",
  patterns: CompiledPattern[],
): SignatureMatch[] {
  const out: SignatureMatch[] = [];
  for (const compiled of patterns) {
    const { pattern } = compiled;
    if (pattern.files !== "any" && pattern.files !== kind) continue;
    // Cheap pre-check: skip the regex when too few anchors appear anywhere in the file.
    if (pattern.anchors.filter((a) => text.includes(a)).length < pattern.minAnchors) continue;
    let kept = 0;
    compiled.regex.lastIndex = 0;
    for (const m of text.matchAll(compiled.regex)) {
      if (kept >= pattern.maxMatches) break;
      const start = Math.max(0, m.index - pattern.window);
      const around = text.slice(start, m.index + m[0].length + pattern.window);
      const anchors = pattern.anchors.filter((a) => around.includes(a));
      if (anchors.length < pattern.minAnchors) continue;
      const captured = m.groups?.version ?? null;
      const version =
        captured === null
          ? null
          : pattern.versionTemplate
            ? pattern.versionTemplate.replace("{version}", captured)
            : captured;
      out.push({
        package: compiled.package,
        dev: compiled.dev,
        patternId: pattern.id,
        version,
        index: m.index,
        length: m[0].length,
        anchors,
      });
      kept++;
    }
  }
  return out;
}
