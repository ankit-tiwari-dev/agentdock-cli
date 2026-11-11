import test from "node:test";
import assert from "node:assert/strict";
import {
  PolicyEngine,
  comparablePath,
  isCatastrophicTarget,
  isDiskWipe,
  isForcePush,
  normalizeFsPath,
  parseDuration,
} from "../src/index.ts";

const ROOT = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";

test("regression: ordinary git push and --force-with-lease are allowed, real force pushes are not", () => {
  const engine = new PolicyEngine();
  const allow = [
    "git push origin feat/login",
    "git push -u origin HEAD",
    "git push --force-with-lease origin feat/login",
    "npm install --force",
  ];
  for (const command of allow) {
    const res = engine.evaluate({ event: "PreToolUse", toolName: "Bash", toolInput: { command }, projectRoot: ROOT });
    assert.equal(res.decision, "ALLOW", command);
  }
  const deny = [
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "cd x && git push origin main --force",
  ];
  for (const command of deny) {
    const res = engine.evaluate({ event: "PreToolUse", toolName: "Bash", toolInput: { command }, projectRoot: ROOT });
    assert.equal(res.decision, "DENY", command);
  }
});

test("regression: rm -rf inside the project is allowed, root/home/parent/outside are denied", () => {
  const engine = new PolicyEngine();
  for (const command of ["rm -rf node_modules", "rm -rf ./dist", `rm -rf ${ROOT.replace(/\\/g, "/")}/build`]) {
    const res = engine.evaluate({ event: "PreToolUse", toolName: "Bash", toolInput: { command }, projectRoot: ROOT });
    assert.equal(res.decision, "ALLOW", command);
  }
  for (const command of [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf ..",
    "rm -rf .",
    "rm -fr /etc",
    "rm -rf $HOME/x",
    "rm -rf .git",
  ]) {
    const res = engine.evaluate({ event: "PreToolUse", toolName: "Bash", toolInput: { command }, projectRoot: ROOT });
    assert.equal(res.decision, "DENY", command);
  }
});

test("regression: self-tamper guard matches absolute paths the way Claude Code sends them", () => {
  const engine = new PolicyEngine();
  const abs = `${ROOT}${process.platform === "win32" ? "\\" : "/"}.claude${process.platform === "win32" ? "\\" : "/"}settings.json`;
  const res = engine.evaluate({
    event: "PreToolUse",
    toolName: "Edit",
    toolInput: { file_path: abs },
    projectRoot: ROOT,
  });
  assert.equal(res.decision, "DENY");
  assert.equal(res.matchedRuleId, "RULE-BLOCK-AGENT-SELF-TAMPER");
});

test("regression: rules targeting Bash also apply to other agents' shell tools", () => {
  const engine = new PolicyEngine();
  for (const toolName of ["run_command", "shell", "local_shell", "run_shell_command"]) {
    const res = engine.evaluate({
      event: "PreToolUse",
      toolName,
      toolInput: { command: "git push --force" },
      projectRoot: ROOT,
    });
    assert.equal(res.decision, "DENY", toolName);
  }
  const codex = engine.evaluate({
    event: "PreToolUse",
    toolName: "shell",
    toolInput: { command: ["bash", "-lc", "git reset --hard HEAD~3"] },
    projectRoot: ROOT,
  });
  assert.equal(codex.decision, "DENY");
});

test("regression: shell reads of secret files are blocked; example env files are not", () => {
  const engine = new PolicyEngine();
  const denied = engine.evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "cat .env | head" },
    projectRoot: ROOT,
  });
  assert.equal(denied.decision, "DENY");
  const example = engine.evaluate({
    event: "PreToolUse",
    toolName: "Read",
    toolInput: { file_path: ".env.example" },
    projectRoot: ROOT,
  });
  assert.equal(example.decision, "ALLOW");
});

test("regression: loop breaker does not lock the session forever after 40 calls", () => {
  const engine = new PolicyEngine();
  for (let i = 0; i < 60; i++) {
    const res = engine.evaluate({
      event: "PreToolUse",
      toolName: "Read",
      toolInput: { file_path: `src/f${i}.ts` },
      projectRoot: ROOT,
    });
    assert.equal(res.decision, "ALLOW", `call ${i}`);
  }
});

