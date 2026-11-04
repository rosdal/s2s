import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CaptureOptions, capture } from "../src/capture/capture.js";
import { readManifest } from "../src/capture/manifest.js";
import { detect } from "../src/detect/run.js";
import { maps } from "../src/maps/run.js";
import { scaffold } from "../src/scaffold/run.js";
import { unbundle } from "../src/unbundle/run.js";
import { decodePng, encodePng, type Rect } from "../src/verify/image.js";
import { verify } from "../src/verify/run.js";
import { type FixtureName, serveFixture } from "./helpers/fixtures.js";

let tmp: string;
let pnpmVersion: string | undefined;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-stage5-"));
  // The pnpm a user would have; the repo's own pin would apply inside the repo only.
  pnpmVersion = execSync("pnpm --version", { cwd: tmp, encoding: "utf8" }).trim();
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const FAST = {
  version: "0.0.0-test",
  quietMs: 300,
  phaseTimeoutMs: 5_000,
  maskDelayMs: 0,
  delayMs: 0,
  viewports: ["desktop"],
} satisfies Partial<CaptureOptions>;

async function offline(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort("internetdisconnected"),
  );
}

const prepared = new Map<string, Promise<string>>();

/** Stages 1 to 4 once per fixture; callers copy the result before changing it. */
function unbundled(name: FixtureName, capture_: Partial<CaptureOptions> = {}): Promise<string> {
  const key = `${name}:${JSON.stringify(capture_)}`;
  let known = prepared.get(key);
  if (!known) {
    known = (async () => {
      const server = await serveFixture(name);
      const outDir = path.join(tmp, "prepared", `${name}-${prepared.size}`);
      try {
        const result = await capture({
          ...FAST,
          onContext: offline,
          ...capture_,
          url: server.url,
          outDir,
        });
        expect(result.status).toBe("complete");
      } finally {
        await server.close();
      }
      expect((await maps({ workspace: outDir })).status).toBe("complete");
      const detected = await detect({
        workspace: outDir,
        offline: true,
        managerVersion: (pm) => (pm === "pnpm" ? pnpmVersion : undefined),
      });
      expect(detected.status).toBe("complete");
      expect((await unbundle({ workspace: outDir })).status).toBe("complete");
      return outDir;
    })();
    prepared.set(key, known);
  }
  return known;
}

let copies = 0;
async function copyOf(dir: string): Promise<string> {
  const out = path.join(tmp, "runs", `${path.basename(dir)}-${copies++}`);
  await cp(dir, out, { recursive: true });
  return out;
}

const read = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const AGENT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "PROMPT.md",
  "PROGRESS.md",
  ".claude/commands/s2s.md",
  ".claude/settings.json",
];

