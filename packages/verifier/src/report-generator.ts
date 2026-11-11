import type { VerificationReport } from "../../core/src/index.ts";

export function formatVerificationReportText(report: VerificationReport): string {
  const divider = "=".repeat(80);
  const thinDivider = "-".repeat(80);

  const lines: string[] = [
    divider,
    "                      CTRLPLANE VERIFICATION REPORT",
    divider,
    `Session:  ${report.sessionId}`,
    `Commit:   ${report.gitCommitSha}`,
    `Status:   ${report.overallStatus}`,
    "",
    "TIER 1: DETERMINISTIC SYSTEM CHECKS",
    `  • Compiler / Typecheck:   ${report.deterministicResults.typecheckPassed ? "PASS" : "FAIL"}`,
    `  • Test Suite Execution:   ${report.deterministicResults.testSuitePassed ? "PASS" : "FAIL"}`,
    `  • Test Tamper Integrity:  ${report.deterministicResults.testTamperDetected ? "TAMPERING DETECTED!" : "PASS"}`,
    `  • Lint / Static Analysis: ${report.deterministicResults.lintPassed ? "PASS" : "FAIL"}`,
    "",
    "TIER 2: ACCEPTANCE CRITERIA EVIDENCE AUDIT",
  ];

  for (const finding of report.findings) {
    const symbol =
      finding.verdict === "DETERMINISTIC_PASS" || finding.verdict === "SEMANTIC_VERIFIED"
        ? "[PASS]"
        : finding.verdict === "UNCHECKED"
        ? "[UNCHECKED]"
        : "[DISCREPANCY]";

    lines.push(`  ${symbol} ${finding.criterionId}: ${finding.verdict}`);
    if (finding.evidence) {
      lines.push(`     Evidence: ${finding.evidence.filePath}:${finding.evidence.lineStart}-${finding.evidence.lineEnd}`);
      if (finding.evidence.codeSnippet) {
        lines.push(`     Snippet:  ${finding.evidence.codeSnippet}`);
      }
    }
    lines.push(`     Note:     ${finding.rationale}`);
    lines.push("");
  }

  lines.push(thinDivider);
  lines.push(`SUMMARY: ${report.summary}`);
  lines.push(divider);

  return lines.join("\n");
}

