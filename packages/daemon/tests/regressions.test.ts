import test from "node:test";
import assert from "node:assert/strict";
import { SupervisorDaemon } from "../src/index.ts";

test("regression: events persist for a session the daemon has never seen (no pre-seeded session row)", () => {
  const daemon = new SupervisorDaemon({ projectPath: process.cwd(), dbPath: ":memory:" });
  daemon.handleHookPayload({ hookEventName: "PreToolUse", sessionId: "fresh", cwd: process.cwd(), toolName: "Read", toolInput: { file_path: "a.ts" } });
  daemon.handleHookPayload({ hookEventName: "PostToolUse", sessionId: "fresh", cwd: process.cwd(), toolName: "Read", toolResponse: { ok: true } });

  const events = daemon.getStorage().listEventsForSession("fresh");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.eventType), ["pre_tool", "post_tool"]);
  assert.ok(daemon.getStorage().getSession("fresh"));
});

test("regression: Stop and UserPromptSubmit are recorded as themselves, not as post_tool", () => {
  const daemon = new SupervisorDaemon({ projectPath: process.cwd(), dbPath: ":memory:" });
  daemon.handleHookPayload({ hookEventName: "UserPromptSubmit", sessionId: "s", cwd: process.cwd(), prompt: "fix the bug" });
  daemon.handleHookPayload({ hookEventName: "Stop", sessionId: "s", cwd: process.cwd() });
  const types = daemon.getStorage().listEventsForSession("s").map((e) => e.eventType);
  assert.deepEqual(types, ["user_prompt", "stop"]);
});

test("regression: repeated identical failures in PostToolUse trip the loop breaker for that session only", () => {
  const daemon = new SupervisorDaemon({ projectPath: process.cwd(), dbPath: ":memory:" });
  const fail = (sessionId: string) =>
    daemon.handleHookPayload({
      hookEventName: "PostToolUse",
      sessionId,
      cwd: process.cwd(),
      toolName: "Bash",
      toolResponse: { exit_code: 1, stderr: "Error: Cannot find module 'x'" },
    });
  fail("a");
  fail("a");
  fail("a");
  const next = daemon.handleHookPayload({ hookEventName: "PreToolUse", sessionId: "a", cwd: process.cwd(), toolName: "Bash", toolInput: { command: "npm test" } });
  assert.equal(next.decision, "REQUIRE_MANUAL_APPROVAL");

  const other = daemon.handleHookPayload({ hookEventName: "PreToolUse", sessionId: "b", cwd: process.cwd(), toolName: "Bash", toolInput: { command: "npm test" } });
  assert.equal(other.decision, "ALLOW");
});
