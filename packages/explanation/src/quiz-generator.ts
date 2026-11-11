import type { ComprehensionQuestion } from "../../core/src/index.ts";
import { parseUnifiedDiff } from "../../git-analyzer/src/index.ts";

export function generateSocraticQuiz(rawDiff: string): ComprehensionQuestion[] {
  const fileDiffs = parseUnifiedDiff(rawDiff);
  const questions: ComprehensionQuestion[] = [];

  for (const file of fileDiffs) {
    const isAuth = file.newPath.toLowerCase().includes("auth") || file.newPath.toLowerCase().includes("login");
    const isDb = file.newPath.toLowerCase().includes("db") || file.newPath.toLowerCase().includes("schema");

    if (isAuth && questions.length < 2) {
      questions.push({
        id: `q_${questions.length + 1}`,
        questionText: `In ${file.newPath}, how does the newly introduced authentication logic handle token expiration or replay attacks?`,
        options: [
          "It invalidates the session and revokes the active token.",
          "It ignores the expired token and permits the request anyway.",
          "It silently refreshes without checking cryptographic signature.",
          "It throws a 500 internal server error without logging.",
        ],
        correctOptionIndex: 0,
        explanation: "Secure auth rotation must invalidate old tokens and prevent replay attacks.",
      });
    }

    if (isDb && questions.length < 2) {
      questions.push({
        id: `q_${questions.length + 1}`,
        questionText: `In ${file.newPath}, does the database schema migration support clean down-migrations / rollbacks?`,
        options: [
          "Yes, rollback operations are defined for all created tables/columns.",
          "No, it drops columns destructively without backups.",
          "Migration files are omitted completely.",
        ],
        correctOptionIndex: 0,
        explanation: "Database migrations must provide backward-compatible down migrations.",
      });
    }
  }

  // Fallback generic question if diff is simple
  if (questions.length === 0 && fileDiffs.length > 0) {
    const primaryFile = fileDiffs[0].newPath;
    questions.push({
      id: "q_1",
      questionText: `What is the primary architectural invariant maintained in ${primaryFile}?`,
      options: [
        "Functions return strongly-typed results and handle null/undefined edge cases.",
        "Error handling is omitted to maximize execution speed.",
        "Global state is mutated directly without synchronization.",
      ],
      correctOptionIndex: 0,
      explanation: "Production code must maintain type safety and explicit error boundaries.",
    });
  }

  return questions;
}
