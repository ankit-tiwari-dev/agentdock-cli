import type { VerificationReport, OverallStatus, Specification } from "../../core/src/index.ts";
import { runDeterministicChecks } from "./deterministic-runner.ts";
import { auditCriteriaAgainstEvidence } from "./semantic-auditor.ts";
import { formatVerificationReportText } from "./report-generator.ts";

export interface VerifySessionOptions {
  sessionId: string;
  projectPath: string;
  spec: Specification;
  gitCommitSha?: string;
  testCommand?: string;
  typecheckCommand?: string;
  lintCommand?: string;
  diffUnified?: string;
}

export class VerifierEngine {
  public verify(options: VerifySessionOptions): { report: VerificationReport; formattedText: string } {
    // 1. Run Tier 1 Deterministic Checks
    const deterministicResults = runDeterministicChecks({
      projectPath: options.projectPath,
      testCommand: options.testCommand,
      typecheckCommand: options.typecheckCommand,
      lintCommand: options.lintCommand,
      diffUnified: options.diffUnified,
    });

    // 2. Run Tier 2 Semantic Evidence Audit
    const findings = auditCriteriaAgainstEvidence({
      criteria: options.spec.acceptanceCriteria,
      diffUnified: options.diffUnified,
      testSuitePassed: deterministicResults.testSuitePassed,
      testSuiteRan: deterministicResults.testSuiteStatus !== "NOT_RUN",
    });

    // 3. Compute overall status. PASSED needs every check to have run and passed:
    // a check that did not run leaves the result at NEEDS_ATTENTION at best.
    let overallStatus: OverallStatus = "PASSED";

    const checks = {
      "test suite": deterministicResults.testSuiteStatus,
      typecheck: deterministicResults.typecheckStatus,
      lint: deterministicResults.lintStatus,
    };
    const notRun = Object.entries(checks)
      .filter(([, status]) => status === "NOT_RUN")
      .map(([name]) => name);

    const hasDeterministicFailure = Object.values(checks).includes("FAIL") || deterministicResults.testTamperDetected;

    const hasDiscrepancy = findings.some((f) => f.verdict === "DISCREPANCY");
    const hasUnchecked = findings.some((f) => f.verdict === "UNCHECKED");

    if (hasDeterministicFailure || hasDiscrepancy) {
      overallStatus = "FAILED";
    } else if (notRun.length > 0 || hasUnchecked) {
      overallStatus = "NEEDS_ATTENTION";
    }

    const notVerified = notRun.length > 0 ? `Not verified: ${notRun.join(", ")} NOT RUN (no command configured).` : "";
    const summary =
      overallStatus === "PASSED"
        ? "All deterministic checks passed and all acceptance criteria verified with concrete code evidence."
        : overallStatus === "NEEDS_ATTENTION"
          ? [notVerified, hasUnchecked ? "Some criteria remain UNCHECKED." : "", "Review code before merging."]
              .filter(Boolean)
              .join(" ")
          : "Verification FAILED: Broken tests, compiler errors, lint errors, or test assertion tampering detected.";

    const report: VerificationReport = {
      id: `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: options.sessionId,
      specHash: options.spec.hash,
      gitCommitSha: options.gitCommitSha ?? "HEAD",
      deterministicResults,
      findings,
      overallStatus,
      summary,
      createdAt: Date.now(),
    };

    const formattedText = formatVerificationReportText(report);

    return { report, formattedText };
  }
}
