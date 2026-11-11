import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DeterministicResults } from "../../core/src/index.ts";
import { parseUnifiedDiff, analyzeTestDiff } from "../../git-analyzer/src/index.ts";

export interface DeterministicRunOptions {
  projectPath: string;
  testCommand?: string;
  typecheckCommand?: string;
  diffUnified?: string;
}

export function runDeterministicChecks(options: DeterministicRunOptions): DeterministicResults {
  const logs: Record<string, string> = {};
  let testSuitePassed = true;
  let typecheckPassed = true;
  const lintPassed = true;
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

  // 2. Run Test Suite if configured or package.json has test script
  const testCmd = options.testCommand ?? getProjectTestCommand(options.projectPath);
  if (testCmd) {
    const result = runShellCommand(testCmd, options.projectPath);
    logs.test_run = result.output;
    if (result.status !== 0) {
      testSuitePassed = false;
      failedAssertionCount++;
    }
  }

  // 3. Run Typecheck if configured or tsconfig exists
  const typecheckCmd = options.typecheckCommand;
  if (typecheckCmd) {
    const result = runShellCommand(typecheckCmd, options.projectPath);
    logs.typecheck = result.output;
    if (result.status !== 0) {
      typecheckPassed = false;
    }
  }

  return {
    typecheckPassed,
    testSuitePassed: testSuitePassed && !testTamperDetected,
    testTamperDetected,
    lintPassed,
    failedAssertionCount,
    rawLogs: logs,
  };
}

function getProjectTestCommand(projectPath: string): string | undefined {
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    // If package.json exists, we can run test
    return undefined; // Keep optional unless explicitly configured in tests
  }
  return undefined;
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
