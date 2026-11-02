import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type FixtureServer, serveFixture } from "../../core/test/helpers/fixtures.js";
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