describe("agent files", () => {
  const fixtures: FixtureName[] = [
    "webpack-react",
    "vite-react",
    "esbuild-app",
    "vue-app",
    "css-modules",
    "sourcemaps",
  ];

  test.each(fixtures)("%s: byte-stable and built only from analysis facts", async (name) => {
    const source = await unbundled(name);
    const a = await copyOf(source);
    const b = await copyOf(source);
    for (const dir of [a, b]) {
      const result = await scaffold({ workspace: dir, install: false, build: false, git: false });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("complete");
    }
    for (const file of AGENT_FILES) expect(await read(a, file)).toBe(await read(b, file));
    expect(await read(a, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(await read(a, ".claude/commands/s2s.md")).toContain((await read(a, "PROMPT.md")).trim());

    // Every file a generated file points the agent at exists.
    const agents = await read(a, "AGENTS.md");
    const progress = await read(a, "PROGRESS.md");
    for (const ref of `${agents}\n${progress}`.matchAll(/`((?:analysis|raw|project)\/[^`*<]+)`/g)) {
      const file = (ref[1] as string).replace(/\/$/, "");
      // The agent writes the project README as its last step.
      if (file === "project/README.md") continue;
      expect(existsSync(path.join(a, file)), `${file} exists`).toBe(true);
    }
    // Package facts come from analysis/packages.json and nowhere else.
    const packages = JSON.parse(await read(a, "analysis/packages.json")) as {
      packages: { name: string; status: string }[];
    };
    const accepted = packages.packages
      .filter((p) => p.status === "dependency" || p.status === "devDependency")
      .map((p) => p.name);
    const listed = [
      ...(agents.split("## Packages")[1]?.split("To review")[0] ?? "").matchAll(/^- `(@?[^@`]+)/gm),
    ].map((m) => m[1]);
    expect(listed.sort()).toEqual(accepted.sort());

    // Every module is in the project and listed in exactly one group.
    const modules = JSON.parse(await read(a, "analysis/modules.json")) as {
      modules: { id: string; kind: string }[];
    };
    const mapped = JSON.parse(await read(a, "analysis/scaffold.json")) as {
      files: { module: string; file: string }[];
    };
    for (const m of modules.modules) {
      const entry = mapped.files.find((f) => f.module === m.id);
      expect(entry, m.id).toBeDefined();
      expect(existsSync(path.join(a, "project", entry?.file ?? "")), entry?.file).toBe(true);
      if (m.kind !== "style")
        expect(progress.split(`\`project/${entry?.file}\``).length - 1, m.id).toBe(1);
    }
  });
});

describe("baseline", () => {
  const fixtures: FixtureName[] = ["webpack-react", "vite-react", "esbuild-app", "vue-app"];

  test.each(fixtures)("%s: the untouched scaffold builds and verify passes", async (name) => {
    const dir = await copyOf(await unbundled(name));
    const result = await scaffold({ workspace: dir });
    expect(result.error).toBeUndefined();
    expect(result.buildOutput).toBeUndefined();
    expect(result.build).toBe("passed");
    expect(git(dir, "log", "--format=%s")).toBe("s2s scaffold\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(dir, "project", "node_modules"))).toBe(true);
    expect(git(dir, "check-ignore", "raw/bodies/x")).not.toBe("");

    const checked = await verify({ workspace: dir, quietMs: 300 });
    expect(checked.error).toBeUndefined();
    expect(checked.report?.checks.flatMap((c) => c.reasons)).toEqual([]);
    expect(checked.exitCode).toBe(0);
    const report = JSON.parse(await read(dir, "verify/report.json")) as { status: string };
    expect(report.status).toBe("pass");
    expect(await read(dir, "verify/report.md")).toContain("# Verify: PASS");
    expect((await read(dir, "verify/history.jsonl")).trim().split("\n")).toHaveLength(1);
  });

  test("a rerun of a complete scaffold is a no-op", async () => {
    const dir = await copyOf(await unbundled("esbuild-app"));
    await scaffold({ workspace: dir, install: false, build: false, git: false });
    const again = await scaffold({ workspace: dir, install: false, build: false, git: false });
    expect(again.skipped).toBe(true);
    const manifest = await readManifest(path.join(dir, "manifest.json"));
    expect(manifest?.stages.scaffold.status).toBe("complete");
  });
});

describe("verify catches breakage", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await copyOf(await unbundled("vite-react"));
    const result = await scaffold({ workspace: dir });
    expect(result.build).toBe("passed");
    expect((await verify({ workspace: dir, quietMs: 300 })).exitCode).toBe(0);
  });
  const reset = () => git(dir, "checkout", "--", "project");

  test("a CSS change fails on pixels and names the region", async () => {
    await appendFile(
      path.join(dir, "project/src/_recovered/styles/index.css"),
      "\nh1 { margin-top: 240px; color: #e0f; }\n",
    );
    const result = await verify({ workspace: dir, quietMs: 300 });
    reset();
    expect(result.exitCode).toBe(1);
    const check = result.report?.checks[0];
    expect(check?.reasons.join()).toMatch(/pixels differ/);
    expect(check?.worstRegions.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, check?.diffImage ?? "none"))).toBe(true);
    const md = await read(dir, "verify/report.md");
    expect(md).toContain("Worst regions");
    expect(md).toContain("Changes since the last passing run");
  });

  test("a thrown error fails as a new console error", async () => {
    await appendFile(
      path.join(dir, "project/src/main.ts"),
      'setTimeout(() => {\n  throw new Error("s2s injected failure");\n});\n',
    );
    const result = await verify({ workspace: dir, quietMs: 300 });
    reset();
    expect(result.exitCode).toBe(1);
    expect(result.report?.checks[0]?.newConsoleErrors.join()).toContain("s2s injected failure");
  });

  test("a missing asset fails as a failed request", async () => {
    const html = path.join(dir, "project/index.html");
    const text = await readFile(html, "utf8");
    await writeFile(
      html,
      text.replace("<body>", '<body>\n    <img src="/missing-logo.png" alt="">'),
    );
    const result = await verify({ workspace: dir, quietMs: 300 });
    reset();
    expect(result.exitCode).toBe(1);
    expect(result.report?.checks[0]?.failedRequests).toContainEqual({
      url: "/missing-logo.png",
      status: 404,
    });
  });

  test("a build error exits 2 with the build output", async () => {
    await appendFile(path.join(dir, "project/src/main.ts"), "\nconst = ;\n");
    const result = await verify({ workspace: dir, quietMs: 300 });
    reset();
    expect(result.exitCode).toBe(2);
    expect(result.buildOutput).toBeTruthy();
    expect(result.buildOutput?.split("\n").length).toBeLessThanOrEqual(50);
  });

  test("verify itself failing exits 3", async () => {
    const result = await verify({ workspace: path.join(tmp, "nowhere") });
    expect(result.exitCode).toBe(3);
    const missing = await verify({ workspace: dir, pages: ["no-such-page"], build: false });
    expect(missing.exitCode).toBe(3);
    expect(missing.error).toContain("no-such-page");
  });

  test("--update-baseline accepts the current screenshots", async () => {
    await appendFile(
      path.join(dir, "project/src/_recovered/styles/index.css"),
      "\nh1 { margin-top: 240px; }\n",
    );
    const accepted = await verify({ workspace: dir, quietMs: 300, updateBaseline: true });
    expect(accepted.exitCode).toBe(0);
    expect(existsSync(path.join(dir, "verify/baseline/index/desktop.png"))).toBe(true);
    expect((await verify({ workspace: dir, quietMs: 300 })).exitCode).toBe(0);
    reset();
    await rm(path.join(dir, "verify/baseline"), { recursive: true, force: true });
  });
});

