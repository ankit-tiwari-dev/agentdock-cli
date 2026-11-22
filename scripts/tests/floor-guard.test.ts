import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFloorViolations, ignoreMatcher, main } from "../floor-guard.ts";

const GUARD = join(import.meta.dirname, "..", "floor-guard.ts");

function fileDiff(file: string, added: string[], removed: string[] = []): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    ...removed.map((l) => "-" + l),
    ...added.map((l) => "+" + l),
  ].join("\n");
}

function rules(diff: string): string[] {
  return findFloorViolations(diff).map((f) => f.rule);
}

test("flags a new suppression comment in code", () => {
  assert.deepEqual(rules(fileDiff("packages/core/src/a.ts", ["// @ts-ignore", "x(); // eslint-disable-line"])), [
    "silenced-checker",
    "silenced-checker",
  ]);
});

test("flags stubs, empty catches and TODOs in code", () => {
  const diff = fileDiff("packages/core/src/a.ts", [
    'throw new Error("not implemented");',
    "try { x(); } catch {}",
    "// TODO later",
  ]);
  assert.deepEqual(rules(diff), ["unfinished-work", "unfinished-work", "unfinished-work"]);
});

test("flags skipped, todo and only tests in test files, in every node:test form", () => {
  const diff = fileDiff("packages/core/tests/a.test.ts", [
    'test.skip("x", () => {});',
    'test("x", { skip: true }, () => {});',
    'test("x", { todo: "later" }, () => {});',
    'describe.only("x", () => {});',
    "t.skip();",
  ]);
  assert.deepEqual(rules(diff), Array(5).fill("test-made-easier"));
});

test("does not flag a skip-looking word outside test files, or patterns in docs", () => {
  assert.deepEqual(rules(fileDiff("packages/core/src/a.ts", ["const opts = { skip: true };"])), []);
  assert.deepEqual(rules(fileDiff("README.md", ["Never add @ts-ignore or test.skip(), TODO"])), []);
});

test("flags an assertion removed from a test that stays, and a deleted test file", () => {
  const removedAssert = fileDiff("packages/core/tests/a.test.ts", [], ["  assert.equal(x, 1);"]);
  const deleted = [
    "diff --git a/packages/core/tests/b.test.ts b/packages/core/tests/b.test.ts",
    "--- a/packages/core/tests/b.test.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-assert.ok(true);",
  ].join("\n");
  assert.deepEqual(rules(removedAssert), ["assertion-removed"]);
  assert.deepEqual(rules(deleted), ["test-deleted"]);
});

test("a rewritten assertion is not a removed one; a net loss of assertions in a test file is", () => {
  const rewritten = fileDiff(
    "packages/core/tests/a.test.ts",
    ["  assert.equal(r.exitCode, 0);"],
    ['  assert.ok(typeof r === "string");'],
  );
  const lost = fileDiff(
    "packages/core/tests/a.test.ts",
    ["  assert.ok(x);"],
    ["  assert.ok(x);", "  assert.equal(y, 2);"],
  );
  assert.deepEqual(rules(rewritten), []);
  assert.deepEqual(rules(lost), ["assertion-removed"]);
});

test("treats a +++ line inside a hunk as content, not a header", () => {
  assert.deepEqual(rules(fileDiff("packages/core/src/a.ts", ["++i; // @ts-ignore"])), ["silenced-checker"]);
});

test("flags a loosened minimum and a raised maximum in CONSTRAINTS.md, and stays quiet when tightened", () => {
  const loosened = fileDiff(
    "CONSTRAINTS.md",
    ["| Coverage | Changed lines >= 70% covered | x | task end |"],
    ["| Coverage | Changed lines >= 80% covered | x | task end |"],
  );
  const raised = fileDiff(
    "CONSTRAINTS.md",
    ["| Hook latency | p95 at most 900 ms | x | CI |"],
    ["| Hook latency | p95 at most 600 ms | x | CI |"],
  );
  const tightened = fileDiff(
    "CONSTRAINTS.md",
    ["| Coverage | Changed lines >= 90% covered | x | task end |"],
    ["| Coverage | Changed lines >= 80% covered | x | task end |"],
  );
  assert.deepEqual(rules(loosened), ["threshold-loosened"]);
  assert.deepEqual(rules(raised), ["threshold-loosened"]);
  assert.deepEqual(rules(tightened), []);
});

