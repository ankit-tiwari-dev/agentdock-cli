import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, analyzeTestDiff, isTestFile } from "../src/index.ts";

function tamperOf(diff: string) {
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1, "fixture must parse to exactly one file");
  return analyzeTestDiff(files[0]);
}

test("regression: deleting a whole test file is flagged as tampering", () => {
  const diff = `diff --git a/tests/auth.test.ts b/tests/auth.test.ts
deleted file mode 100644
index 1111111..0000000
--- a/tests/auth.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-test("login", () => {
-  expect(login()).toBe(true);
-});
`;
  const analysis = tamperOf(diff);
  assert.equal(analysis.isTestFile, true);
  assert.equal(analysis.isTamperingDetected, true);
  assert.ok(analysis.tamperedSnippets.some((s) => s.includes("DELETED_ENTIRE_FILE: tests/auth.test.ts")));
});

test("regression: an added line that starts with ++ inside a hunk does not reset the file path", () => {
  const diff = `diff --git a/src/loop.ts b/src/loop.ts
index 1111111..2222222 100644
--- a/src/loop.ts
+++ b/src/loop.ts
@@ -1,2 +1,3 @@
 let i = 0;
+++ i;
 export { i };
`;
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.newPath, "src/loop.ts");
  assert.equal(file.addedLinesCount, 1);
  assert.equal(file.hunks[0].lines[1].type, "add");
  assert.equal(file.hunks[0].lines[1].content, "++ i;");
});

test("diff parser: a removed line that starts with -- inside a hunk stays a deleted line", () => {
  const diff = `diff --git a/db/schema.sql b/db/schema.sql
index 1111111..2222222 100644
--- a/db/schema.sql
+++ b/db/schema.sql
@@ -1,2 +1,1 @@
--- old comment
 SELECT 1;
`;
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.oldPath, "db/schema.sql");
  assert.equal(file.deletedLinesCount, 1);
  assert.equal(file.hunks[0].lines[0].content, "-- old comment");
});

test("regression: a path with spaces loses the trailing TAB git appends", () => {
  const diff = [
    "diff --git a/src/my file.ts b/src/my file.ts",
    "index 1111111..2222222 100644",
    "--- a/src/my file.ts\t",
    "+++ b/src/my file.ts\t",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.oldPath, "src/my file.ts");
  assert.equal(file.newPath, "src/my file.ts");
});

test("regression: a C-quoted path is unquoted and loses its a/ b/ prefix", () => {
  const diff = [
    'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
    "index 1111111..2222222 100644",
    '--- "a/src/caf\\303\\251.ts"',
    '+++ "b/src/caf\\303\\251.ts"',
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.oldPath, "src/café.ts");
  assert.equal(file.newPath, "src/café.ts");
});

for (const [label, added] of [
  ["describe.skip", 'describe.skip("auth", () => {'],
  ["it.skip", '  it.skip("logs in", () => {'],
  ["test.skip", 'test.skip("logs in", () => {'],
  ["test.only", 'test.only("logs in", () => {'],
  ["describe.only", 'describe.only("auth", () => {'],
  ["xit", '  xit("logs in", () => {'],
  ["xdescribe", 'xdescribe("auth", () => {'],
] as const) {
  test(`regression: switching a test to ${label} is flagged as tampering`, () => {
    const diff = `diff --git a/tests/auth.test.ts b/tests/auth.test.ts
index 1111111..2222222 100644
--- a/tests/auth.test.ts
+++ b/tests/auth.test.ts
@@ -1,1 +1,1 @@
-describe("auth", () => {
+${added}
`;
    const analysis = tamperOf(diff);
    assert.equal(analysis.isTamperingDetected, true, label);
  });
}

test("regression: weakening a chained matcher line (.toBe(4) -> .toBeDefined()) is flagged", () => {
  const diff = `diff --git a/tests/math.test.ts b/tests/math.test.ts
index 1111111..2222222 100644
--- a/tests/math.test.ts
+++ b/tests/math.test.ts
@@ -1,3 +1,3 @@
   expect(add(2, 2))
-    .toBe(4);
+    .toBeDefined();
 });
`;
  const analysis = tamperOf(diff);
  assert.equal(analysis.isTamperingDetected, true);
  assert.ok(analysis.tamperedSnippets.some((s) => s.includes(".toBe(4)")));
});

test("regression: an early return added to a test is flagged", () => {
  const diff = `diff --git a/tests/math.test.ts b/tests/math.test.ts
index 1111111..2222222 100644
--- a/tests/math.test.ts
+++ b/tests/math.test.ts
@@ -1,2 +1,3 @@
 test("adds", () => {
+  return;
   expect(add(2, 2)).toBe(4);
`;
  assert.equal(tamperOf(diff).isTamperingDetected, true);
});

test("regression: an added block-comment opener in a test is flagged", () => {
  const diff = `diff --git a/tests/math.test.ts b/tests/math.test.ts
index 1111111..2222222 100644
--- a/tests/math.test.ts
+++ b/tests/math.test.ts
@@ -1,2 +1,3 @@
 test("adds", () => {
+  /*
   expect(add(2, 2)).toBe(4);
`;
  assert.equal(tamperOf(diff).isTamperingDetected, true);
});

test("regression: renaming a test file to a non-test name is flagged", () => {
  const diff = `diff --git a/tests/auth.test.ts b/src/auth-notes.ts
similarity index 100%
rename from tests/auth.test.ts
rename to src/auth-notes.ts
`;
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.oldPath, "tests/auth.test.ts");
  assert.equal(file.newPath, "src/auth-notes.ts");
  const analysis = analyzeTestDiff(file);
  assert.equal(analysis.isTestFile, true);
  assert.equal(analysis.isTamperingDetected, true);
});

test("test tamper: adding a normal line to an existing test is not tampering", () => {
  const diff = `diff --git a/tests/math.test.ts b/tests/math.test.ts
index 1111111..2222222 100644
--- a/tests/math.test.ts
+++ b/tests/math.test.ts
@@ -1,2 +1,5 @@
 test("adds", () => {
+  const sum = add(2, 2); /* inline note */
+  model.fit(data);
+  const files = glob("src/**/*.ts");
   expect(sum).toBe(4);
`;
  assert.equal(tamperOf(diff).isTamperingDetected, false);
});

test("regression: isTestFile recognises common test layouts in every language", () => {
  for (const p of [
    "tests/x.ts",
    "test/x.js",
    "__tests__/x.tsx",
    "src/__tests__/x.tsx",
    "test_math.py",
    "pkg/test_math.py",
    "math_test.py",
    "pkg/math_test.go",
    "src/test/java/com/acme/MathTest.java",
    "MathTests.java",
  ]) {
    assert.equal(isTestFile(p), true, p);
  }
  for (const p of ["src/auth.ts", "src/contest.ts", "src/Contest.java", "docs/testing.md", "src/attest/x.ts"]) {
    assert.equal(isTestFile(p), false, p);
  }
});
