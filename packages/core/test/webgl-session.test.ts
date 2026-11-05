import { createHash } from "node:crypto";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  deterministicContext,
  launchDeterministicBrowser,
  loadDeterministic,
  walkKeyframes,
} from "../src/webgl/session.js";
import { type FixtureServer, serveFixture } from "./helpers/fixtures.js";

let server: FixtureServer;
let browser: Browser;
beforeAll(async () => {
  server = await serveFixture("three-basic");
  browser = await launchDeterministicBrowser({});
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function walk() {
  const context = await deterministicContext(browser, "desktop", "s2s-test");
  const page = await context.newPage();
  try {
    const loaded = await loadDeterministic(page, server.url, { quietMs: 300 });
    const out: { id: string; snap: string; shot: string; clockMs: number }[] = [];
    await walkKeyframes(page, "auto", { baseMs: loaded.baseMs }, async (k) => {
      out.push({
        id: k.keyframe.id,
        snap: JSON.stringify(k.snapshot),
        shot: createHash("sha256").update(k.screenshot).digest("hex"),
        clockMs: k.clockMs,
      });
    });
    return { loaded, out };
  } finally {
    await context.close();
  }
}

describe("deterministic WebGL session", () => {
  test("two walks of three-basic give identical snapshots and screenshots", async () => {
    const a = await walk();
    const b = await walk();
    expect(a.out.map((k) => k.id)).toEqual(["t0", "t1000", "t3000", "s1", "s2", "s3"]);
    const first = JSON.parse(a.out[0]?.snap ?? "null");
    expect(first.revision).toBe("187");
    const names = first.scenes[0].nodes.map((n: { path: string }) => n.path);
    expect(names).toContain("World/MainCamera");
    expect(names).toContain("World/Hero/Rig/Body");
    expect(a.loaded.baseMs).toBe(b.loaded.baseMs);
    for (const [i, k] of a.out.entries()) {
      expect(k.snap, k.id).toBe(b.out[i]?.snap);
      expect(k.shot, k.id).toBe(b.out[i]?.shot);
    }
    // The camera moves with the scroll timeline.
    const cam = (s: string) =>
      JSON.parse(s).scenes[0].nodes.find((n: { path: string }) => n.path === "World/MainCamera")
        .position;
    expect(cam(a.out[3]?.snap ?? "")).not.toEqual(cam(a.out[0]?.snap ?? ""));
  });
});
