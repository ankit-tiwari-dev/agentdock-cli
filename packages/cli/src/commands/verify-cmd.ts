import { VerifierEngine } from "../../../verifier/src/index.ts";
import { SpecManager } from "../../../intent/src/index.ts";
import { StorageEngine } from "../../../storage/src/index.ts";
import { join } from "node:path";

export function handleVerifyCommand(options?: {
  projectPath?: string;
  diffUnified?: string;
  testCommand?: string;
}): string {
  const projectPath = options?.projectPath ?? process.cwd();
  const specManager = new SpecManager(projectPath);
  const spec = specManager.load();

  const verifier = new VerifierEngine();
  const { report, formattedText } = verifier.verify({
    sessionId: "sess_active",
    projectPath,
    spec,
    diffUnified: options?.diffUnified,
    testCommand: options?.testCommand,
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

  return formattedText;
}
