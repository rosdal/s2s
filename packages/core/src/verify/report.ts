import type { VerifyReport } from "./run.js";

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(2)}%`);

/** `verify/report.md`: short, written for the agent that has to act on it. */
export function renderReportMd(report: VerifyReport): string {
  const failed = report.checks.filter((c) => !c.pass);
  const t = report.thresholds;
  const out: string[] = [
    `# Verify: ${report.status === "pass" ? "PASS" : `FAIL (${failed.length} of ${report.checks.length} checks)`}`,
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
