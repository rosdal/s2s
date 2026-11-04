import type { PageCheck, VerifyResult } from "@rosdal/s2s-core";
import { describe, expect, test } from "vitest";
import { verifyReportLines } from "../src/commands/verify.js";
import { colorDepth, columns, createTheme, StageList, visibleLength } from "../src/ui.js";

const plain = createTheme(1);

describe("theme", () => {
  test("depth 1 is plain text, deeper depths add escapes that do not count toward width", () => {
    expect(plain.accent("ok")).toBe("ok");
    const colored = createTheme(24).accent("ok");
    expect(colored).not.toBe("ok");
    expect(visibleLength(colored)).toBe(2);
  });

  test("NO_COLOR and FORCE_COLOR decide the depth", () => {
    const tty = { isTTY: true, getColorDepth: () => 24 };
    expect(colorDepth(tty, {})).toBe(24);
    expect(colorDepth(tty, { FORCE_COLOR: "0" })).toBe(1);
    expect(colorDepth({ isTTY: false }, {})).toBe(1);
    expect(colorDepth({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(4);
  });

  test("columns pad by visible width", () => {
    const t = createTheme(24);
    const lines = columns([
      [t.dim("a"), "x"],
      ["long", "y"],
    ]);
    expect(lines.map(visibleLength)).toEqual([7, 7]);
  });
});

describe("StageList", () => {
  test("off a terminal, each event is one line", () => {
    const lines: string[] = [];
    const list = new StageList({ line: (l) => lines.push(l), columns: 100, theme: plain }, [
      "capture",
      "maps",
    ]);
    list.show();
    const capture = list.start("capture");
    capture.detail("loading", "load desktop index");
    capture.warn("slow response");
    capture.done("7 requests");
    list.start("maps").failed("no maps", ["details here"]);
    list.close();
    expect(lines[0]).toBe("  load desktop index");
    expect(lines[1]).toMatch(/^✓ capture\s+7 requests {2}\d+\.\ds$/);
    expect(lines[2]).toContain("! slow response");
    expect(lines[3]).toMatch(/^✗ maps\s+no maps/);
    expect(list.failure).toEqual({ name: "maps", summary: "no maps", details: ["details here"] });
  });

  test("on a terminal, it redraws in place and leaves the last frame", () => {
    let screen = "";
    const list = new StageList(
      { line: () => {}, write: (c) => (screen += c), columns: 80, theme: plain },
      ["capture"],
    );
    list.footer = "ctrl+c stops";
    list.show();
    list.start("capture").done("done");
    list.close();
    expect(screen).toContain("\x1b[");
    const last = screen.split(new RegExp(`${"\u001b"}\\[\\d+F${"\u001b"}\\[0J`)).at(-1) ?? "";
    expect(last).toMatch(/^✓ capture\s+done\s+\d+\.\ds\n$/);
  });
});

describe("verify report", () => {
  const check = (over: Partial<PageCheck>): PageCheck => ({
    page: "index",
    viewport: "desktop",
    url: "http://x/",
    pass: true,
    reasons: [],
    pixelDiff: 0.001,
    baseline: "capture",
    worstRegions: [],
    diffImage: null,
    masked: 0,
    domSimilarity: 0.99,
    domMissing: [],
    domExtra: [],
    newConsoleErrors: [],
    knownConsoleErrors: 0,
    failedRequests: [],
    blockedRequests: [],
    replayed: 7,
    ...over,
  });

  test("a table row per check, a block per regression, and the count", () => {
    const result = {
      workspace: "/w",
      exitCode: 1,
      summary: "1 of 2 checks regressed",
      report: {
        at: "",
        status: "regression",
        thresholds: {
          maxPixelDiff: 0.02,
          minDomSimilarity: 0.95,
          maxNewConsoleErrors: 0,
          maxFailedRequests: 0,
        },
        baselineUpdated: false,
        sinceLastPass: null,
        checks: [
          check({}),
          check({
            viewport: "mobile",
            pass: false,
            pixelDiff: 0.048,
            reasons: ["pixels differ by 4.8% (limit 2.0%)"],
            worstRegions: [{ x: 0, y: 132, width: 390, height: 44 }],
            diffImage: "verify/diffs/index/mobile.png",
          }),
        ],
      },
    } as unknown as VerifyResult;
    const text = verifyReportLines(plain, result).join("\n");
    expect(text).toMatch(/index\s+mobile\s+\[#+\]\s+4\.8%\s+0\.99\s+0\s+✗ pixel/);
    expect(text).toContain("worst region 390×44 at y 132");
    expect(text).toContain("diff  verify/diffs/index/mobile.png");
    expect(text).toContain("✗ 1/2 passed  exit 1 · report verify/report.md");
  });
});
