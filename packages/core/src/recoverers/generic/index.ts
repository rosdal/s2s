import { RECOVERER_API_VERSION, type Recoverer } from "../api.js";

/** Today's Vite SPA scaffold: chosen when no other recoverer is confident. */
export const genericRecoverer: Recoverer = {
  name: "generic",
  apiVersion: RECOVERER_API_VERSION,
  async detect() {
    return { confidence: 0.1, evidence: ["fallback"] };
  },
};
