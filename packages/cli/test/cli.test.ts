import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type FixtureServer, serveFixture } from "../../core/test/helpers/fixtures.js";
import { tableLines } from "../src/commands/detect.js";
import { type CliIO, runCli } from "../src/main.js";

function io(onLine?: (line: string, interrupt: () => void) => void) {
  const out: string[] = [];
  const err: string[] = [];
  let handler: (() => void) | undefined;
  const interrupt = () => handler?.();
  const cliIO: CliIO = {
    stdout: (line) => out.push(line),
    stderr: (line) => {
      err.push(line);
      onLine?.(line, interrupt);
    },
    onInterrupt: (h) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  };
  return { cliIO, out, err };
}

const FAST = ["--viewports", "desktop", "--quiet-ms", "300", "--phase-timeout", "5000"];

let tmp: string;
let server: FixtureServer;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "s2s-cli-"));
  server = await serveFixture("static");
});
afterAll(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("s2s", () => {
  test("--version prints the version", async () => {
    const { cliIO, out } = io();
    expect(await runCli(["--version"], "1.2.3", cliIO)).toBe(0);
    expect(out).toEqual(["1.2.3"]);
  });

  test("an unknown command exits 1 with a hint", async () => {
    const { cliIO, err } = io();
    expect(await runCli(["bogus"], "0.0.0", cliIO)).toBe(1);
    expect(err.join("\n")).toContain("s2s --help");
  });

  test("bad flag values are usage errors", async () => {
    const { cliIO, err } = io();
    const code = await runCli(["capture", server.url, "--viewports", "tablet"], "0.0.0", cliIO);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--viewports");
  });
});

describe("s2s capture", () => {
  test("--json prints the result and writes a complete workspace", async () => {
    const out = path.join(tmp, "json");
    const { cliIO, out: stdout, err } = io();
    const code = await runCli(
      ["capture", server.url, "--out", out, "--json", ...FAST],
      "0.0.0",
      cliIO,
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const result = JSON.parse(stdout.join("\n")) as { status: string; workspace: string };
    expect(result.status).toBe("complete");
    expect(result.workspace).toBe(path.resolve(out));
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.stages.capture.status).toBe("complete");
  });

  test("progress goes to stderr per phase", async () => {
    const { cliIO, err } = io();
    const code = await runCli(
      ["capture", server.url, "--out", path.join(tmp, "progress"), ...FAST],
      "0.0.0",
      cliIO,
    );
    expect(code).toBe(0);
    const text = err.join("\n");
    expect(text).toMatch(/^\s+load\s+desktop index\s+requests \d+/m);
    expect(text).toMatch(/^\s+interact\s+desktop index/m);
    expect(text).toMatch(
      /Capture complete: requests \d+ · stored .+ · chunks discovered \d+ · maps \d+/,
    );
  });

  test("Ctrl+C marks the capture partial and exits 130", async () => {
    const out = path.join(tmp, "interrupt");
    const { cliIO, err } = io((line, interrupt) => {
      if (/^\s+interact/.test(line)) interrupt();
    });
    const code = await runCli(["capture", server.url, "--out", out, ...FAST], "0.0.0", cliIO);
    expect(code).toBe(130);
    expect(err.join("\n")).toContain("marked partial");
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.stages.capture.status).toBe("partial");
  });

  test("a missing browser gives install instructions", async () => {
    const previous = process.env.S2S_CHROME_PATH;
    process.env.S2S_CHROME_PATH = path.join(tmp, "no-such-chrome.exe");
    try {
      const { cliIO, err } = io();
      const code = await runCli(
        ["capture", server.url, "--out", path.join(tmp, "nobrowser"), ...FAST],
        "0.0.0",
        cliIO,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("npx playwright install chromium");
    } finally {
      if (previous === undefined) delete process.env.S2S_CHROME_PATH;
      else process.env.S2S_CHROME_PATH = previous;
    }
  });
});

describe("s2s maps", () => {
  test("prints a one-line summary, then skips a complete stage", async () => {
    const out = path.join(tmp, "maps");
    expect(await runCli(["capture", server.url, "--out", out, ...FAST], "0.0.0", io().cliIO)).toBe(
      0,
    );
    const first = io();
    expect(await runCli(["maps", out], "0.0.0", first.cliIO)).toBe(0);
    expect(first.err.join("\n")).toMatch(
      /Maps complete: 0 maps, 0 sources recovered, 0% of first-party JS covered/,
    );
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.stages.maps.status).toBe("complete");

    const again = io();
    expect(await runCli(["maps", out, "--json"], "0.0.0", again.cliIO)).toBe(0);
    expect(JSON.parse(again.out.join("\n"))).toMatchObject({ skipped: true, status: "complete" });

    const forced = io();
    expect(await runCli(["maps", out, "--force", "--json"], "0.0.0", forced.cliIO)).toBe(0);
    expect(JSON.parse(forced.out.join("\n"))).toMatchObject({ skipped: false });
  });

  test("a folder without a workspace exits 1 with a hint", async () => {
    const { cliIO, err } = io();
    expect(await runCli(["maps", path.join(tmp, "missing")], "0.0.0", cliIO)).toBe(1);
    expect(err.join("\n")).toContain('Run "s2s capture <url>" first');
  });

  test("--help after a name that is not a command shows the main usage", async () => {
    const { cliIO, out } = io();
    expect(await runCli(["constructor", "--help"], "0.0.0", cliIO)).toBe(0);
    expect(out.join("\n")).toContain("capture");
    expect(out.join("\n")).not.toContain("undefined");
  });

  test("--help shows the maps usage", async () => {
    const { cliIO, out } = io();
    expect(await runCli(["maps", "--help"], "0.0.0", cliIO)).toBe(0);
    expect(out.join("\n")).toContain("--force");
  });
});

