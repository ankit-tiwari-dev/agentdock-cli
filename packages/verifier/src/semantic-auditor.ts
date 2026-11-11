import type { AcceptanceCriterion, CriterionFinding, CodeEvidence } from "../../core/src/index.ts";
import { parseUnifiedDiff, isTestFile, type FileDiff, type DiffLine } from "../../git-analyzer/src/index.ts";

export interface SemanticAuditContext {
  criteria: AcceptanceCriterion[];
  diffUnified?: string;
  testSuitePassed: boolean;
  /** False when no test command ran; a criterion is then never DETERMINISTIC_PASS. */
  testSuiteRan: boolean;
}

/** Docs describe intent, they do not implement it. */
function isDocFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)docs?\//.test(p) || /\.(md|mdx|markdown|rst|adoc|txt)$/.test(p);
}

/** A line that says the work is not done is not evidence that it is. */
const NOT_DONE = /\b(todo|fixme|xxx)\b|\bnot\s+(yet\s+)?(done|implemented)\b/i;

/** Evidence comes only from added lines in source files: not tests, docs, deleted files or TODO lines. */
function evidenceLines(file: FileDiff, lines: DiffLine[]): DiffLine[] {
  if (file.isDeletedFile || file.newPath === "/dev/null") return [];
  if (isTestFile(file.newPath) || isDocFile(file.newPath)) return [];
  return lines.filter((l) => l.type === "add" && !NOT_DONE.test(l.content));
}

export function auditCriteriaAgainstEvidence(context: SemanticAuditContext): CriterionFinding[] {
  const fileDiffs = context.diffUnified ? parseUnifiedDiff(context.diffUnified) : [];
  const findings: CriterionFinding[] = [];

  for (const criterion of context.criteria) {
    // 1. If the test suite ran and failed and criterion is deterministic testable, fail it
    if (criterion.category === "DETERMINISTIC_TESTABLE" && context.testSuiteRan && !context.testSuitePassed) {
      findings.push({
        criterionId: criterion.id,
        verdict: "DISCREPANCY",
        tier: "deterministic",
        rationale: "Automated test suite failed to pass assertions for this testable criterion.",
      });
      continue;
    }

    // 2. Search for code evidence matching the criterion in modified files
    const evidence = findCodeEvidenceForCriterion(criterion, fileDiffs);

    if (evidence) {
      findings.push({
        criterionId: criterion.id,
        verdict: "SEMANTIC_VERIFIED",
        tier: "semantic",
        evidence,
        rationale: `Evidence verified in ${evidence.filePath}:${evidence.lineStart}-${evidence.lineEnd}`,
      });
    } else {
      // If a test run actually happened and passed and it's a testable criterion without specific line evidence
      if (
        criterion.category === "DETERMINISTIC_TESTABLE" &&
        context.testSuiteRan &&
        context.testSuitePassed &&
        fileDiffs.length > 0
      ) {
        findings.push({
          criterionId: criterion.id,
          verdict: "DETERMINISTIC_PASS",
          tier: "deterministic",
          rationale: "Verified by passing test suite execution.",
        });
      } else {
        // No evidence found in diff
        findings.push({
          criterionId: criterion.id,
          verdict: "UNCHECKED",
          tier: "semantic",
          rationale: "No matching code changes or tests found in the active diff for this requirement.",
        });
      }
    }
  }

  return findings;
}

function findCodeEvidenceForCriterion(criterion: AcceptanceCriterion, fileDiffs: FileDiff[]): CodeEvidence | undefined {
  const keywords = criterion.description
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["returns", "should", "must", "with", "from", "that"].includes(w));

  if (keywords.length === 0) return undefined;

  for (const file of fileDiffs) {
    for (const hunk of file.hunks) {
      const added = evidenceLines(file, hunk.lines);
      // Check individual added lines
      for (const line of added) {
        if (line.type === "add") {
          const contentLower = line.content.toLowerCase();

          // Direct match if line defines function/class with keyword
          for (const kw of keywords) {
            if (
              contentLower.includes(`function ${kw}`) ||
              contentLower.includes(`class ${kw}`) ||
              contentLower.includes(`const ${kw}`) ||
              contentLower.includes(`let ${kw}`) ||
              contentLower.includes(`def ${kw}`) ||
              contentLower.includes(`"${kw}"`) ||
              contentLower.includes(`'${kw}'`)
            ) {
              return {
                filePath: file.newPath,
                lineStart: line.newLineNumber ?? hunk.newStart,
                lineEnd: (line.newLineNumber ?? hunk.newStart) + 1,
                codeSnippet: line.content.trim(),
              };
            }
          }

          const matchCount = keywords.filter((kw) => contentLower.includes(kw)).length;
          if (matchCount >= 2) {
            return {
              filePath: file.newPath,
              lineStart: line.newLineNumber ?? hunk.newStart,
              lineEnd: (line.newLineNumber ?? hunk.newStart) + 1,
              codeSnippet: line.content.trim(),
            };
          }
        }
      }

      // Check across entire hunk
      const addedText = added.map((l) => l.content.toLowerCase()).join(" ");

      const hunkMatchCount = keywords.filter((kw) => addedText.includes(kw)).length;
      if (added.length > 0 && hunkMatchCount >= Math.min(2, keywords.length)) {
        const firstAdded = added[0];
        return {
          filePath: file.newPath,
          lineStart: firstAdded?.newLineNumber ?? hunk.newStart,
          lineEnd: hunk.newStart + hunk.newLines,
          codeSnippet: firstAdded?.content.trim(),
        };
      }
    }
  }

  return undefined;
}
