import type {
  ExplanationReport,
  RiskLevel,
} from "../../core/src/index.ts";
import { computeDiffBlastRadius } from "./blast-radius.ts";
import { auditDependencyChanges } from "./dependency-auditor.ts";
import { generateSocraticQuiz } from "./quiz-generator.ts";
import { parseUnifiedDiff } from "../../git-analyzer/src/index.ts";

export interface ExplainOptions {
  sessionId: string;
  gitCommitSha?: string;
  diffUnified: string;
  generateQuiz?: boolean;
}

export class ExplanationEngine {
  public explain(options: ExplainOptions): ExplanationReport {
    const fileDiffs = parseUnifiedDiff(options.diffUnified);
    const blastRadius = computeDiffBlastRadius(options.diffUnified);
    const dependencyChanges = auditDependencyChanges(options.diffUnified);

    // 1. Calculate Risk Level
    let riskLevel: RiskLevel = "LOW";
    const potentialRisks: string[] = [];

    const touchesAuth = fileDiffs.some((f) =>
      /auth|login|token|jwt|crypto|security/i.test(f.newPath)
    );
    const touchesBilling = fileDiffs.some((f) =>
      /billing|stripe|payment|invoice/i.test(f.newPath)
    );

    if (touchesBilling) {
      riskLevel = "CRITICAL";
      potentialRisks.push("Touches billing and payment gateway integration.");
    } else if (touchesAuth) {
      riskLevel = "HIGH";
      potentialRisks.push("Touches authentication, sessions, or credential validation.");
    } else if (fileDiffs.length > 8) {
      riskLevel = "MEDIUM";
      potentialRisks.push(`Large changeset across ${fileDiffs.length} files.`);
    }

    if (dependencyChanges.length > 0) {
      potentialRisks.push(`Introduced ${dependencyChanges.length} new third-party dependency package(s).`);
    }

    // 2. Generate Socratic Quiz if requested
    const comprehensionQuestions = options.generateQuiz
      ? generateSocraticQuiz(options.diffUnified)
      : undefined;

    const summary = `Modified ${fileDiffs.length} file(s) touching ${blastRadius.length} symbol definition(s). Risk assessed as ${riskLevel}.`;

    return {
      sessionId: options.sessionId,
      gitCommitSha: options.gitCommitSha ?? "HEAD",
      riskLevel,
      summary,
      blastRadius,
      dependencyChanges,
      potentialRisks,
      comprehensionQuestions,
      generatedAt: Date.now(),
    };
  }
}

