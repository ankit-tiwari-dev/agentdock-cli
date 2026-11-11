import { fileDiffPath, type FileDiff } from "./diff-parser.ts";
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
  /\bassert\s*[.(]/i,
  /\bit\s*\(/i,
  /\btest\s*\(/i,
  /\bshould\s*[.(]/i,
  /\bt\.Run\s*\(/i,
  /\bassertEquals\s*\(/i,
  /\bassertTrue\s*\(/i,
  /\bself\.assertEqual\s*\(/i,
  /\bself\.assertTrue\s*\(/i,
  // A matcher on its own line of a chained assertion: `.toBe(4)`, `.not.toEqual(x)`.
  /^\.(?:not\.)?(?:to\w*|resolves|rejects)\b/,
];

/** Added lines that switch tests off or skip their assertions. */
const DISABLING_PATTERNS = [
  // describe.skip( / it.only( / test.skip( ...
  /(?<![.\w])(?:describe|context|suite|it|test|specify)\.(?:skip|only)\b/,
  // Jasmine/Mocha/Jest x- and f- prefixes (not a method call such as `model.fit(`).
  /(?<![.\w])(?:xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/,
  // A bare early return.
  /^return\s*;?$/,
  // A block comment that opens here and does not close on the same line (not a `src/**/*.ts` glob).
  /(^|[\s;{}])\/\*(?![\s\S]*\*\/)/,
];

/**
 * Analyzes a file diff to detect whether existing test assertions were weakened or removed
 */
export function analyzeTestDiff(diff: FileDiff): TestTamperAnalysis {
  const filePath = fileDiffPath(diff);
  const isTest = isTestFile(filePath) || (diff.isRenamed === true && isTestFile(diff.oldPath));

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

  // Renaming a test file to a non-test name hides it from the test runner.
  if (diff.isRenamed && isTestFile(diff.oldPath) && !isTestFile(diff.newPath)) {
    tamperedSnippets.push(`RENAMED_TO_NON_TEST: ${diff.oldPath} -> ${diff.newPath}`);
  }

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") {
        const trimmed = line.content.trim();
        if (DISABLING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
          tamperedSnippets.push(trimmed);
        }
      }
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
      ? `Anti-Test-Gaming Guard: Detected ${tamperedSnippets.length} deleted, weakened or disabled test assertion(s) in existing test file '${filePath}'. Coding agents must fix bugs in source code, not weaken tests.`
      : "Existing test file modified without weakening assertions.",
  };
}
