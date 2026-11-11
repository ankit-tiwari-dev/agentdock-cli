import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "../../core/src/index.ts";
import { digestSession, scanCapabilities } from "../src/index.ts";

function denied(policyReason: string, sequenceNum = 1): AuditEvent {
  return {
    id: `e${sequenceNum}`,
    sessionId: "s1",
    sequenceNum,
    eventType: "pre_tool",
    toolName: "Bash",
    toolInput: { command: "ls" },
    policyVerdict: "DENY",
    policyReason,
    createdAt: sequenceNum,
  };
}

const reasonsOf = (events: AuditEvent[]) => digestSession("s1", events, tmpdir()).interventions.map((i) => i.reason);

test("regression: dropping the rule trailer from a block reason answers in linear time", () => {
  // The digest is built at session start inside the hook's 1500 ms budget, and the reason can quote agent
  // input. 300 ms leaves room for a slow CI runner.
  for (const reason of [`a${" ".repeat(100_000)}x`, `${"(Triggered by".repeat(8_000)}x`]) {
    const start = performance.now();
    digestSession("s1", [denied(reason)], tmpdir());
    assert.ok(performance.now() - start < 300);
  }

  assert.deepEqual(
    reasonsOf([
      denied("Secret file (Triggered by command: 'x')", 1),
      denied("Force push  (Triggered by a\nb)  \n", 2),
      denied("Kept (Triggered by x) and (y)", 3),
      denied("Kept (Triggered by x", 4),
      denied("Twice (Triggered by a) (Triggered by b)", 5),
      denied("(Triggered by everything)", 6),
    ]),
    [
      "Secret file",
      "Force push",
      "Kept (Triggered by x) and (y)",
      "Kept (Triggered by x",
      "Twice (Triggered by a)",
      "",
    ],
  );
});

// Reading a config is now one open file handle instead of a check followed by a read, which closes a
// check-then-use window. The window cannot be hit reliably in a test, so this only pins the behaviour.
test("capability scan skips a missing, unparseable, non-object, oversized or folder-shaped config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-caps-"));
  try {
    const home = join(dir, "home");
    const project = join(dir, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude", "settings.local.json"), { recursive: true });
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));
    writeFileSync(join(project, ".claude", "settings.json"), "{ not json");
    writeFileSync(join(home, ".claude", "settings.json"), "[1, 2]");
    // Valid JSON just past the 20 MB cap: skipped for its size, not for its content.
    writeFileSync(join(home, ".claude.json"), `{"mcpServers":{"huge":{}}}${" ".repeat(20 * 1024 * 1024)}`);

    const found = scanCapabilities(project, home).map((c) => `${c.kind}:${c.name}:${c.source}`);
    assert.deepEqual(found, ["mcp:github:.mcp.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
