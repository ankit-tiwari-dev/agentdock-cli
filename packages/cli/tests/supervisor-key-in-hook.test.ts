import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/commands/hook-cmd.ts";
import { StorageEngine } from "../../storage/src/index.ts";

test("regression: a recorded Bash command piping Anthropic- and OpenAI-format keys into set-key --stdin is stored in audit.db masked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-keyhook-"));
  mkdirSync(join(dir, ".ctrlplane"), { recursive: true });
  const prev = { ci: process.env.CI, mode: process.env.CTRLPLANE_MODE, home: process.env.CTRLPLANE_HOME };
  delete process.env.CI;
  delete process.env.CTRLPLANE_MODE;
  process.env.CTRLPLANE_HOME = join(dir, "user-home");
  const keys = [`sk-ant-api03-${randomBytes(24).toString("hex")}`, `sk-proj-${randomBytes(24).toString("hex")}`];
  try {
    for (const [i, key] of keys.entries()) {
      const provider = i === 0 ? "claude" : "openai-compatible";
      const stdin = JSON.stringify({
        session_id: "s",
        cwd: dir,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `echo ${key} | ctrlplane supervisor set-key ${provider} --stdin` },
      });
      await runHook("PreToolUse", stdin, { cwd: dir, agent: "claude-code" });
    }
    const storage = new StorageEngine(join(dir, ".ctrlplane", "audit.db"));
    try {
      assert.equal(storage.listEventsForSession("s").length, 2);
    } finally {
      storage.close();
    }
    // SQLite may still hold the rows in audit.db-wal, so every file is searched.
    const folder = join(dir, ".ctrlplane");
    const raw = readdirSync(folder)
      .map((f) => readFileSync(join(folder, f)).toString("latin1"))
      .join("\n");
    for (const key of keys) assert.equal(raw.includes(key.slice(8, 40)), false, "key found in the audit files");
  } finally {
    for (const [name, value] of Object.entries({ CI: prev.ci, CTRLPLANE_MODE: prev.mode, CTRLPLANE_HOME: prev.home })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
