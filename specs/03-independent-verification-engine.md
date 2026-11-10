# Feature Specification: Independent Verification Engine

**Module ID:** `SPEC-03-VERIFIER`  
**Package:** `@ctrlplane/verifier`, `@ctrlplane/git-analyzer`  
**Status:** Ready for Review

---

## 1. Objective & Scope

The Independent Verification Engine evaluates whether code modifications made by an AI coding agent satisfy the approved specification (SPEC-01) without introducing regressions or circumventing tests.

It enforces a strict **Two-Tier Verification Architecture**:
1. **Tier 1 (Deterministic Verification):** Compilers, typecheckers, test runners, linters, and AST diff analyzers produce mathematical/binary ground truth.
2. **Tier 2 (AI Semantic Verification):** A secondary model evaluates behavioral requirements that escape static analysis, under strict evidence-citation constraints.

---

## 2. Verification Architecture & Evidence Taxonomy

```mermaid
flowchart TD
    A[Agent Finishes Session / Stop Hook] --> B[Trigger Verification Engine]
    
    subgraph Tier1 [Tier 1: Deterministic Verification (Ground Truth)]
        C[Run Build / Typecheck]
        D[Run Configured Test Suite]
        E[AST Diff & Test Tamper Analyzer]
        F[Mutation / Coverage Delta]
    end
    
    B --> Tier1
    
    Tier1 --> G{Deterministic Checks Pass?}
    G -->|No| H[Emit DETERMINISTIC_FAIL Report]
    G -->|Yes| Tier2
    
    subgraph Tier2 [Tier 2: AI Semantic Verification (Evidence-Constrained)]
        I[Load Specification & Acceptance Criteria]
        J[Extract Modified File Chunks & AST Nodes]
        K[Evaluate Criteria against Evidence]
        L{Evidence Found?}
        L -->|Direct line citation + active test| M[Verdict: SEMANTIC_VERIFIED]
        L -->|Contradiction detected| N[Verdict: DISCREPANCY]
        L -->|No matching code found| O[Verdict: UNCHECKED]
        L -->|External dependency required| P[Verdict: INCONCLUSIVE]
    end
    
    H & M & N & O & P --> Q[Compile Unified Evidence Report]
    Q --> R[Terminal Summary & SQLite Audit Record]
```

### 2.1 The 5-State Verdict Taxonomy
Every acceptance criterion is classified into exactly one of five states:

| Verdict State | Definition | Evidentiary Requirement |
|---|---|---|
| `DETERMINISTIC_PASS` | Verified by a zero-exit-code tool (compiler, test suite, linter). | Passing process exit code, zero assertion errors. |
| `SEMANTIC_VERIFIED` | Verified by AI semantic analysis. | **Mandatory:** Must cite exact file, line range, and AST symbol, AND verify a test exercises that symbol. |
| `DISCREPANCY` | Code violates specification or introduces architectural contradictions. | Code snippet cited showing contradictory implementation. |
| `UNCHECKED` | Stated in specification, but no relevant code or test changes exist in the diff. | Absence of diff hunks addressing this criterion. |
| `INCONCLUSIVE` | Cannot be evaluated without external staging environments or manual hardware tests. | Explicit explanation of missing environment capability. |

---

## 3. Functional Requirements

### 3.1 Tier 1: Deterministic Check Runners
The engine auto-detects or reads `.ctrlplane/verifier.yaml` to execute local build commands:
* **Typecheck Runner:** Executes project typecheckers (e.g. `npx tsc --noEmit`, `mypy .`, `go vet ./...`).
* **Test Suite Runner:** Executes unit and integration tests (e.g. `vitest run`, `pytest -v`, `cargo test`).
* **Linter & Format Runner:** Runs linters (e.g. `eslint .`, `ruff check .`).
* **Test-Tamper Analyzer:**
  * Compares test files in working tree against `HEAD`.
  * Computes AST diff to verify that existing test assertion blocks (`expect`, `assert`, `test`, `it`) have not been deleted, commented out, or had assertions lowered.
  * If test weakening is detected, Tier 1 immediately fails with `REASON: TEST_TAMPERING_DETECTED`.

### 3.2 Tier 2: AI Semantic Verification Engine
* **Input Context:**
  1. Approved specification and criteria from `.ctrlplane/spec.md`.
  2. Git unified diff between session base commit and current working tree.
  3. AST symbols of modified functions and classes.
  4. Test output logs.
* **Citation Constraints:**
  * The evaluation prompt enforces: *"You must not mark any criterion as SEMANTIC_VERIFIED unless you provide the exact filename, start line, and end line where the requirement is satisfied. If you cannot point to lines in the diff, you MUST classify it as UNCHECKED."*
* **Anti-Hallucination Guard:** The model is evaluated with temperature `0.0` and structured JSON schema enforcement.

