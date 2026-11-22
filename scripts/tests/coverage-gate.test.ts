import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLines, main, measure, parseLcov, readThreshold, verdicts } from "../coverage-gate.ts";
import { warnOnly } from "../warn-window.ts";

const LCOV = [
  "SF:packages\\core\\src\\a.ts",
  "DA:1,1",
  "DA:2,0",
  "DA:3,4",
  "end_of_record",
  "SF:packages/core/src/b.ts",
  "DA:10,0",
  "end_of_record",
].join("\n");

const DIFF = [
  "diff --git a/packages/core/src/a.ts b/packages/core/src/a.ts",
  "--- a/packages/core/src/a.ts",
  "+++ b/packages/core/src/a.ts",
  "@@ -1,0 +1,3 @@",
  "+one",
  "+two",
  "+three",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -4,2 +5,1 @@",
  "-gone",
  "+kept",
].join("\n");

test("parseLcov normalizes Windows paths and keeps hit counts", () => {
  const hits = parseLcov(LCOV);
  assert.deepEqual([...hits.keys()], ["packages/core/src/a.ts", "packages/core/src/b.ts"]);
  assert.equal(hits.get("packages/core/src/a.ts")?.get(2), 0);
});

test("addedLines numbers the new side of each hunk", () => {
  const added = addedLines(DIFF);
  assert.deepEqual([...(added.get("packages/core/src/a.ts") ?? [])], [1, 2, 3]);
  assert.deepEqual([...(added.get("README.md") ?? [])], [5]);
});

test("measure counts only executable changed lines and the whole project", () => {
  const r = measure(parseLcov(LCOV), addedLines(DIFF));
  assert.equal(r.changedTotal, 3);
  assert.equal(r.changedCovered, 2);
  assert.deepEqual(r.uncovered, ["packages/core/src/a.ts:2"]);
  assert.equal(r.projectPct, 50);
});

test("verdicts fail below the changed-line minimum and below the project floor less tolerance", () => {
  const r = { changedTotal: 10, changedCovered: 7, uncovered: [], projectPct: 91.7 };
  assert.equal(verdicts(r, 80, 92, 0.5).length, 1);
  assert.equal(verdicts(r, 70, 92.3, 0.5).length, 1);
  assert.equal(verdicts(r, 70, 92.2, 0.5).length, 0);
  assert.equal(verdicts({ changedTotal: 0, changedCovered: 0, uncovered: [], projectPct: 99 }, 80, 92, 0.5).length, 0);
});

test("readThreshold reads the first percentage after a row label", () => {
  const md =
    "| Coverage of changed lines | >= 80% of added executable lines | x |\n| Project line coverage | 92.36% | must not fall |";
  assert.equal(readThreshold(md, "Coverage of changed lines"), 80);
  assert.equal(readThreshold(md, "Project line coverage"), 92.36);
  assert.equal(readThreshold(md, "Missing"), null);
});

test("main reads its thresholds from CONSTRAINTS.md and judges the branch's added lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-gate-"));
  const cwd = process.cwd();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "false");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src", "a.ts"), "a\nb\nc\n");
    const lcov = join(dir, "lcov.info");
    writeFileSync(lcov, "SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n");
    process.chdir(dir);

    assert.equal(main([lcov, "--base", "main"]), 2, "no CONSTRAINTS.md rows");
    const rows = (min: number, project: number) =>
      `| Coverage of changed lines | >= ${min}% | x |\n| Project line coverage | ${project}% | must not fall |\n`;
    writeFileSync(join(dir, "CONSTRAINTS.md"), rows(50, 60));
    assert.equal(main([lcov, "--base", "main"]), 0);
    writeFileSync(join(dir, "CONSTRAINTS.md"), rows(80, 60));
    assert.equal(main([lcov, "--base", "main"]), 1);
    assert.equal(main([lcov, "--base", "no-such-ref"]), 2);
    assert.equal(main([]), 2);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warnOnly holds until the date and blocks from that day on", () => {
  assert.equal(warnOnly("2026-12-05", new Date("2026-12-04T23:00:00Z")), true);
  assert.equal(warnOnly("2026-12-05", new Date("2026-12-05T00:00:00Z")), false);
});