describe("dynamic mask", () => {
  test("a live clock and an autoplay carousel don't fail verify", async () => {
    const dir = await copyOf(await unbundled("dynamic", { maskDelayMs: 1_000 }));
    const mask = JSON.parse(await read(dir, "raw/screenshots/index/desktop.mask.json")) as Rect[];
    // The carousel spans the page width and is 480 px tall.
    expect(mask.some((r) => r.width >= 1_000 && r.height >= 400)).toBe(true);

    expect((await scaffold({ workspace: dir })).build).toBe("passed");
    const masked = await verify({ workspace: dir, quietMs: 300 });
    expect(masked.report?.checks[0]?.reasons).toEqual([]);
    expect(masked.exitCode).toBe(0);

    // Make the masked area of the baseline something no slide ever shows. Verify still passes with
    // the mask, and fails without it: the mask is what keeps the page green.
    const shotFile = path.join(dir, "raw/screenshots/index/desktop.png");
    const shot = decodePng(await readFile(shotFile));
    const carousel = mask.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    for (let y = carousel.y; y < Math.min(shot.height, carousel.y + carousel.height); y++)
      for (let x = carousel.x; x < Math.min(shot.width, carousel.x + carousel.width); x++)
        shot.data.set([0, 0, 0, 255], (y * shot.width + x) * 4);
    await writeFile(shotFile, encodePng(shot));
    expect((await verify({ workspace: dir, quietMs: 300, build: false })).exitCode).toBe(0);
    await rm(path.join(dir, "raw/screenshots/index/desktop.mask.json"));
    const unmasked = await verify({ workspace: dir, quietMs: 300, build: false });
    expect(unmasked.exitCode).toBe(1);
  });
});

describe("API replay", () => {
  test("the rebuilt site gets captured responses; unknown requests are blocked and listed", async () => {
    const dir = await copyOf(await unbundled("api-app"));
    expect((await scaffold({ workspace: dir })).build).toBe("passed");
    const result = await verify({ workspace: dir, quietMs: 300 });
    const check = result.report?.checks[0];
    expect(check?.reasons).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(check?.replayed).toBeGreaterThan(0);
    expect(check?.blockedRequests).toContain("https://tracker.example.invalid/ping");
    expect(await read(dir, "verify/report.md")).toContain("tracker.example.invalid");
    const shot = await readFile(path.join(dir, "verify/current/index/desktop.png"));
    expect(shot.length).toBeGreaterThan(0);
  });
});
