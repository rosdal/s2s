import { recoverShaders } from "../../webgl/shaders.js";
import { RECOVERER_API_VERSION, type Recoverer } from "../api.js";
import { detectThree } from "./detect.js";

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
  verifyHints() {
    return { webgl: true };
  },
};
