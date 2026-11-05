// Temporary local harness (not committed): prepares a three-basic workspace in a fixed folder.
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { buildLocal } from "../../fingerprints/src/local.js";
import { capture } from "../src/capture/capture.js";
import { detect } from "../src/detect/run.js";
import { OVERLAY_FILE } from "../src/fingerprint/store.js";
import { maps } from "../src/maps/run.js";
import { scaffold } from "../src/scaffold/run.js";
import { unbundle } from "../src/unbundle/run.js";
import { verify } from "../src/verify/run.js";
import { serveFixture } from "./helpers/fixtures.js";

const ROOT = process.env.S2S_DEBUG_DIR as string;
const STAGE = process.env.S2S_DEBUG_STAGE ?? "all";

test.skipIf(!ROOT)(
  "debug",
  async () => {
    const fp = path.join(ROOT, "fp");
    if (!existsSync(path.join(fp, OVERLAY_FILE))) {
      await mkdir(fp, { recursive: true });
      await buildLocal({
        specs: ["three@0.187.0", "gsap@3.13.0"],
        out: path.join(fp, OVERLAY_FILE),
      });
    }
    const captured = path.join(ROOT, "captured");
    if (!existsSync(path.join(captured, "manifest.json"))) {
      const server = await serveFixture("three-basic");
      await capture({
        version: "0.0.0-test",
        quietMs: 300,
        phaseTimeoutMs: 15_000,
        maskDelayMs: 0,
        delayMs: 0,
        viewports: ["desktop"],
        url: server.url,
        outDir: captured,
        onContext: async (c) => {
          await c.route(
            (u) => u.hostname !== "127.0.0.1",
            (r) => r.abort(),
          );
        },
      });
      await server.close();
      await maps({ workspace: captured });
    }
    const ws = path.join(ROOT, "ws");
    if (STAGE === "all" || STAGE === "detect") {
      await rm(ws, { recursive: true, force: true });
      await cp(captured, ws, { recursive: true });
      await detect({ workspace: ws, offline: true, force: true, fingerprints: { dir: fp } });
      await unbundle({ workspace: ws, force: true });
    }
    if (STAGE === "all" || STAGE === "scaffold" || STAGE === "detect") {
      const sc = path.join(ROOT, "sc");
      await rm(sc, { recursive: true, force: true });
      await cp(ws, sc, { recursive: true });
      const r = await scaffold({
        workspace: sc,
        git: false,
        recoverer: { assets: process.env.S2S_DEBUG_ASSETS ?? "proxy" },
      });
      console.log(r.summary, r.build, r.buildOutput ?? "", r.warnings.join(" | "));
      if (process.env.S2S_DEBUG_VERIFY) {
        const v = await verify({ workspace: sc, build: false, quietMs: 300 });
        console.log(
          v.summary,
          JSON.stringify(v.report?.checks.map((c) => c.reasons.concat(c.newConsoleErrors))),
          JSON.stringify(
            v.report?.webgl?.map((w) =>
              w.keyframes.map((k) => [k.keyframe, k.differences.slice(0, 5), k.canvasDiff]),
            ),
          ),
        );
      }
    }
  },
  1_200_000,
);
