import type { VerifyReport } from "./run.js";

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(2)}%`);

/** `verify/report.md`: short, written for the agent that has to act on it. */
export function renderReportMd(report: VerifyReport): string {
  const failed = report.checks.filter((c) => !c.pass);
  const t = report.thresholds;
  const all = report.checks.length + (report.webgl?.length ?? 0);
  const failing = failed.length + (report.webgl ?? []).filter((w) => !w.pass).length;
  const out: string[] = [
    `# Verify: ${report.status === "pass" ? "PASS" : `FAIL (${failing} of ${all} checks)`}`,
    "",
    `Limits: pixels ≤ ${pct(t.maxPixelDiff)}, DOM ≥ ${t.minDomSimilarity}, new console errors ≤ ${t.maxNewConsoleErrors}, failed requests ≤ ${t.maxFailedRequests}.`,
  ];
  if (report.baselineUpdated)
    out.push("", "The baseline was updated to these screenshots (`--update-baseline`).");
  out.push(
    "",
    "| Page | Viewport | Pixels | DOM | New errors | Failed requests | Result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.checks.map(
      (c) =>
        `| ${c.page} | ${c.viewport} | ${pct(c.pixelDiff)} | ${c.domSimilarity.toFixed(3)}${c.domBaseline === "viewport" ? "" : "*"} | ${c.newConsoleErrors.length} | ${c.failedRequests.length} | ${c.pass ? "pass" : "FAIL"} |`,
    ),
  );
  if (report.checks.some((c) => c.domBaseline !== "viewport"))
    out.push(
      "",
      "\\* The capture kept no DOM for this viewport (it predates per-viewport DOMs), so the DOM is compared with the primary viewport's and does not fail the check. Recapture to check it.",
    );
  if (report.webgl && report.webgl.length > 0) {
    out.push(
      "",
      "## WebGL scenes",
      "",
      "The keyframe walk replayed on the rebuilt site (frozen clock, seeded randomness, software rendering), with each scene snapshot compared to `raw/webgl/`: hierarchy and names exactly, positions within 1% of the scene, rotations within 1°, camera FOV exactly.",
      "",
      "| Page | Viewport | Assets | Keyframes | Canvas limit | Result |",
      "| --- | --- | --- | --- | --- | --- |",
      ...report.webgl.map(
        (w) =>
          `| ${w.page} | ${w.viewport} | ${w.mode} | ${w.keyframes.filter((k) => k.pass).length} of ${w.keyframes.length} match | ${w.canvasLimit === null ? "not compared" : pct(w.canvasLimit)} | ${w.pass ? "pass" : "FAIL"} |`,
      ),
    );
    for (const w of report.webgl.filter((x) => !x.pass)) {
      out.push("", `### ${w.page} · ${w.viewport} (WebGL)`, "");
      for (const reason of w.reasons) out.push(`- ${reason}`);
      for (const note of w.notes ?? []) out.push(`- Note: ${note}`);
      for (const k of w.keyframes.filter((x) => !x.pass)) {
        out.push(`- \`${k.keyframe}\`:`);
        for (const d of k.differences.slice(0, 12)) out.push(`  - ${d}`);
        if (k.diffImage) out.push(`  - Diff image: \`${k.diffImage}\``);
      }
    }
  }
  for (const c of failed) {
    out.push("", `## ${c.page} · ${c.viewport}`, "");
    for (const reason of c.reasons) out.push(`- ${reason}`);
    if (c.pixelDiff !== null && c.pixelDiff > t.maxPixelDiff) {
      const regions = c.worstRegions
        .map((r) => `${r.width}×${r.height} at (${r.x}, ${r.y})`)
        .join("; ");
      if (regions) out.push(`- Worst regions (screenshot pixels): ${regions}`);
      if (c.diffImage) out.push(`- Diff image: \`${c.diffImage}\` (differences in red)`);
    }
    if (c.domBaseline === "viewport" && c.domSimilarity < t.minDomSimilarity) {
      if (c.domMissing.length > 0) out.push(`- Elements missing: ${c.domMissing.join(", ")}`);
      if (c.domExtra.length > 0)
        out.push(`- Elements not in the capture: ${c.domExtra.join(", ")}`);
    }
    for (const e of c.newConsoleErrors.slice(0, 5)) out.push(`- Console error: \`${oneLine(e)}\``);
    for (const r of c.failedRequests.slice(0, 10))
      out.push(`- Failed request: ${r.status} ${r.url}`);
  }
  const blocked = [...new Set(report.checks.flatMap((c) => c.blockedRequests))].sort();
  if (blocked.length > 0) {
    out.push(
      "",
      "## Blocked requests",
      "",
      "Requests to URLs the capture has no response for. They are blocked and don't fail verify; code that needs them won't work under verify either.",
      "",
      ...blocked.slice(0, 20).map((u) => `- ${u}`),
    );
    if (blocked.length > 20)
      out.push(`- …and ${blocked.length - 20} more (see \`verify/report.json\`)`);
  }
  if (report.sinceLastPass && report.sinceLastPass.changes.length > 0) {
    out.push("", `## Changes since the last passing run (${report.sinceLastPass.at})`, "");
    for (const d of report.sinceLastPass.changes)
      out.push(
        `- ${d.page} · ${d.viewport}: pixels ${pct(d.pixelDiff[0])} → ${pct(d.pixelDiff[1])}, DOM ${d.domSimilarity[0].toFixed(3)} → ${d.domSimilarity[1].toFixed(3)}`,
      );
  }
  return `${out.join("\n")}\n`;
}

const oneLine = (text: string) => text.split("\n")[0]?.slice(0, 200).replaceAll("`", "'") ?? "";
