import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, classifyFile, isTestFile, isSensitiveFile, analyzeTestDiff } from "../src/index.ts";

test("File classifier correctly identifies file types", () => {
  assert.equal(isTestFile("src/routes/auth.test.ts"), true);
  assert.equal(isTestFile("tests/unit/login.spec.js"), true);
  assert.equal(isTestFile("backend/tests/test_api.py"), true);
  assert.equal(isTestFile("src/routes/auth.ts"), false);

  assert.equal(isSensitiveFile(".env"), true);
  assert.equal(isSensitiveFile("config/.env.production"), true);
  assert.equal(isSensitiveFile("secrets/private.pem"), true);
  assert.equal(isSensitiveFile("src/index.ts"), false);

  assert.equal(classifyFile(".ctrlplane/spec.md"), "CTRLPLANE_FILE");
  assert.equal(classifyFile("package.json"), "CONFIG_FILE");
  assert.equal(classifyFile("src/components/Button.tsx"), "SOURCE_FILE");
});

test("Diff parser extracts file changes and hunks", () => {
  const rawDiff = `diff --git a/src/math.ts b/src/math.ts
index e69de29..d95f3ad 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number) {
+  console.log("adding numbers");
   return a + b;
 }
`;

  const files = parseUnifiedDiff(rawDiff);
  assert.equal(files.length, 1);
  assert.equal(files[0].newPath, "src/math.ts");
  assert.equal(files[0].addedLinesCount, 1);
  assert.equal(files[0].deletedLinesCount, 0);
  assert.equal(files[0].hunks.length, 1);
});

test("Anti-Test-Gaming Guard catches deleted test assertions", () => {
  const tamperedDiff = `diff --git a/tests/auth.test.ts b/tests/auth.test.ts
index a1b2c3d..e4f5g6h 100644
--- a/tests/auth.test.ts
+++ b/tests/auth.test.ts
@@ -10,4 +10,2 @@
   test("login failure returns 401", async () => {
-    const res = await request(app).post("/login").send({});
-    expect(res.status).toBe(401);
+    // Disabled failing test
   });
`;

  const files = parseUnifiedDiff(tamperedDiff);
  assert.equal(files.length, 1);

  const analysis = analyzeTestDiff(files[0]);
  assert.equal(analysis.isTestFile, true);
  assert.equal(analysis.isTamperingDetected, true);
  assert.equal(analysis.tamperedAssertionsCount >= 1, true);
  assert.ok(analysis.tamperedSnippets.some((s) => s.includes("expect(res.status).toBe(401)")));
  assert.ok(analysis.explanation.includes("Anti-Test-Gaming Guard"));
});

test("Anti-Test-Gaming Guard allows creating brand new test files", () => {
  const newTestDiff = `diff --git a/tests/new-feature.test.ts b/tests/new-feature.test.ts
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/tests/new-feature.test.ts
@@ -0,0 +1,5 @@
+import test from "node:test";
+test("new feature works", () => {
+  expect(true).toBe(true);
+});
`;

  const files = parseUnifiedDiff(newTestDiff);
  assert.equal(files.length, 1);
  assert.equal(files[0].isNewFile, true);

  const analysis = analyzeTestDiff(files[0]);
  assert.equal(analysis.isTestFile, true);
  assert.equal(analysis.isNewTestFile, true);
  assert.equal(analysis.isTamperingDetected, false); // Safe!
});
