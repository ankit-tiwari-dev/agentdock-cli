import { ExplanationEngine } from "../../../explanation/src/index.ts";

export function handleExplainCommand(options?: { diffUnified?: string; quiz?: boolean }): string {
  const engine = new ExplanationEngine();
  const diff = options?.diffUnified ?? "";

  const report = engine.explain({
    sessionId: "sess_active",
    diffUnified: diff,
    generateQuiz: options?.quiz ?? true,
  });

  const lines: string[] = [
    "================================================================================",
    "                      CTRLPLANE DELTA EXPLANATION",
    "================================================================================",
    `Summary:    ${report.summary}`,
    `Risk Level: ${report.riskLevel}`,
    "",
    "1. MODIFIED SYMBOLS & BLAST RADIUS:",
  ];

  if (report.blastRadius.length === 0) {
    lines.push("  • No exported function or type mutations detected in diff.");
  } else {
    for (const b of report.blastRadius) {
      lines.push(`  • ${b.symbolName} (${b.filePath})`);
    }
  }

  lines.push("", "2. DEPENDENCY AUDIT:");
  if (report.dependencyChanges.length === 0) {
    lines.push("  • No third-party packages added or modified.");
  } else {
    for (const d of report.dependencyChanges) {
      lines.push(`  ⚠ ${d.packageName}@${d.version} - ${d.securityNote}`);
    }
  }

  if (report.comprehensionQuestions && report.comprehensionQuestions.length > 0) {
    lines.push("", "3. SOCRATIC COMPREHENSION CHECK ('Grill Me' Mode):");
    for (let i = 0; i < report.comprehensionQuestions.length; i++) {
      const q = report.comprehensionQuestions[i];
      lines.push(`  Q${i + 1}: ${q.questionText}`);
      for (let j = 0; j < q.options.length; j++) {
        lines.push(`     [${j + 1}] ${q.options[j]}`);
      }
      lines.push(`     Key takeaway: ${q.explanation}`, "");
    }
  }

  lines.push("================================================================================");
  return lines.join("\n");
}
