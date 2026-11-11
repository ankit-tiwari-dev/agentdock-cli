import type {
  VerificationReport,
  OverallStatus,
  Specification,
} from "../../core/src/index.ts";
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
  diffUnified?: string;
}

export class VerifierEngine {
  public verify(options: VerifySessionOptions): { report: VerificationReport; formattedText: string } {
    // 1. Run Tier 1 Deterministic Checks
    const deterministicResults = runDeterministicChecks({
      projectPath: options.projectPath,
      testCommand: options.testCommand,
      typecheckCommand: options.typecheckCommand,
      diffUnified: options.diffUnified,
    });

    // 2. Run Tier 2 Semantic Evidence Audit
    const findings = auditCriteriaAgainstEvidence({
      criteria: options.spec.acceptanceCriteria,
      diffUnified: options.diffUnified,
      testSuitePassed: deterministicResults.testSuitePassed,
    });

    // 3. Compute overall status
    let overallStatus: OverallStatus = "PASSED";

    const hasDeterministicFailure =
      !deterministicResults.testSuitePassed ||
      !deterministicResults.typecheckPassed ||
      deterministicResults.testTamperDetected;

    const hasDiscrepancy = findings.some((f) => f.verdict === "DISCREPANCY");
    const hasUnchecked = findings.some((f) => f.verdict === "UNCHECKED");

    if (hasDeterministicFailure || hasDiscrepancy) {
      overallStatus = "FAILED";
    } else if (hasUnchecked) {
      overallStatus = "NEEDS_ATTENTION";
    }

    const summary =
      overallStatus === "PASSED"
        ? "All deterministic checks passed and all acceptance criteria verified with concrete code evidence."
        : overallStatus === "NEEDS_ATTENTION"
        ? "Deterministic checks passed, but some criteria remain UNCHECKED. Review code before merging."
        : "Verification FAILED: Broken tests, compiler errors, or test assertion tampering detected.";

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

