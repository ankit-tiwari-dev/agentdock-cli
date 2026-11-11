import test from "node:test";
import assert from "node:assert/strict";
import { handleInit } from "../src/commands/init.ts";
import { handleSpecCommand } from "../src/commands/spec-cmd.ts";
import { handleVerifyCommand } from "../src/commands/verify-cmd.ts";
import { handleExplainCommand } from "../src/commands/explain-cmd.ts";
import { handleAuditCommand } from "../src/commands/audit-cmd.ts";
import { SupervisorDaemon } from "../../daemon/src/index.ts";
import { dispatchHook } from "../../agent-adapters/src/index.ts";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("FULL E2E INTEGRATION: Init -> Spec -> Supervise -> Block Tamper -> Verify -> Audit", async () => {
  const tmpProject = "./tmp-e2e-project";
  rmSync(tmpProject, { recursive: true, force: true });

  try {
    // 1. Initialize project
    const initRes = handleInit({ projectPath: tmpProject, agent: "claude" });
    assert.equal(initRes.success, true);
    assert.ok(existsSync(join(tmpProject, ".ctrlplane", "spec.md")));
    assert.ok(existsSync(join(tmpProject, ".claude", "settings.local.json")));

    // 2. Manage and approve specification
    const specOutput = handleSpecCommand("approve", ["lead-architect"], tmpProject);
    assert.ok(specOutput.includes("Specification approved by 'lead-architect'"));

    // 3. Start Supervisor Daemon
    const daemon = new SupervisorDaemon({
      projectPath: tmpProject,
      dbPath: join(tmpProject, ".ctrlplane", "audit.db"),
    });
    const endpoint = await daemon.start();
    assert.ok(endpoint.path || endpoint.port);

    // 4. Simulate Agent PreToolUse: Destructive command attack
    const attackRes = await dispatchHook(
      {
        hookEventName: "PreToolUse",
        cwd: tmpProject,
        toolName: "Bash",
        toolInput: { command: "rm -rf /var/lib/data" },
      },
      { projectPath: tmpProject }
    );

    assert.equal(attackRes.exitCode, 2);
    assert.equal(attackRes.decision, "DENY");
    assert.ok(attackRes.stderrMessage?.includes("Destructive command blocked"));

    // 5. Simulate Agent PreToolUse: Safe implementation
    const safeRes = await dispatchHook(
      {
        hookEventName: "PreToolUse",
        cwd: tmpProject,
        toolName: "Write",
        toolInput: {
          path: "src/auth.ts",
          content: "export function login() { return 'jwt_token'; }",
        },
      },
      { projectPath: tmpProject }
    );

    assert.equal(safeRes.exitCode, 0);
    assert.equal(safeRes.decision, "ALLOW");

    // 6. Run Independent Verification
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,3 @@
+export function login() {
+  return 'jwt_token';
+}
`;

    const verifyOutput = handleVerifyCommand({
      projectPath: tmpProject,
      diffUnified: diff,
    });

    assert.ok(verifyOutput.includes("CTRLPLANE VERIFICATION REPORT"));
    assert.ok(verifyOutput.includes("TIER 1: DETERMINISTIC SYSTEM CHECKS"));

    // 7. Run Delta Explanation
    const explainOutput = handleExplainCommand({
      diffUnified: diff,
      quiz: true,
    });

    assert.ok(explainOutput.includes("CTRLPLANE DELTA EXPLANATION"));
    assert.ok(explainOutput.includes("MODIFIED SYMBOLS & BLAST RADIUS"));

    // 8. Query Audit Trail
    const auditList = handleAuditCommand("list", [], tmpProject);
    assert.ok(typeof auditList === "string");

    // 9. Gracefully stop daemon
    await daemon.stop();
  } finally {
    try {
      rmSync(tmpProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignore directory cleanup lock on Windows
    }
  }
});
