import { VerifierEngine } from "../../../verifier/src/index.ts";
import { SpecManager } from "../../../intent/src/index.ts";
import { StorageEngine } from "../../../storage/src/index.ts";
import { parseUnifiedDiff } from "../../../git-analyzer/src/index.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "./policies-cmd.ts";
import { readWorkingTreeDiff } from "./working-diff.ts";

/** Exit code 0 only for PASSED; NEEDS_ATTENTION (including checks that did not run) and FAILED exit 1. */
export function handleVerifyCommand(options?: {
  projectPath?: string;
  diffUnified?: string;
  testCommand?: string;
  typecheckCommand?: string;
  lintCommand?: string;
}): CommandResult {
  const projectPath = options?.projectPath ?? process.cwd();
  const specManager = new SpecManager(projectPath);

  // Check first: SpecManager.load() would create .ctrlplane/spec.md in a folder that has none.
  if (!existsSync(specManager.getSpecPath())) {
    return {
      output: `No spec found, run ctrlplane init (expected ${specManager.getSpecPath()}).`,
      exitCode: 1,
    };
  }
  const spec = specManager.load();

  const fromGit = options?.diffUnified === undefined;
  const diffUnified = fromGit ? readWorkingTreeDiff(projectPath) : options?.diffUnified;

  const verifier = new VerifierEngine();
  const { report, formattedText } = verifier.verify({
    sessionId: "sess_active",
    projectPath,
    spec,
    diffUnified,
    testCommand: options?.testCommand,
    typecheckCommand: options?.typecheckCommand,
    lintCommand: options?.lintCommand,
  });

  // Save report to audit database
  try {
    const dbPath = join(projectPath, ".ctrlplane", "audit.db");
    const storage = new StorageEngine(dbPath);
    storage.insertVerificationRun(report);
    storage.close();
  } catch {
    // Ignore storage write in standalone verify
  }

  const fileCount = diffUnified ? parseUnifiedDiff(diffUnified).length : 0;
  const header: string[] = [
    diffUnified === undefined
      ? "Diff: none (not a git repository, or no commit yet to diff against)."
      : `Diff: ${fileCount} file(s) in the ${fromGit ? "working-tree diff (git diff HEAD)" : "given diff"}.`,
  ];
  if (spec.status !== "approved") {
    header.push(
      `WARNING: the spec is NOT APPROVED (status: ${spec.status}). Run \`ctrlplane spec approve\` before relying on this report.`,
    );
  }

  return {
    output: [...header, formattedText].join("\n"),
    exitCode: report.overallStatus === "PASSED" ? 0 : 1,
  };
}
