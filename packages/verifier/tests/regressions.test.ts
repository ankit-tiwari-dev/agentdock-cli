import test from "node:test";
import assert from "node:assert/strict";
import { VerifierEngine, runDeterministicChecks, formatVerificationReportText } from "../src/index.ts";
import { parseSpecificationMarkdown } from "../../intent/src/index.ts";

// No quotes: the same command string must work under both cmd.exe and /bin/sh.
const OK = "node --version";
const FAIL = "node --no-such-flag-for-this-test";

const SPEC = parseSpecificationMarkdown(`---
title: Auth Feature
---
# Auth Feature
## Acceptance Criteria
- [ ] AC-1: Login returns JWT token
`);

const AUTH_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,3 @@
+export function login(username, password) {
+  return { token: generateToken(username) };
+}
`;

test("regression: a check with no command is NOT RUN, never PASS", () => {
  const results = runDeterministicChecks({ projectPath: "." });
  assert.equal(results.testSuiteStatus, "NOT_RUN");
  assert.equal(results.typecheckStatus, "NOT_RUN");
  assert.equal(results.lintStatus, "NOT_RUN");
  assert.equal(results.testSuitePassed, false);
  assert.equal(results.typecheckPassed, false);
  assert.equal(results.lintPassed, false);
});

test("regression: verify with nothing run is not PASSED and the report prints NOT RUN", () => {
  const { report, formattedText } = new VerifierEngine().verify({
    sessionId: "s",
    projectPath: ".",
    spec: SPEC,
    diffUnified: AUTH_DIFF,
  });
  assert.notEqual(report.overallStatus, "PASSED");
  assert.equal(report.overallStatus, "NEEDS_ATTENTION");
  assert.match(formattedText, /Compiler \/ Typecheck:\s+NOT RUN/);
  assert.match(formattedText, /Test Suite Execution:\s+NOT RUN/);
  assert.match(formattedText, /Lint \/ Static Analysis:\s+NOT RUN/);
  assert.match(report.summary, /NOT RUN/);
});

test("regression: verify is PASSED only when test, typecheck and lint all ran and passed", () => {
  const noLint = new VerifierEngine().verify({
    sessionId: "s",
    projectPath: ".",
    spec: SPEC,
    diffUnified: AUTH_DIFF,
    testCommand: OK,
    typecheckCommand: OK,
  });
  assert.equal(noLint.report.overallStatus, "NEEDS_ATTENTION");
  assert.match(noLint.formattedText, /Lint \/ Static Analysis:\s+NOT RUN/);

  const { report, formattedText } = new VerifierEngine().verify({
    sessionId: "s",
    projectPath: ".",
    spec: SPEC,
    diffUnified: AUTH_DIFF,
    testCommand: OK,
    typecheckCommand: OK,
    lintCommand: OK,
  });
  assert.equal(report.overallStatus, "PASSED");
  assert.match(formattedText, /Lint \/ Static Analysis:\s+PASS/);
});

test("regression: a failing lint command fails verification", () => {
  const { report, formattedText } = new VerifierEngine().verify({
    sessionId: "s",
    projectPath: ".",
    spec: SPEC,
    diffUnified: AUTH_DIFF,
    testCommand: OK,
    typecheckCommand: OK,
    lintCommand: FAIL,
  });
  assert.equal(report.deterministicResults.lintStatus, "FAIL");
  assert.equal(report.overallStatus, "FAILED");
  assert.match(formattedText, /Lint \/ Static Analysis:\s+FAIL/);
});

test("regression: DETERMINISTIC_PASS needs a test run that actually happened", () => {
  const spec = parseSpecificationMarkdown(`---
title: Feature
---
# Feature
## Acceptance Criteria
- [ ] AC-1: Login endpoint returns 429 after five failed attempts
`);
  const unrelated = `diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,1 @@
+export const noop = () => {};
`;
  const notRun = new VerifierEngine().verify({ sessionId: "s", projectPath: ".", spec, diffUnified: unrelated });
  assert.equal(spec.acceptanceCriteria[0].category, "DETERMINISTIC_TESTABLE");
  assert.notEqual(notRun.report.findings[0].verdict, "DETERMINISTIC_PASS");

  const ran = new VerifierEngine().verify({
    sessionId: "s",
    projectPath: ".",
    spec,
    diffUnified: unrelated,
    testCommand: OK,
  });
  assert.equal(ran.report.findings[0].verdict, "DETERMINISTIC_PASS");
});

test("regression: a README TODO line is not evidence that a criterion is done", () => {
  const spec = parseSpecificationMarkdown(`---
title: Feature
---
# Feature
## Acceptance Criteria
- [ ] AC-1: Users can reset their password via an email link
`);
  const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 hello
+TODO: password reset via email is not done yet
`;
  const { report } = new VerifierEngine().verify({ sessionId: "s", projectPath: ".", spec, diffUnified: diff });
  assert.notEqual(report.findings[0].verdict, "SEMANTIC_VERIFIED");
});

test("regression: docs, test files and TODO comments in source are not evidence", () => {
  const spec = parseSpecificationMarkdown(`---
title: Feature
---
# Feature
## Acceptance Criteria
- [ ] AC-1: Users can reset their password via an email link
`);
  const diff = `diff --git a/docs/guide.txt b/docs/guide.txt
--- a/docs/guide.txt
+++ b/docs/guide.txt
@@ -1,1 +1,2 @@
 hello
+password reset via email link
diff --git a/tests/reset.test.ts b/tests/reset.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/reset.test.ts
@@ -0,0 +1,1 @@
+test("password reset via email", () => {});
diff --git a/src/reset.ts b/src/reset.ts
new file mode 100644
--- /dev/null
+++ b/src/reset.ts
@@ -0,0 +1,1 @@
+// FIXME password reset via email is not implemented
`;
  const { report } = new VerifierEngine().verify({ sessionId: "s", projectPath: ".", spec, diffUnified: diff });
  assert.equal(report.findings[0].verdict, "UNCHECKED");

  const real = `diff --git a/src/reset.ts b/src/reset.ts
new file mode 100644
--- /dev/null
+++ b/src/reset.ts
@@ -0,0 +1,1 @@
+export function sendPasswordResetEmail(user) { return mailer.send(user.email, "password reset link"); }
`;
  const ok = new VerifierEngine().verify({ sessionId: "s", projectPath: ".", spec, diffUnified: real });
  assert.equal(ok.report.findings[0].verdict, "SEMANTIC_VERIFIED");
  assert.equal(ok.report.findings[0].evidence?.filePath, "src/reset.ts");
});

test("regression: the formatter prints NOT RUN for a check that has no status", () => {
  const { report } = new VerifierEngine().verify({ sessionId: "s", projectPath: ".", spec: SPEC });
  assert.match(formatVerificationReportText(report), /Test Suite Execution:\s+NOT RUN/);
});
