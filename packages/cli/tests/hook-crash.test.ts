import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/commands/hook-cmd.ts";
import { CRASH_HINT, CRASH_RULE_ID, recordCrashWhilePaused } from "../src/commands/hook-crash.ts";
import { activePause } from "../../core/src/index.ts";
import { StorageEngine } from "../../storage/src/index.ts";

// A key the redactor knows, so a test can prove it never reaches the audit log or stderr.
const PLANTED = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-crash-"));
  mkdirSync(join(dir, ".ctrlplane", "state"), { recursive: true });
  return dir;
}

function pause(dir: string, state: unknown): void {
  writeFileSync(join(dir, ".ctrlplane", "state", "pause.json"), JSON.stringify(state));
}

function stdin(dir: string, event = "PreToolUse"): string {
  return JSON.stringify({
    session_id: "crash-session",
    cwd: dir,
    hook_event_name: event,
    tool_name: "Bash",
    tool_input: { command: `echo ${PLANTED}` },
  });
}

const crash = async () => {
  throw new Error(`boom while judging the call with ${PLANTED}`);
};

async function local<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { ci: process.env.CI, mode: process.env.CTRLPLANE_MODE };
  delete process.env.CI;
  delete process.env.CTRLPLANE_MODE;
  try {
    return await fn();
  } finally {
    if (prev.ci !== undefined) process.env.CI = prev.ci;
    if (prev.mode !== undefined) process.env.CTRLPLANE_MODE = prev.mode;
  }
}

/** Every byte the audit log holds on disk, WAL included, so a secret cannot hide in a file the check skipped. */
function auditBytes(dir: string): string {
  const folder = join(dir, ".ctrlplane");
  return readdirSync(folder)
    .filter((f) => f.startsWith("audit.db"))
    .map((f) => readFileSync(join(folder, f)).toString("latin1"))
    .join("");
}

function events(dir: string) {
  const storage = new StorageEngine(join(dir, ".ctrlplane", "audit.db"));
  try {
    return storage.listEventsForSession("crash-session");
  } finally {
    storage.close();
  }
}

test("regression: a crash while judging PreToolUse denies the call locally, naming the error and the way out (D-18)", async () => {
  const dir = project();
  try {
    const out = await local(() => runHook("PreToolUse", stdin(dir), { cwd: dir, dispatch: crash }));
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr ?? "", /boom while judging the call/);
    assert.ok((out.stderr ?? "").includes(CRASH_HINT), out.stderr);
    assert.ok(!(out.stderr ?? "").includes(PLANTED), "the error text is redacted before it reaches stderr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: while paused, a crash lets the call through and records it as CRASH-WHILE-PAUSED", async () => {
  const dir = project();
  try {
    pause(dir, { firstPausedAt: Date.now() - 1000, until: Date.now() + 60_000 });
    const out = await local(() => runHook("PreToolUse", stdin(dir), { cwd: dir, dispatch: crash }));
    assert.equal(out.exitCode, 0);
    assert.match(out.stderr ?? "", /^\[ctrlplane warning\]/);
    const rows = events(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].policyVerdict, "ALLOW");
    assert.equal(rows[0].ruleId, CRASH_RULE_ID);
    assert.match(rows[0].policyReason ?? "", /Error: boom while judging the call/);
    assert.ok(!auditBytes(dir).includes(PLANTED), "the payload and error are stored redacted");
    assert.ok(!(rows[0].policyReason ?? "").includes(dir), "stack frames carry no absolute paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a malformed or expired pause counts as not paused, so a crash still denies", async () => {
  for (const state of [
    "not json",
    { firstPausedAt: Date.now() - 120_000, until: Date.now() - 60_000 },
    { until: 9e15 },
  ]) {
    const dir = project();
    try {
      if (typeof state === "string") writeFileSync(join(dir, ".ctrlplane", "state", "pause.json"), state);
      else pause(dir, state);
      const out = await local(() => runHook("PreToolUse", stdin(dir), { cwd: dir, dispatch: crash }));
      assert.equal(out.exitCode, 2, JSON.stringify(state));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("regression: reading the pause before anything else does not delete or change the pause file", () => {
  const dir = project();
  try {
    const expired = JSON.stringify({ firstPausedAt: 1, until: 2 });
    writeFileSync(join(dir, ".ctrlplane", "state", "pause.json"), expired);
    assert.equal(activePause(dir), null);
    assert.equal(readFileSync(join(dir, ".ctrlplane", "state", "pause.json"), "utf8"), expired);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash in an event that runs nothing lets it through with a warning", async () => {
  const dir = project();
  try {
    for (const event of ["UserPromptSubmit", "SessionStart", "Stop", "PostToolUse"]) {
      const out = await local(() => runHook(event, stdin(dir, event), { cwd: dir, dispatch: crash }));
      assert.equal(out.exitCode, 0, event);
      assert.match(out.stderr ?? "", /^\[ctrlplane warning\]/, event);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: when the redactor throws, the crash row keeps only tool, size, hash and error type", async () => {
  const dir = project();
  try {
    const broken = () => {
      throw new Error("redactor broke");
    };
    const result = await recordCrashWhilePaused(
      {
        payload: undefined,
        raw: JSON.parse(stdin(dir)) as Record<string, unknown>,
        projectRoot: dir,
        error: new TypeError(`bad ${PLANTED}`),
      },
      { redactObject: broken, redactSecrets: broken },
    );
    assert.equal(result.recorded, true);
    const [row] = events(dir);
    const input = row.toolInput as Record<string, unknown>;
    assert.equal(row.toolName, "Bash");
    assert.equal(typeof input.sha256, "string");
    assert.equal(typeof input.bytes, "number");
    assert.match(row.policyReason ?? "", /TypeError/);
    assert.ok(!JSON.stringify(row).includes(PLANTED));
    assert.ok(!auditBytes(dir).includes(PLANTED));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: when the crash row cannot be written, one stderr line says so, without the secret", async () => {
  const dir = project();
  try {
    const result = await recordCrashWhilePaused(
      {
        payload: undefined,
        raw: JSON.parse(stdin(dir)) as Record<string, unknown>,
        projectRoot: dir,
        error: new Error(`bad ${PLANTED}`),
      },
      {
        writeRow: () => Promise.reject(new Error("disk full")),
      },
    );
    assert.equal(result.recorded, false);
    assert.match(result.stderr ?? "", /Bash/);
    assert.ok(!(result.stderr ?? "").includes(PLANTED));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
