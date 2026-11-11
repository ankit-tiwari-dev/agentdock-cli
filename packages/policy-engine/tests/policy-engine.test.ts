import test from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/index.ts";

test("PolicyEngine blocks destructive commands", () => {
  const engine = new PolicyEngine();

  // Test rm -rf
  const res1 = engine.evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "rm -rf /var/data" },
  });
  assert.equal(res1.decision, "DENY");
  assert.ok(res1.reason.includes("Destructive command blocked"));

  // Test chained git push --force
  const res2 = engine.evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "npm test && git push origin main --force" },
  });
  assert.equal(res2.decision, "DENY");
  assert.ok(res2.reason.includes("Destructive command blocked"));
});

test("PolicyEngine blocks sensitive file reads and control plane mutation", () => {
  const engine = new PolicyEngine();

  // Reading .env
  const res1 = engine.evaluate({
    event: "PreToolUse",
    toolName: "Read",
    toolInput: { path: ".env.production" },
  });
  assert.equal(res1.decision, "DENY");
  assert.ok(res1.reason.includes("Security Policy"));

  // Modifying .ctrlplane/policies.yaml
  const res2 = engine.evaluate({
    event: "PreToolUse",
    toolName: "Edit",
    toolInput: { path: ".ctrlplane/policies.yaml" },
  });
  assert.equal(res2.decision, "DENY");
  assert.ok(res2.reason.includes("Access Denied"));
});

test("PolicyEngine protects existing test files while allowing new test files", () => {
  const engine = new PolicyEngine();

  // Modifying an existing test file
  const res1 = engine.evaluate({
    event: "PreToolUse",
    toolName: "Edit",
    toolInput: { path: "tests/auth.test.ts" },
    isExistingFile: true,
  });
  assert.equal(res1.decision, "REQUIRE_MANUAL_APPROVAL");
  assert.ok(res1.reason.includes("Anti-Test-Gaming Policy"));

  // Creating a new test file
  const res2 = engine.evaluate({
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { path: "tests/new-feature.test.ts" },
    isExistingFile: false,
  });
  assert.equal(res2.decision, "ALLOW");
});

test("PolicyEngine allows safe development operations", () => {
  const engine = new PolicyEngine();

  const res = engine.evaluate({
    event: "PreToolUse",
    toolName: "Edit",
    toolInput: { path: "src/services/billing.ts" },
  });
  assert.equal(res.decision, "ALLOW");
});

test("Circuit breaker trips on repeated failures (Loop Breaker)", () => {
  const engine = new PolicyEngine();
  const breaker = engine.getCircuitBreaker();

  // 1st failure
  breaker.recordExecutionResult(false, "SyntaxError: Unexpected token");
  assert.equal(breaker.getState().isTriggered, false);

  // 2nd failure
  breaker.recordExecutionResult(false, "SyntaxError: Unexpected token");
  assert.equal(breaker.getState().isTriggered, false);

  // 3rd failure (Same signature)
  breaker.recordExecutionResult(false, "SyntaxError: Unexpected token");
  assert.equal(breaker.getState().isTriggered, true);

  // Subsequent evaluate call is intercepted by circuit breaker
  const res = engine.evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "npm test" },
  });
  assert.equal(res.decision, "REQUIRE_MANUAL_APPROVAL");
  assert.ok(res.reason.includes("Loop Detected"));
});

test("PolicyEngine evaluates in under 5ms (Performance Benchmark)", () => {
  const engine = new PolicyEngine();
  const call = { event: "PreToolUse" as const, toolName: "Bash", toolInput: { command: "echo 'hello world'" } };

  // The first calls compile regexes and warm the JIT; a hook process pays that once, not per call.
  for (let i = 0; i < 20; i++) engine.evaluate(call);

  const start = performance.now();
  for (let i = 0; i < 200; i++) engine.evaluate(call);
  const avgMs = (performance.now() - start) / 200;

  // 5 ms leaves room for a busy CI runner and still fails on a rule that scans anything expensive.
  assert.ok(avgMs < 5, `Average latency was ${avgMs.toFixed(3)}ms (must be < 5ms)`);
});
