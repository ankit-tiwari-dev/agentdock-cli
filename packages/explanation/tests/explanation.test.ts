import test from "node:test";
import assert from "node:assert/strict";
import { ExplanationEngine } from "../src/index.ts";

test("ExplanationEngine calculates blast radius and assesses elevated risk", () => {
  const engine = new ExplanationEngine();

  const authDiff = `diff --git a/src/services/auth.ts b/src/services/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/services/auth.ts
@@ -0,0 +1,6 @@
+export function rotateRefreshToken(oldToken: string) {
+  return "new_token";
+}
+export class SessionManager {}
`;

  const report = engine.explain({
    sessionId: "sess_300",
    diffUnified: authDiff,
    generateQuiz: true,
  });

  assert.equal(report.riskLevel, "HIGH");
  assert.equal(report.blastRadius.length, 2);
  assert.ok(report.blastRadius.some((b) => b.symbolName === "rotateRefreshToken"));
  assert.ok(report.blastRadius.some((b) => b.symbolName === "SessionManager"));

  // Verify quiz questions generated
  assert.ok(report.comprehensionQuestions && report.comprehensionQuestions.length > 0);
  assert.ok(report.comprehensionQuestions[0].questionText.includes("authentication"));
});

test("ExplanationEngine detects new dependencies added in package.json", () => {
  const engine = new ExplanationEngine();

  const pkgDiff = `diff --git a/package.json b/package.json
index 111..222 100644
--- a/package.json
+++ b/package.json
@@ -10,2 +10,3 @@
   "dependencies": {
+    "stripe": "^14.5.0",
     "dotenv": "^16.0.0"
   }
`;

  const report = engine.explain({
    sessionId: "sess_301",
    diffUnified: pkgDiff,
  });

  assert.equal(report.dependencyChanges.length, 1);
  assert.equal(report.dependencyChanges[0].packageName, "stripe");
  assert.equal(report.dependencyChanges[0].version, "^14.5.0");
  assert.ok(report.potentialRisks.some((r) => r.includes("dependency")));
});
