import { spawnSync } from "node:child_process";
import type { CheckStatus, DeterministicResults } from "../../core/src/index.ts";
import { parseUnifiedDiff, analyzeTestDiff } from "../../git-analyzer/src/index.ts";

export interface DeterministicRunOptions {
  projectPath: string;
  testCommand?: string;
  typecheckCommand?: string;
  lintCommand?: string;
  diffUnified?: string;
}

export function runDeterministicChecks(options: DeterministicRunOptions): DeterministicResults {
  const logs: Record<string, string> = {};
  let testTamperDetected = false;
  let failedAssertionCount = 0;

  // 1. Check for Test Tampering in Diff
  if (options.diffUnified) {
    const fileDiffs = parseUnifiedDiff(options.diffUnified);
    for (const fileDiff of fileDiffs) {
      const tamperAnalysis = analyzeTestDiff(fileDiff);
      if (tamperAnalysis.isTamperingDetected) {
        testTamperDetected = true;
        logs.test_tamper = tamperAnalysis.explanation;
        break;
      }
    }
  }

  // 2-4. Test suite, typecheck and lint run only when their command is given.
  // Without a command a check is NOT_RUN, which never counts as a pass.
  const testSuiteStatus = runCheck(options.testCommand, options.projectPath, logs, "test_run");
  if (testSuiteStatus === "FAIL") failedAssertionCount++;
  const typecheckStatus = runCheck(options.typecheckCommand, options.projectPath, logs, "typecheck");
  const lintStatus = runCheck(options.lintCommand, options.projectPath, logs, "lint");

  return {
    typecheckPassed: typecheckStatus === "PASS",
    testSuitePassed: testSuiteStatus === "PASS" && !testTamperDetected,
    testTamperDetected,
    lintPassed: lintStatus === "PASS",
    typecheckStatus,
    testSuiteStatus,
    lintStatus,
    failedAssertionCount,
    rawLogs: logs,
  };
}

function runCheck(command: string | undefined, cwd: string, logs: Record<string, string>, logKey: string): CheckStatus {
  if (!command) return "NOT_RUN";
  const result = runShellCommand(command, cwd);
  logs[logKey] = result.output;
  return result.status === 0 ? "PASS" : "FAIL";
}

function runShellCommand(command: string, cwd: string): { status: number; output: string } {
  try {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const flag = isWindows ? "/c" : "-c";

    const proc = spawnSync(shell, [flag, command], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
    });

    const output = (proc.stdout || "") + (proc.stderr || "");
    return {
      status: proc.status ?? 1,
      output: output.trim(),
    };
  } catch (err) {
    return {
      status: 1,
      output: String(err),
    };
  }
}
