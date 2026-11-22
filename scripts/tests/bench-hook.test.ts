import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, readThresholdMs } from "../bench-stats.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runBench } from "../bench-hook.ts";

test("percentile uses the nearest rank", () => {
  const sample = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(sample, 50), 10);
  assert.equal(percentile(sample, 95), 19);
  assert.equal(percentile([7], 95), 7);
  assert.throws(() => percentile([], 50));
});

test("readThresholdMs reads 'at most <n> ms' from the named row only", () => {
  const md = "| Hook latency, no daemon | p95 at most 640 ms | x |\n| Other | at most 5 ms | y |";
  assert.equal(readThresholdMs(md, "Hook latency, no daemon"), 640);
  assert.equal(readThresholdMs(md, "Missing"), null);
});

test("runBench runs the real hook and returns one time per run", () => {
  const times = runBench(5);
  assert.equal(times.length, 5);
  assert.ok(times.every((t) => t > 0));
});

test("main --check fails over the CONSTRAINTS.md budget, and cannot run without the row", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-hook-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(main(["--runs", "2"]), 2);
    assert.equal(main(["--runs", "5", "--check"]), 2);
    writeFileSync(join(dir, "CONSTRAINTS.md"), "| Hook latency, no daemon | p95 at most 1 ms | x |\n");
    assert.equal(main(["--runs", "5", "--check"]), 1);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
