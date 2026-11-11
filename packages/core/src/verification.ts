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

export interface DeterministicResults {
  typecheckPassed: boolean;
  testSuitePassed: boolean;
  testTamperDetected: boolean;
  lintPassed: boolean;
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
