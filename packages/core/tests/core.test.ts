import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  validateSession,
  createSpecification,
  computeSpecHash,
  createAuditEvent,
} from "../src/index.ts";

test("Session creation produces valid active session", () => {
  const session = createSession({
    agentType: "claude-code",
    projectPath: "/workspace/my-app",
    gitBranch: "feature/auth",
  });

  assert.ok(session.id.startsWith("sess_"));
  assert.equal(session.agentType, "claude-code");
  assert.equal(session.status, "active");
  assert.equal(session.gitBranch, "feature/auth");
  assert.ok(validateSession(session));
});

test("Specification hashing produces deterministic SHA-256", () => {
  const criteria = [
    {
      id: "AC-1",
      rawText: "- [ ] AC-1: Login returns JWT token",
      description: "Login returns JWT token",
      category: "DETERMINISTIC_TESTABLE" as const,
      completed: false,
    },
  ];

  const hash1 = computeSpecHash(
    "Auth Feature",
    "Add JWT auth",
    ["Step 1", "Step 2"],
    criteria
  );

  const hash2 = computeSpecHash(
    "Auth Feature",
    "Add JWT auth",
    ["Step 1", "Step 2"],
    criteria
  );

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64); // SHA-256 hex string

  // Modifying content must change hash
  const hash3 = computeSpecHash(
    "Auth Feature V2",
    "Add JWT auth",
    ["Step 1", "Step 2"],
    criteria
  );
  assert.notEqual(hash1, hash3);
});

test("AuditEvent creation generates unique IDs and timestamps", () => {
  const event1 = createAuditEvent({
    sessionId: "sess_123",
    sequenceNum: 1,
    eventType: "pre_tool",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    policyVerdict: "ALLOW",
  });

  assert.ok(event1.id.startsWith("evt_1_"));
  assert.equal(event1.sequenceNum, 1);
  assert.equal(event1.toolName, "Bash");
  assert.equal(event1.policyVerdict, "ALLOW");
});
