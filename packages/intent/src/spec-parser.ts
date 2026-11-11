import type { Specification, AcceptanceCriterion, CriterionCategory, SpecStatus } from "../../core/src/index.ts";
import { computeSpecHash } from "../../core/src/index.ts";

export interface ParsedSpecResult {
  specification: Specification;
  rawContent: string;
}

/** The line breaks `.` does not match. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * What a regex tail `\s*(.*)$` would capture from `rest`: the text after its leading whitespace, or null when
 * a line break is still left in it. Done by hand because that tail backtracks quadratically on a long run of
 * spaces followed by a line break.
 */
function restOfLine(rest: string): string | null {
  const text = rest.trimStart();
  return LINE_BREAK.test(text) ? null : text;
}

/**
 * Parses a markdown specification file into a structured Specification domain object
 */
export function parseSpecificationMarkdown(markdown: string): Specification {
  let title = "Untitled Feature Specification";
  let version = 1;
  let status: SpecStatus = "draft";
  let approvedBy: string | undefined;
  let approvedAt: number | undefined;
  let approvedHash: string | undefined;

  // An editor may save the file with a byte-order mark, which would hide the frontmatter.
  if (markdown.charCodeAt(0) === 0xfeff) markdown = markdown.slice(1);
  let body = markdown;

  // 1. Extract YAML frontmatter if present
  if (markdown.startsWith("---")) {
    const endFrontmatterIndex = markdown.indexOf("\n---", 3);
    if (endFrontmatterIndex !== -1) {
      const frontmatter = markdown.slice(3, endFrontmatterIndex);
      body = markdown.slice(endFrontmatterIndex + 4);

      for (const line of frontmatter.split("\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex !== -1) {
          const key = line.slice(0, colonIndex).trim().toLowerCase();
          const value = line.slice(colonIndex + 1).trim();

          if (key === "title") title = value;
          if (key === "version") version = parseInt(value, 10) || 1;
          if (key === "status") status = value.toLowerCase() as SpecStatus;
          if (key === "approved_by" || key === "author") approvedBy = value;
          if (key === "approved_at") approvedAt = parseInt(value, 10) || undefined;
          if (key === "approved_hash") approvedHash = value;
        }
      }
    }
  }

  // 2. Extract sections by markdown headers
  const plan: string[] = [];
  const criteria: AcceptanceCriterion[] = [];
  const lines = body.split("\n");

  let currentSection: "none" | "overview" | "plan" | "criteria" = "none";
  const overviewLines: string[] = [];
  /** Opening fence character while inside a fenced code block, where a `#` line is code, not a heading. */
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    const inCode = fence !== null || fenceMatch !== null;
    if (fenceMatch && (fence === null || fenceMatch[1][0] === fence)) fence = fence === null ? fenceMatch[1][0] : null;

    if (!inCode && line.startsWith("# ")) {
      if (title === "Untitled Feature Specification") {
        title = line.replace(/^#\s+/, "").trim();
      }
      currentSection = "overview";
      continue;
    }

    if (!inCode && (line.startsWith("## Implementation Plan") || line.startsWith("## Plan"))) {
      currentSection = "plan";
      continue;
    }

    if (!inCode && (line.startsWith("## Acceptance Criteria") || line.startsWith("## Criteria"))) {
      currentSection = "criteria";
      continue;
    }

    if (!inCode && line.startsWith("## ")) {
      currentSection = "overview";
      continue;
    }

    // Process section lines
    if (currentSection === "overview" && line) {
      overviewLines.push(line);
    } else if (currentSection === "plan" && line) {
      const cleanStep = line.replace(/^(?:\d+\.|-|\*)\s+/, "").trim();
      if (cleanStep) plan.push(cleanStep);
    } else if (currentSection === "criteria" && line) {
      // Checklist item in any list style: "- [ ]", "* [x]", "1. [ ]"
      const match = /^(?:[-*]|\d+\.)\s+\[([ xX])\]/.exec(line);
      const text = match ? restOfLine(line.slice(match[0].length)) : null;
      if (match && text !== null) {
        const completed = match[1].toLowerCase() === "x";
        const rawDescription = text.trim();

        // Explicit ID: "AC-1: Description" or "AC-01 - Description". Only letters-dash-digits counts, so
        // "UI - shows banner" is a description. An item without one is numbered after the loop.
        const idMatch = /^([A-Z]+-\d+)\s*[:-]/.exec(rawDescription);
        const idText = idMatch ? restOfLine(rawDescription.slice(idMatch[0].length)) : null;
        let id = "";
        let description = rawDescription;

        if (idMatch && idText !== null) {
          id = idMatch[1];
          description = idText;
        }

        const category = categorizeCriterion(description);

        criteria.push({
          id,
          rawText: line,
          description,
          category,
          completed,
        });
      }
    }
  }

  // Auto-numbered IDs follow the item's position but skip any ID already used, explicit IDs included.
  const used = new Set(criteria.map((c) => c.id).filter(Boolean));
  criteria.forEach((c, index) => {
    if (c.id) return;
    let n = index + 1;
    while (used.has(`AC-${n}`)) n++;
    c.id = `AC-${n}`;
    used.add(c.id);
  });

  const overview = overviewLines.join("\n").trim();
  const hash = computeSpecHash(title, overview, plan, criteria);

  // Approval covers the content it was given for. A spec edited since (or marked approved by hand, with no
  // approved_hash) is a draft until it is approved again. The status and approved_* lines are not part of the
  // hash, so writing the approval does not invalidate it.
  if (status === "approved" && approvedHash !== hash) status = "draft";

  return {
    id: `spec_${hash.slice(0, 12)}`,
    version,
    title,
    overview,
    plan,
    acceptanceCriteria: criteria,
    hash,
    status,
    approvedBy,
    approvedAt,
    createdAt: Date.now(),
  };
}

function categorizeCriterion(desc: string): CriterionCategory {
  const lower = desc.toLowerCase();
  if (
    lower.includes("must not") ||
    lower.includes("cannot") ||
    lower.includes("forbidden") ||
    lower.includes("never")
  ) {
    return "NEGATIVE_INVARIANT";
  }
  if (
    lower.includes("returns") ||
    lower.includes("status code") ||
    lower.includes("timeout") ||
    lower.includes("exit code") ||
    lower.includes("test") ||
    lower.includes("200") ||
    lower.includes("400") ||
    lower.includes("401") ||
    lower.includes("404") ||
    lower.includes("500")
  ) {
    return "DETERMINISTIC_TESTABLE";
  }
  return "SEMANTIC_BEHAVIORAL";
}
