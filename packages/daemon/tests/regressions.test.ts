import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorDaemon } from "../src/index.ts";

// An empty project per test, so rules never read this repo's branch or config.
const project = () => mkdtempSync(join(tmpdir(), "ctrlplane-daemon-reg-"));

test("regression: events persist for a session the daemon has never seen (no pre-seeded session row)", () => {
  const dir = project();
  const daemon = new SupervisorDaemon({ projectPath: dir, dbPath: ":memory:" });
  daemon.handleHookPayload({ hookEventName: "PreToolUse", sessionId: "fresh", cwd: dir, toolName: "Read", toolInput: { file_path: "a.ts" } });
  daemon.handleHookPayload({ hookEventName: "PostToolUse", sessionId: "fresh", cwd: dir, toolName: "Read", toolResponse: { ok: true } });

  const events = daemon.getStorage().listEventsForSession("fresh");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.eventType), ["pre_tool", "post_tool"]);
  assert.ok(daemon.getStorage().getSession("fresh"));
});

test("regression: Stop and UserPromptSubmit are recorded as themselves, not as post_tool", () => {
  const dir = project();
  const daemon = new SupervisorDaemon({ projectPath: dir, dbPath: ":memory:" });
  daemon.handleHookPayload({ hookEventName: "UserPromptSubmit", sessionId: "s", cwd: dir, prompt: "fix the bug" });
  daemon.handleHookPayload({ hookEventName: "Stop", sessionId: "s", cwd: dir });
  const types = daemon.getStorage().listEventsForSession("s").map((e) => e.eventType);
  assert.deepEqual(types, ["user_prompt", "stop"]);
});

test("regression: repeated identical failures in PostToolUse trip the loop breaker for that session only", () => {
  const dir = project();
  const daemon = new SupervisorDaemon({ projectPath: dir, dbPath: ":memory:" });
  const fail = (sessionId: string) =>
    daemon.handleHookPayload({
      hookEventName: "PostToolUse",
      sessionId,
      cwd: dir,
      toolName: "Bash",
      toolResponse: { exit_code: 1, stderr: "Error: Cannot find module 'x'" },
    });
  fail("a");
  fail("a");
  fail("a");
  const next = daemon.handleHookPayload({ hookEventName: "PreToolUse", sessionId: "a", cwd: dir, toolName: "Bash", toolInput: { command: "npm test" } });
  assert.equal(next.decision, "REQUIRE_MANUAL_APPROVAL");

  const other = daemon.handleHookPayload({ hookEventName: "PreToolUse", sessionId: "b", cwd: dir, toolName: "Bash", toolInput: { command: "npm test" } });
  assert.equal(other.decision, "ALLOW");
});
