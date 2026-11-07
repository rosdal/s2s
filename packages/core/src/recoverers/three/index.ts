import { recoverShaders } from "../../webgl/shaders.js";
import { type FrameworkFile, RECOVERER_API_VERSION, type Recoverer } from "../api.js";
import { detectThree } from "./detect.js";
import { threeScaffold } from "./scaffold.js";

/** three.js sites, vanilla or React Three Fiber. */
export const threeRecoverer: Recoverer = {
  name: "three",
  apiVersion: RECOVERER_API_VERSION,
  detect: detectThree,
  captureHints(ctx) {
    const webgl = ctx.probes.some((p) => {
      const frameworks = (p.frameworks ?? {}) as Record<string, unknown>;
      const summary = frameworks.webgl as { contexts?: Record<string, number> } | undefined;
      return (
        Boolean(frameworks.three) ||
        Boolean(
          summary && ((summary.contexts?.webgl ?? 0) > 0 || (summary.contexts?.webgl2 ?? 0) > 0),
        )
      );
    });
    return webgl ? { webgl: true } : undefined;
  },
  async unbundleHints(ctx) {
    await recoverShaders(ctx.paths, ctx.warn);
  },
  scaffold: threeScaffold,
  agentNotes: threeAgentNotes,
  verifyHints() {
    return { webgl: true };
  },
};

/** The three.js section of `AGENTS.md`. */
export function threeAgentNotes(framework: FrameworkFile): string[] {
  const r3f = framework.flavour === "r3f";
  const mode = String(framework.details.assets ?? "proxy");
  const lines = [
    `The site renders with three.js${framework.version ? ` ${framework.version}` : ""}${r3f ? " through React Three Fiber" : ""} (see \`analysis/framework.json\`). Verify compares the scene graph at frozen keyframes, not just pixels: \`raw/webgl/\` holds the captured snapshots and screenshots.`,
    "",
    "- Keep every scene node's name and its place in the hierarchy. Verify matches nodes by their path (`World/Hero/Body`), so a rename or a new wrapper group is a regression.",
    `- Target layout: \`src/scene/\` (renderer, scene, cameras, lights, loop), ${r3f ? "`src/components/` (one R3F component per object)" : "`src/objects/` (one module per object)"}, \`src/materials/\`, \`src/shaders/\` (GLSL, imported with \`?raw\`), \`src/timeline/\` and \`src/interaction/\`. Each folder's README says what goes there.`,
    "- Keep the scroll and time choreography in one module under `src/timeline/`; keyframes are taken at fixed scroll steps and clock times, so timing changes show up in verify.",
    "- `src/scene/graph.json` is the captured hierarchy; use it to name things, never import it.",
    "- Models, textures and sounds live in `project/public/` at the paths the code loads them from. `ASSETS.md` says which node uses each one; read it before touching a model.",
  ];
  if (mode === "proxy")
    lines.push(
      "- Assets are generated proxies (boxes, spheres and cylinders with the original names and bounds). Never copy the site's original models, textures or audio back into the project.",
    );
  else
    lines.push(
      `- Assets are in ${mode} mode: they are the site's own art (simplified or as captured) and for local study only. Don't publish, share or ship them.`,
    );
  if (framework.unsupported.length > 0)
    lines.push(`- Not recoverable: ${framework.unsupported.join(", ")}. Leave that code as it is.`);
  return lines;
}
