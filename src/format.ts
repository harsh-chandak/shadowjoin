import type { Report } from "./types.js";

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
const lpad = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;

/** Render a report as plain text for a terminal. */
export function formatReport(report: Report): string {
  const out: string[] = [];
  const n = (v: number) => v.toLocaleString("en-US");

  out.push("");
  out.push(`  left rows ${n(report.leftRows)}   right rows ${n(report.rightRows)}`);
  out.push("");
  out.push(`  exact join matches        ${lpad(n(report.exactMatches), 9)}   ${report.exactMatchRate}%`);
  out.push(`  recovered by shadow join  ${lpad(n(report.recovered), 9)}   ${report.lowerBoundLossPct}%`);
  out.push(`  still unexplained         ${lpad(n(report.unexplained), 9)}`);
  out.push(`  reachable match rate      ${lpad(report.reachableMatchRate + "%", 9)}`);
  out.push("");
  out.push(`  LOWER BOUND ON LOST MATCHES: ${report.lowerBoundLossPct}% of left rows`);
  if (report.precision !== null) {
    out.push(`  verified against ground truth: ${n(report.verified)} correct, ${n(report.contradicted)} wrong, ${n(report.ambiguous)} ambiguous  (precision ${report.precision}%)`);
  }
  out.push("");

  if (report.byRule.length) {
    out.push(`  ${pad("rule", 54)}${lpad("alone", 8)}${lpad("ok", 7)}${lpad("wrong", 7)}`);
    out.push("  " + "-".repeat(76));
    for (const r of report.byRule) {
      out.push(`  ${pad(r.label, 54)}${lpad(n(r.recovered), 8)}${lpad(n(r.verified), 7)}${lpad(n(r.contradicted), 7)}`);
    }
    out.push("");
  }

  if (report.stack.length) {
    out.push("  rules worth adopting, in order (greedy by marginal recovery):");
    out.push(`  ${pad("", 4)}${pad("rule", 54)}${lpad("+rows", 9)}${lpad("running", 9)}`);
    out.push("  " + "-".repeat(76));
    report.stack.forEach((s2, i) => {
      out.push(`  ${pad(String(i + 1) + ".", 4)}${pad(s2.label, 54)}${lpad("+" + n(s2.marginal), 9)}${lpad(n(s2.cumulative), 9)}`);
    });
    out.push("");
  }

  if (report.samplePairs.length) {
    out.push("  sample recoveries (verify these by hand before acting):");
    const mark: Record<string, string> = { verified: "ok ", contradicted: "BAD", ambiguous: "?? ", unverifiable: "   " };
    for (const s of report.samplePairs.slice(0, 12)) {
      const multi = s.candidates > 1 ? `  [${s.candidates} candidates]` : "";
      out.push(`    ${mark[s.verification]} ${s.leftKey}`);
      out.push(`         -> ${s.rightKey}   (${s.rule})${multi}`);
    }
    out.push("");
  }

  for (const w of report.warnings) out.push(`  ! ${w}`);
  if (report.warnings.length) out.push("");
  return out.join("\n");
}
