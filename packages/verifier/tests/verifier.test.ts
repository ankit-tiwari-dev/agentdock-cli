import test from "node:test";
import assert from "node:assert/strict";
import { VerifierEngine } from "../src/index.ts";
import { parseSpecificationMarkdown } from "../../intent/src/index.ts";

test("VerifierEngine verifies compliant changes with evidence citations", () => {
  const engine = new VerifierEngine();

  const specMd = `---
title: Auth Feature
---
# Auth Feature
## Acceptance Criteria
- [ ] AC-1: Login returns JWT token
`;
  const spec = parseSpecificationMarkdown(specMd);

  const diff = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,5 @@
+export function login(username, password) {
+  const jwtToken = generateToken(username);
+  return { token: jwtToken };
+}
`;

  const { report, formattedText } = engine.verify({
    sessionId: "sess_100",
    projectPath: "./",
    spec,
    diffUnified: diff,
  });

  assert.equal(report.overallStatus, "PASSED");
  assert.equal(report.findings[0].verdict, "SEMANTIC_VERIFIED");
  assert.ok(report.findings[0].evidence);
  assert.equal(report.findings[0].evidence?.filePath, "src/auth.ts");
  assert.ok(formattedText.includes("CTRLPLANE VERIFICATION REPORT"));
  assert.ok(formattedText.includes("[PASS] AC-1"));
});

test("VerifierEngine fails when test tampering is detected in Tier 1", () => {
  const engine = new VerifierEngine();

  const specMd = `---
title: Auth Feature
---
# Auth Feature
## Acceptance Criteria
- [ ] AC-1: Existing tests remain intact
`;
  const spec = parseSpecificationMarkdown(specMd);

  // Agent tampered with existing test assertion!
  const tamperedDiff = `diff --git a/tests/auth.test.ts b/tests/auth.test.ts
index 1111111..2222222 100644
--- a/tests/auth.test.ts
+++ b/tests/auth.test.ts
@@ -5,2 +5,1 @@
-    expect(res.status).toBe(200);
+    // Deleted assertion
`;

  const { report } = engine.verify({
    sessionId: "sess_101",
    projectPath: "./",
    spec,
    diffUnified: tamperedDiff,
  });

  assert.equal(report.overallStatus, "FAILED");
  assert.equal(report.deterministicResults.testTamperDetected, true);
  assert.equal(report.deterministicResults.testSuitePassed, false);
});

test("VerifierEngine marks missing requirements as UNCHECKED", () => {
  const engine = new VerifierEngine();

  const specMd = `---
title: Feature
---
# Feature
## Acceptance Criteria
- [ ] AC-1: Stripe webhook cancellation support
`;
  const spec = parseSpecificationMarkdown(specMd);

  // Diff only touched unrelated file
  const diff = `diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,2 @@
+export const noop = () => {};
`;

  const { report } = engine.verify({
    sessionId: "sess_102",
    projectPath: "./",
    spec,
    diffUnified: diff,
  });

  assert.equal(report.overallStatus, "NEEDS_ATTENTION");
  assert.equal(report.findings[0].verdict, "UNCHECKED");
  assert.ok(report.findings[0].rationale.includes("No matching code"));
});