test("regression: identical calls steer at 3 and ask at 5; a new prompt resets", () => {
  const engine = new PolicyEngine();
  const call = () =>
    engine.evaluate({ event: "PreToolUse", toolName: "Bash", toolInput: { command: "npm test" }, projectRoot: ROOT });
  assert.equal(call().decision, "ALLOW");
  assert.equal(call().decision, "ALLOW");
  assert.equal(call().decision, "INSTRUCT");
  assert.equal(call().decision, "ALLOW");
  assert.equal(call().decision, "REQUIRE_MANUAL_APPROVAL");
  assert.equal(call().decision, "ALLOW");

  call();
  engine.getCircuitBreaker().resetForNewPrompt();
  assert.equal(call().decision, "ALLOW");
  assert.equal(call().decision, "ALLOW");
});

test("regression: a tripped loop breaker interrupts once, then lets the approved call through", () => {
  const engine = new PolicyEngine();
  const breaker = engine.getCircuitBreaker();
  for (let i = 0; i < 3; i++) breaker.recordExecutionResult(false, "TypeError: x is undefined");
  const first = engine.evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "node a.js" },
    projectRoot: ROOT,
  });
  assert.equal(first.decision, "REQUIRE_MANUAL_APPROVAL");
  const second = engine.evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "node b.js" },
    projectRoot: ROOT,
  });
  assert.equal(second.decision, "ALLOW");
});

test("regression: test-file guard checks the disk instead of assuming every file exists", () => {
  const engine = new PolicyEngine();
  const res = engine.evaluate({
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: "tests/brand-new-feature.test.ts" },
    projectRoot: ROOT,
  });
  assert.equal(res.decision, "ALLOW");
});

// A hook has 1500 ms to answer, and these inputs come straight from the agent. Each check below used to
// backtrack quadratically on the input shown; 300 ms leaves room for a slow CI runner.
const LINEAR_BUDGET_MS = 300;
const LONG = 100_000;

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

test("regression: a force-push flag check answers in linear time on a long run of flag letters", () => {
  assert.ok(elapsedMs(() => isForcePush(`git push -${"f".repeat(LONG)}!`)) < LINEAR_BUDGET_MS);
  assert.equal(isForcePush("git push -uf origin main"), true);
  assert.equal(isForcePush("git push -u origin main"), false);
  assert.equal(isForcePush("git push -f1 origin main"), false);
});

test("regression: the disk-wipe check answers in linear time on `dd` followed by many spaces", () => {
  assert.ok(elapsedMs(() => isDiskWipe(`dd ${" ".repeat(LONG)}x`)) < LINEAR_BUDGET_MS);
  assert.equal(isDiskWipe("dd if=/dev/zero of=/dev/sda bs=1M"), true);
  assert.equal(isDiskWipe("dd \n\n of=/dev/sda"), true);
  assert.equal(isDiskWipe("dd if=a\nof=/dev/sda"), false);
  assert.equal(isDiskWipe("dd if=a of=out.img"), false);
});

test("regression: path segment trimming answers in linear time on a long run of spaces", () => {
  assert.ok(elapsedMs(() => normalizeFsPath(`a${" ".repeat(LONG)}x`)) < LINEAR_BUDGET_MS);
  assert.equal(normalizeFsPath(".claude. /settings.json. . "), ".claude/settings.json");
  assert.equal(normalizeFsPath(".env::$DATA"), ".env");
  assert.equal(normalizeFsPath("dir/. ."), "dir/. .");
});

test("regression: duration parsing answers in linear time on a long run of digits", () => {
  assert.ok(elapsedMs(() => parseDuration("9".repeat(LONG))) < LINEAR_BUDGET_MS);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("90 S"), 90_000);
  assert.equal(parseDuration("12x3h"), 3 * 3_600_000);
  assert.equal(parseDuration("soon"), null);
});

// posix.normalize collapses a run of slashes before the trailing-slash trim runs, so the old code was
// already fast here. Kept so the rewritten trim stays fast and keeps its meaning.
test("catastrophic-target and path comparison stay fast on a long run of slashes", () => {
  assert.ok(elapsedMs(() => isCatastrophicTarget(`${"/".repeat(LONG)}x`, ROOT)) < LINEAR_BUDGET_MS);
  assert.ok(elapsedMs(() => isCatastrophicTarget(`${"a/".repeat(LONG / 2)}x`, ROOT)) < LINEAR_BUDGET_MS);
  assert.ok(elapsedMs(() => comparablePath(`/${"/".repeat(LONG)}x`, ROOT)) < LINEAR_BUDGET_MS);
  assert.equal(isCatastrophicTarget("///", ROOT), true);
  assert.equal(isCatastrophicTarget("src/", ROOT), false);
  assert.equal(comparablePath("src/lib///", ROOT), comparablePath("src/lib", ROOT));
});
