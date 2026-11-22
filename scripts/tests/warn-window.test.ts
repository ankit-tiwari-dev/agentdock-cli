import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../warn-window.ts";

test("warn-window passes a success through, masks a failure before the date and keeps it after", () => {
  const dir = mkdtempSync(join(tmpdir(), "warn-window-"));
  try {
    const ok = join(dir, "ok.mjs");
    const fail = join(dir, "fail.mjs");
    writeFileSync(ok, "process.exit(0);\n");
    writeFileSync(fail, "process.exit(3);\n");
    assert.equal(main(["2000-01-01", ok]), 0);
    assert.equal(main(["9999-12-31", fail]), 0);
    assert.equal(main(["2000-01-01", fail]), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warn-window rejects a bad date or a missing script", () => {
  assert.equal(main(["soon", "x.ts"]), 2);
  assert.equal(main(["2026-12-05"]), 2);
});

test("regression: warn-window fails a script that does not exist even inside the window", () => {
  assert.equal(main(["9999-12-31", join(tmpdir(), "no-such-gate.mjs")]), 2);
});
