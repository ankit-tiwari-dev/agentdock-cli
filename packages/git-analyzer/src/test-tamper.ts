import type { FileDiff } from "./diff-parser.ts";
import { isTestFile } from "./classifier.ts";

export interface TestTamperAnalysis {
  isTestFile: boolean;
  isNewTestFile: boolean;
  isTamperingDetected: boolean;
  tamperedAssertionsCount: number;
  tamperedSnippets: string[];
  explanation: string;
}

const ASSERTION_PATTERNS = [
  /\bexpect\s*\(/i,
  /\bassert\s*[\.(]/i,
  /\bit\s*\(/i,
  /\btest\s*\(/i,
  /\bshould\s*[\.(]/i,
  /\bt\.Run\s*\(/i,
  /\bassertEquals\s*\(/i,
  /\bassertTrue\s*\(/i,
  /\bself\.assertEqual\s*\(/i,
  /\bself\.assertTrue\s*\(/i,
];

/**
 * Analyzes a file diff to detect whether existing test assertions were weakened or removed
 */
export function analyzeTestDiff(diff: FileDiff): TestTamperAnalysis {
  const filePath = diff.newPath || diff.oldPath;
  const isTest = isTestFile(filePath);

  if (!isTest) {
    return {
      isTestFile: false,
      isNewTestFile: false,
      isTamperingDetected: false,
      tamperedAssertionsCount: 0,
      tamperedSnippets: [],
      explanation: "File is not a test suite.",
    };
  }

  // Adding a brand new test file is completely safe and encouraged!
  if (diff.isNewFile) {
    return {
      isTestFile: true,
      isNewTestFile: true,
      isTamperingDetected: false,
      tamperedAssertionsCount: 0,
      tamperedSnippets: [],
      explanation: "New test file created. Safe and allowed.",
    };
  }

  // Deleting an entire test file is flagged as tampering
  if (diff.isDeletedFile) {
    return {
      isTestFile: true,
      isNewTestFile: false,
      isTamperingDetected: true,
      tamperedAssertionsCount: 1,
      tamperedSnippets: [`DELETED_ENTIRE_FILE: ${filePath}`],
      explanation: `Deleting existing test file '${filePath}' is blocked by Anti-Test-Gaming policy.`,
    };
  }

  // Inspect existing test file modifications
  const tamperedSnippets: string[] = [];

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "delete") {
        const trimmed = line.content.trim();
        // Ignore empty lines or comment-only deletion
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) {
          continue;
        }

        const containsAssertion = ASSERTION_PATTERNS.some((pattern) => pattern.test(trimmed));
        if (containsAssertion) {
          tamperedSnippets.push(trimmed);
        }
      }
    }
  }

  const isTampering = tamperedSnippets.length > 0;

  return {
    isTestFile: true,
    isNewTestFile: false,
    isTamperingDetected: isTampering,
    tamperedAssertionsCount: tamperedSnippets.length,
    tamperedSnippets,
    explanation: isTampering
      ? `Anti-Test-Gaming Guard: Detected ${tamperedSnippets.length} deleted or weakened test assertion(s) in existing test file '${filePath}'. Coding agents must fix bugs in source code, not weaken tests.`
      : "Existing test file modified without weakening assertions.",
  };
}

