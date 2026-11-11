export type VerdictState = "DETERMINISTIC_PASS" | "SEMANTIC_VERIFIED" | "DISCREPANCY" | "UNCHECKED" | "INCONCLUSIVE";

export interface CodeEvidence {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  astSymbol?: string;
  codeSnippet?: string;
}

export interface CriterionFinding {
  criterionId: string;
  verdict: VerdictState;
  tier: "deterministic" | "semantic";
  evidence?: CodeEvidence;
  associatedTestFile?: string;
  rationale: string;
}

/** NOT_RUN means no command was configured for the check; it never counts as a pass. */
export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN";

export interface DeterministicResults {
  /** True only when the typecheck ran and passed. */
  typecheckPassed: boolean;
  /** True only when the test suite ran, passed, and no test tampering was found. */
  testSuitePassed: boolean;
  testTamperDetected: boolean;
  /** True only when the lint command ran and passed. */
  lintPassed: boolean;
  typecheckStatus: CheckStatus;
  testSuiteStatus: CheckStatus;
  lintStatus: CheckStatus;
  failedAssertionCount?: number;
  rawLogs?: Record<string, string>;
}

export type OverallStatus = "PASSED" | "FAILED" | "NEEDS_ATTENTION";

export interface VerificationReport {
  id: string;
  sessionId: string;
  specHash: string;
  gitCommitSha: string;
  deterministicResults: DeterministicResults;
  findings: CriterionFinding[];
  overallStatus: OverallStatus;
  summary: string;
  createdAt: number;
}