### 3.3 Verification Report Format
The engine outputs a unified report accessible via CLI (`ctrlplane verify --report`) and persisted to SQLite:

```
================================================================================
                      CTRLPLANE VERIFICATION REPORT
================================================================================
Session: sess_94f8a1bc | Branch: feature/auth-jwt | Commit: 8a4c19e
Status:  PASSED (WITH 1 UNCHECKED CRITERION)

TIER 1: DETERMINISTIC CHECKS
✔ Compiler / Typecheck:    PASS (tsc --noEmit: 0 errors)
✔ Test Suite Execution:    PASS (42 passed, 0 failed, 120 assertions)
✔ Test-Tamper Integrity:   PASS (0 existing test assertions weakened)
✔ Lint / Static Analysis:  PASS (eslint: 0 warnings)

TIER 2: ACCEPTANCE CRITERIA AUDIT
✔ AC-1: POST /api/auth/login returns 200 with tokens
  State:    SEMANTIC_VERIFIED
  Evidence: src/routes/auth.ts:45-62 (TokenGenerationHandler)
  Test:     tests/auth.test.ts:18 (test_login_success)

✔ AC-2: Access token expires after 15 minutes
  State:    SEMANTIC_VERIFIED
  Evidence: src/config/jwt.ts:12 (ACCESS_TOKEN_TTL = 900)

✔ AC-3: Refresh token rotation on /api/auth/refresh
  State:    SEMANTIC_VERIFIED
  Evidence: src/services/auth.ts:114-138 (rotateRefreshToken)

⚠ AC-4: Attempting reuse of invalidated refresh token revokes all sessions
  State:    UNCHECKED
  Reason:   No code or test in the diff implements multi-session revocation on replay.

--------------------------------------------------------------------------------
VERDICT: Human review required for 1 unchecked criterion before merge.
================================================================================
```

---

## 4. Data Models & TypeScript Schemas

```typescript
import { z } from "zod";

export const VerdictStateSchema = z.enum([
  "DETERMINISTIC_PASS",
  "SEMANTIC_VERIFIED",
  "DISCREPANCY",
  "UNCHECKED",
  "INCONCLUSIVE",
]);

export const CodeEvidenceSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  astSymbol: z.string().optional(),
  codeSnippet: z.string().optional(),
});

export const CriterionVerificationFindingSchema = z.object({
  criterionId: z.string(),
  verdict: VerdictStateSchema,
  tier: z.enum(["deterministic", "semantic"]),
  evidence: CodeEvidenceSchema.optional(),
  associatedTestFile: z.string().optional(),
  rationale: z.string(),
});

export const VerificationReportSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  specHash: z.string(),
  gitCommitSha: z.string(),
  deterministicResults: z.object({
    typecheckPassed: z.boolean(),
    testSuitePassed: z.boolean(),
    testTamperDetected: z.boolean(),
    lintPassed: z.boolean(),
    rawLogs: z.record(z.string()).optional(),
  }),
  findings: z.array(CriterionVerificationFindingSchema),
  overallStatus: z.enum(["PASSED", "FAILED", "NEEDS_ATTENTION"]),
  createdAt: z.number().int(),
});

export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type CriterionVerificationFinding = z.infer<typeof CriterionVerificationFindingSchema>;
```

---

## 5. Failure Modes & Edge Cases

1. **Flaky / Non-Deterministic Tests:** If a test fails intermittently, the test runner is configured to retry up to 2 times. If it still fails, it is marked `DETERMINISTIC_FAIL` and halts progression.
2. **Missing Test Suites:** If the project has no tests configured, the engine flags a high-priority warning: `WARNING: NO_DETERMINISTIC_TESTS_FOUND`, and marks all criteria as `UNCHECKED` or `SEMANTIC_VERIFIED (WITHOUT TEST EVIDENCE)`.
3. **Model Hallucination of Line Numbers:** The verifier cross-references the cited line numbers against the actual Git diff on disk. If the cited line does not exist or does not match the snippet, the finding is downgraded to `INCONCLUSIVE` and flagged for manual audit.

---

## 6. Acceptance Criteria

- [ ] **AC-VERIFY-1:** Tier 1 test runner accurately captures failures and blocks progression if any unit test fails.
- [ ] **AC-VERIFY-2:** The test-tamper analyzer flags an error if any lines containing test assertions are deleted from existing test files in Git `HEAD`.
- [ ] **AC-VERIFY-3:** The Tier 2 AI auditor rejects criteria as `UNCHECKED` when no corresponding code changes appear in the diff.
- [ ] **AC-VERIFY-4:** Every `SEMANTIC_VERIFIED` finding includes a verified valid file path and line number range that exists in the working tree.
- [ ] **AC-VERIFY-5:** The verification report is saved to SQLite and printable via `ctrlplane verify`.

