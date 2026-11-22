import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TASK_CHECKS, changedFiles, hasCodeChanges, main, type Deps } from "../agent-check.ts";

function deps(
  statuses: Record<string, number>,
  stdin: Record<string, unknown> = {},
  porcelain: string | null = " M a.ts",
): Deps & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    run: (script) => {
      ran.push(script);
      return Promise.resolve({ status: statuses[script] ?? 0, output: `${script} output` });
    },
    stdin: () => stdin,
    gitStatus: () => porcelain,
  };
}

test("edit mode blocks on a floor violation and only reports a guard that could not run", async () => {
  assert.equal(await main("edit", deps({ "check:floor": 1 })), 2);
  assert.equal(await main("edit", deps({ "check:floor": 2 })), 0);
  assert.equal(await main("edit", deps({})), 0);
});

test("stop mode skips without code changes and after it already blocked once", async () => {
  const noChanges = deps({}, {}, "?? notes.md");
  assert.equal(await main("stop", noChanges), 0);
  assert.deepEqual(noChanges.ran, []);
  const again = deps({ lint: 1 }, { stop_hook_active: true });
  assert.equal(await main("stop", again), 0);
  assert.deepEqual(again.ran, []);
  assert.equal(await main("stop", deps({}, {}, null)), 0);
});

test("stop mode runs every task check and blocks with exit 2 when one fails; task mode exits 1", async () => {
  const failing = deps({ typecheck: 1 });
  assert.equal(await main("stop", failing), 2);
  assert.deepEqual(failing.ran.sort(), TASK_CHECKS.map((c) => c.script).sort());
  assert.equal(await main("task", deps({ "check:arch": 1 })), 1);
  assert.equal(await main("task", deps({})), 0);
});

const SCRIPT = join(import.meta.dirname, "..", "agent-check.ts");

test("changedFiles reads git porcelain, including renames and quoted names", () => {
  const porcelain = [" M packages/core/src/a.ts", "?? docs/new.md", 'R  old.ts -> "new name.ts"'].join("\n");
  assert.deepEqual(changedFiles(porcelain), ["packages/core/src/a.ts", "docs/new.md", "new name.ts"]);
});

test("hasCodeChanges ignores doc-only changes and catches code and CONSTRAINTS.md", () => {
  assert.equal(hasCodeChanges("?? docs/new.md\n M README.md"), false);
  assert.equal(hasCodeChanges(" M scripts/hygiene.ts"), true);
  assert.equal(hasCodeChanges(" M CONSTRAINTS.md"), true);
  assert.equal(hasCodeChanges(""), false);
});

test("the stop hook does nothing when it already blocked once", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "stop"], {
    input: JSON.stringify({ stop_hook_active: true }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("an unknown mode is a usage error", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "nope"], { input: "", encoding: "utf8" });
  assert.equal(r.status, 2);
});
