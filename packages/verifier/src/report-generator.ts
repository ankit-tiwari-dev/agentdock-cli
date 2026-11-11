import type { CheckStatus, VerificationReport } from "../../core/src/index.ts";

function checkLabel(status: CheckStatus | undefined): string {
  if (status === "PASS") return "PASS";
  if (status === "FAIL") return "FAIL";
  return "NOT RUN";
}

export function formatVerificationReportText(report: VerificationReport): string {
  const divider = "=".repeat(80);
  const thinDivider = "-".repeat(80);
  const results = report.deterministicResults;

  const lines: string[] = [
    divider,
    "                      CTRLPLANE VERIFICATION REPORT",
    divider,
    `Session:  ${report.sessionId}`,
    `Commit:   ${report.gitCommitSha}`,
    `Status:   ${report.overallStatus}`,
    "",
    "TIER 1: DETERMINISTIC SYSTEM CHECKS",
    `  • Compiler / Typecheck:   ${checkLabel(results.typecheckStatus)}`,
    `  • Test Suite Execution:   ${checkLabel(results.testSuiteStatus)}`,
    `  • Test Tamper Integrity:  ${results.testTamperDetected ? "TAMPERING DETECTED!" : "PASS"}`,
    `  • Lint / Static Analysis: ${checkLabel(results.lintStatus)}`,
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
      lines.push(
        `     Evidence: ${finding.evidence.filePath}:${finding.evidence.lineStart}-${finding.evidence.lineEnd}`,
      );
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