describe("s2s detect", () => {
  test("writes package.json offline, skips a complete stage, and explains a package", async () => {
    const out = path.join(tmp, "detect");
    expect(await runCli(["capture", server.url, "--out", out, ...FAST], "0.0.0", io().cliIO)).toBe(
      0,
    );
    expect(await runCli(["maps", out], "0.0.0", io().cliIO)).toBe(0);
    const first = io();
    expect(await runCli(["detect", out, "--offline"], "0.0.0", first.cliIO)).toBe(0);
    expect(first.err.join("\n")).toMatch(/Detect complete: 0 packages: 0 dependencies/);
    expect(first.out).toEqual(["No packages found."]);
    const pkg = JSON.parse(await readFile(path.join(out, "project", "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "127-0-0-1", private: true, dependencies: {} });

    const again = io();
    expect(await runCli(["detect", out, "--offline", "--json"], "0.0.0", again.cliIO)).toBe(0);
    expect(JSON.parse(again.out.join("\n"))).toMatchObject({ skipped: true, status: "complete" });

    const explained = io();
    expect(
      await runCli(["detect", out, "--offline", "--explain", "react"], "0.0.0", explained.cliIO),
    ).toBe(1);
    expect(explained.out).toEqual(["No evidence for react in this workspace."]);
  });

  test("bad flag values are usage errors", async () => {
    for (const args of [
      ["--pm", "pip"],
      ["--min-confidence", "certain"],
      ["--ranges", "tilde"],
    ]) {
      const { cliIO, err } = io();
      expect(await runCli(["detect", tmp, ...args], "0.0.0", cliIO)).toBe(2);
      expect(err.join("\n")).toContain(args[0]);
    }
  });

  test("the summary table lines up package, version, confidence, status and signals", () => {
    expect(
      tableLines([
        {
          name: "react",
          version: "19.3.1",
          confidence: "high",
          status: "dependency",
          signals: ["cdn-url"],
        },
        { name: "scheduler", version: null, confidence: "low", status: "transitive", signals: [] },
      ]),
    ).toEqual([
      "package    version  confidence  status      signals",
      "react      19.3.1   high        dependency  cdn-url",
      "scheduler  -        low         transitive  implied",
    ]);
  });

  test("--help shows the detect usage", async () => {
    const { cliIO, out } = io();
    expect(await runCli(["detect", "--help"], "0.0.0", cliIO)).toBe(0);
    expect(out.join("\n")).toContain("--explain");
  });
});

describe("s2s unbundle", () => {
  test("unbundles the static fixture, skips a complete stage, rebuilds with --force", async () => {
    const out = path.join(tmp, "unbundle");
    expect(await runCli(["capture", server.url, "--out", out, ...FAST], "0.0.0", io().cliIO)).toBe(
      0,
    );
    expect(await runCli(["maps", out], "0.0.0", io().cliIO)).toBe(0);
    expect(await runCli(["detect", out, "--offline"], "0.0.0", io().cliIO)).toBe(0);
    const first = io();
    expect(await runCli(["unbundle", out], "0.0.0", first.cliIO)).toBe(0);
    expect(first.err.join("\n")).toMatch(
      /Unbundle complete: \w+ · \d+ modules? · \d+% vendor dropped · \d+ groups?/,
    );
    const modules = JSON.parse(await readFile(path.join(out, "analysis", "modules.json"), "utf8"));
    expect(modules.modules.length).toBeGreaterThan(0);

    const again = io();
    expect(await runCli(["unbundle", out, "--json"], "0.0.0", again.cliIO)).toBe(0);
    expect(JSON.parse(again.out.join("\n"))).toMatchObject({ skipped: true, status: "complete" });

    const forced = io();
    expect(await runCli(["unbundle", out, "--force", "--json"], "0.0.0", forced.cliIO)).toBe(0);
    expect(JSON.parse(forced.out.join("\n"))).toMatchObject({ skipped: false, status: "complete" });
  });

  test("bad flag values are usage errors", async () => {
    for (const args of [
      ["--skip", "minify"],
      ["--max-group-kb", "-3"],
    ]) {
      const { cliIO, err } = io();
      expect(await runCli(["unbundle", tmp, ...args], "0.0.0", cliIO)).toBe(2);
      expect(err.join("\n")).toContain(args[0]);
    }
  });

  test("a folder that is not a workspace fails with a hint", async () => {
    const { cliIO, err } = io();
    expect(await runCli(["unbundle", path.join(tmp, "missing")], "0.0.0", cliIO)).toBe(1);
    expect(err.join("\n")).toContain("s2s capture");
  });

  test("--help shows the unbundle usage", async () => {
    const { cliIO, out } = io();
    expect(await runCli(["unbundle", "--help"], "0.0.0", cliIO)).toBe(0);
    expect(out.join("\n")).toContain("--keep-vendor");
  });
});
