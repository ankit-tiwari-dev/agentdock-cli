import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_RULES, PolicyEngine } from "../src/index.ts";

// I-46 / D-19: the cheap, likely ways round supervision are closed; the rest are documented as limits.

const ROOT = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";

function decide(command: string, root = ROOT) {
  const res = new PolicyEngine(BUILTIN_RULES).evaluate({
    event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command },
    projectRoot: root,
  });
  return { decision: res.decision, rule: res.matchedRuleId ?? "-" };
}

function expectAll(commands: string[], decision: string, rule?: string, root = ROOT) {
  for (const command of commands) {
    const got = decide(command, root);
    assert.equal(got.decision, decision, `${command} -> ${got.decision} (${got.rule})`);
    if (rule) assert.equal(got.rule, rule, command);
  }
}

test("regression: killing the AgentDock daemon by name, pattern or the PID in its lock file is denied", () => {
  expectAll(
    [
      "pkill -f daemon-run",
      "pkill -9 -f 'ctrlplane'",
      "pgrep -f daemon-run | xargs kill",
      "kill -9 $(pgrep -f daemon-run)",
      "kill $(cat .ctrlplane/daemon.lock | jq .pid)",
      "killall -r ctrlplane",
      'taskkill /F /FI "COMMANDLINE eq *daemon-run*"',
      "Get-CimInstance Win32_Process | Where-Object CommandLine -match 'daemon-run' | Stop-Process",
    ],
    "DENY",
    "RULE-BLOCK-AGENT-SELF-TAMPER",
  );
});

test("regression: killing every Node process, which takes the daemon with it, asks the developer first", () => {
  expectAll(
    [
      "pkill node",
      "pkill -9 -x node",
      "killall node",
      "killall -9 nodejs",
      "taskkill /F /IM node.exe",
      "taskkill /im node.exe /t /f",
      "Stop-Process -Name node -Force",
      'powershell -Command "Get-Process node | Stop-Process"',
      "pwsh -c 'Get-Process -Name node | Stop-Process -Force'",
    ],
    "REQUIRE_MANUAL_APPROVAL",
    "RULE-BLOCK-AGENT-SELF-TAMPER",
  );
});

test("regression: killing the daemon by the literal PID in its lock file is denied, other PIDs are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-killpid-"));
  try {
    mkdirSync(join(dir, ".ctrlplane"));
    writeFileSync(join(dir, ".ctrlplane", "daemon.lock"), JSON.stringify({ pid: 4321, ipcTarget: "x" }));
    expectAll(["kill 4321", "kill -9 4321", "taskkill /PID 4321 /F", "Stop-Process -Id 4321"], "DENY", undefined, dir);
    expectAll(["kill 4322", "kill -0 4321", "taskkill /PID 999 /F", "Stop-Process -Id 77"], "ALLOW", undefined, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary process control stays allowed", () => {
  expectAll(
    [
      "pkill -f vite",
      "pkill -f 'node server.js'",
      "killall python3",
      "kill %1",
      "kill 1234",
      "taskkill /IM chrome.exe /F",
      "Stop-Process -Name devserver",
      "Get-Process node",
      "pgrep -f daemon-run",
      "ps aux | grep node",
    ],
    "ALLOW",
  );
});

test("regression: pointing git at another hooks folder is denied like --no-verify", () => {
  expectAll(
    [
      "git config core.hooksPath /dev/null",
      "git config --local core.hooksPath .nohooks",
      "git config --global core.hooksPath x",
      "git config core.hookspath x",
      "git config --unset core.hooksPath",
      "git config set core.hooksPath x",
      "git -c core.hooksPath=/tmp/h commit -m x",
      "git -c CORE.HOOKSPATH=x push",
      "git --config-env=core.hooksPath=HOOKS commit -m x",
    ],
    "DENY",
    "RULE-GIT-NO-VERIFY",
  );
  expectAll(
    [
      "git config core.hooksPath",
      "git config --get core.hooksPath",
      "git config get core.hooksPath",
      "git config user.name x",
      "git -c user.name=x commit -m x",
    ],
    "ALLOW",
  );
});

test("regression: a glob in the last segment of a nested .ctrlplane path is denied", () => {
  expectAll(
    ["rm -rf sub/.ctrl*", "rm -rf packages/app/.ctrl?lane", "mv sub/.ctrlp* /tmp", "rm sub/.ctrl*/audit.db"],
    "DENY",
    "RULE-BLOCK-CTRLPLANE-MUTATION",
  );
  expectAll(["rm -rf sub/build*", "rm -rf sub/.cache*"], "ALLOW");
});
