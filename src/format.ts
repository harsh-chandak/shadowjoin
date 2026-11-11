import type { PartialPair, Report } from "./types.js";

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
const lpad = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;

/** Render a report as plain text for a terminal. */
export function formatReport(report: Report): string {
  const out: string[] = [];
  const n = (v: number) => v.toLocaleString("en-US");

  out.push("");
  out.push(`  left rows ${n(report.leftRows)}   right rows ${n(report.rightRows)}`);
  if (report.keyComponents) out.push(`  join key   ${report.keyComponents.join(" + ")}`);
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

  if (report.agreement?.length) {
    const missed = report.leftRows - report.exactMatches;
    // Ground truth turns a partial bucket into a finding rather than a
    // curiosity, so show those columns only when there is truth to show.
    const truth = report.agreement.some((b) => b.verified + b.contradicted + b.ambiguous > 0);
    out.push(`  which key components agree, among the ${n(missed)} row(s) the exact join missed:`);
    out.push(`  ${pad("", 4)}${pad("components", 42)}${lpad("rows", 8)}${lpad("cands", 8)}${truth ? lpad("ok", 8) + lpad("wrong", 8) : ""}`);
    out.push("  " + "-".repeat(76));
    for (const b of report.agreement) {
      const label = b.components.length === 0
        ? "(nothing agrees)"
        : b.labels.join(" + ") + (b.full ? "  (every component)" : "");
      out.push(
        `  ${pad(b.full ? "=" : " ", 4)}${pad(label, 42)}${lpad(n(b.leftRows), 8)}` +
          `${lpad(b.maxCandidates === 0 ? "" : n(b.maxCandidates), 8)}` +
          (truth ? `${lpad(n(b.verified), 8)}${lpad(n(b.contradicted), 8)}` : ""),
      );
    }
    out.push('    Only "=" is counted in the floor. The rest agree on part of the key: a');
    out.push("    dirty column, or a different record — never counted, always worth reading.");
    out.push('    "cands" is the most right rows one left row agreed with: 1 identifies, many block.');
    out.push("");
  }

  if (report.partialPairs?.length) {
    out.push("  examples of partial agreement (suggestions, NOT counted in the floor):");
    const mark: Record<string, string> = { verified: "ok ", contradicted: "BAD", ambiguous: "?? ", unverifiable: "   " };
    const width = Math.max(...report.partialPairs.flatMap((p: PartialPair) => p.components.map((c) => c.label.length)));
    for (const p of report.partialPairs.slice(0, 6)) {
      const agree = p.components.filter((c) => c.agrees).map((c) => c.label);
      const differ = p.components.filter((c) => !c.agrees).map((c) => c.label);
      const multi = p.candidates > 1 ? `  [${p.candidates} candidates]` : "";
      out.push(`    ${mark[p.verification]} agrees on ${agree.join(" + ") || "nothing"}, not on ${differ.join(" + ")}${multi}`);
      for (const c of p.components) {
        out.push(`          ${pad(c.label, width + 2)}${pad(c.leftValue, 30)}${c.agrees ? "=" : "x"}  ${c.rightValue}`);
      }
    }
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

  if (report.nearMisses.length) {
    out.push("  closest neighbours among rows NO RULE explains (suggestions, not counted):");
    const mark: Record<string, string> = { verified: "ok ", contradicted: "BAD", ambiguous: "?? ", unverifiable: "   " };
    for (const nm of report.nearMisses.slice(0, 10)) {
      out.push(`    ${mark[nm.verification]} ${pad(nm.leftKey, 34)} ~  ${pad(nm.rightKey, 38)} ${nm.similarity}`);
    }
    if (report.noCandidate > 0) {
      out.push(`    ${report.noCandidate} more have no string similarity at all — those need an alias table.`);
    }
    out.push("");
  }

  for (const w of report.warnings) out.push(`  ! ${w}`);
  if (report.warnings.length) out.push("");
  return out.join("\n");
}