test("flags a removed rule and a new exception, but not a removed exception", () => {
  assert.deepEqual(rules(fileDiff("CONSTRAINTS.md", [], ["- No secrets in source: gitleaks"])), ["rule-removed"]);
  assert.deepEqual(rules(fileDiff("CONSTRAINTS.md", ["| W9 | arch | x | y | @dev | 2027-01-01 |"])), ["new-exception"]);
  assert.deepEqual(rules(fileDiff("CONSTRAINTS.md", [], ["| W9 | arch | x | y | @dev | 2027-01-01 |"])), []);
});

test("flags a violation added to the dependency-cruiser baseline", () => {
  const diff = fileDiff(".dependency-cruiser-known-violations.json", ['    "from": "packages/core/src/a.ts",']);
  assert.deepEqual(rules(diff), ["baseline-grown"]);
});

test("flags a path added to .constraintsignore, but not a comment", () => {
  assert.deepEqual(rules(fileDiff(".constraintsignore", ["# why", "packages/core/src/**"])), ["ignore-grown"]);
});

test("the change that first adds CONSTRAINTS.md may bring its exceptions and baseline", () => {
  const constraints = [
    "diff --git a/CONSTRAINTS.md b/CONSTRAINTS.md",
    "--- /dev/null",
    "+++ b/CONSTRAINTS.md",
    "@@ -0,0 +1 @@",
    "+| W1 | arch | x | y | @dev | 2027-01-01 |",
  ].join("\n");
  const baseline = fileDiff(".dependency-cruiser-known-violations.json", ['    "from": "packages/core/src/a.ts",']);
  assert.deepEqual(rules(constraints + "\n" + baseline), []);
});

test("flags an exception whose expiry was pushed out", () => {
  const diff = fileDiff(
    "CONSTRAINTS.md",
    ["| W1 | arch | x | y | @dev | 2027-06-01 |"],
    ["| W1 | arch | x | y | @dev | 2027-01-01 |"],
  );
  assert.deepEqual(rules(diff), ["exception-changed"]);
});

test("ignoreMatcher exempts the listed globs only", () => {
  const ignored = ignoreMatcher(["# comment", "scripts/floor-guard.ts", "scripts/tests/**"]);
  assert.equal(ignored("scripts/floor-guard.ts"), true);
  assert.equal(ignored("scripts/tests/a/b.test.ts"), true);
  assert.equal(ignored("scripts/hygiene.ts"), false);
});

test("main returns 0 clean, 1 on a violation and 2 without a merge base, in process", () => {
  const dir = mkdtempSync(join(tmpdir(), "floor-guard-main-"));
  const cwd = process.cwd();
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "core.autocrlf", "false");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    process.chdir(dir);
    assert.equal(main(["--base", "main"]), 0);
    writeFileSync(join(dir, "a.ts"), "export const a = 1; // eslint-disable-line\n");
    writeFileSync(join(dir, "CONSTRAINTS.md"), "- Removed rule: x\n");
    git(dir, "add", "CONSTRAINTS.md");
    git(dir, "commit", "-q", "-m", "add constraints");
    writeFileSync(join(dir, "CONSTRAINTS.md"), "\n");
    assert.equal(main(["--base", "main"]), 1);
    assert.equal(main(["--base", "no-such-ref"]), 2);
    assert.equal(main(["--base"]), 2);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function runGuard(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [GUARD, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

test("the command exits 0 clean, 1 on a violation in an untracked file, and 2 without a merge base", () => {
  const dir = mkdtempSync(join(tmpdir(), "floor-guard-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "core.autocrlf", "false");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");

    writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
    assert.equal(runGuard(dir, "--base", "main").status, 0);

    writeFileSync(join(dir, "src", "c.ts"), "// @ts-nocheck\nexport const c = 3;\n");
    const flagged = runGuard(dir, "--base", "main");
    assert.equal(flagged.status, 1);
    assert.match(flagged.out, /silenced-checker\] src\/c\.ts/);

    writeFileSync(join(dir, ".constraintsignore"), "src/c.ts\n");
    const ignoring = runGuard(dir, "--base", "main");
    assert.equal(ignoring.status, 1);
    assert.match(ignoring.out, /ignore-grown\] \.constraintsignore/);
    assert.doesNotMatch(ignoring.out, /silenced-checker/);
    unlinkSync(join(dir, ".constraintsignore"));

    assert.equal(runGuard(dir, "--base", "no-such-ref").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
