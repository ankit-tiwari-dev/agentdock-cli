import type {
  Specification,
  AcceptanceCriterion,
  CriterionCategory,
  SpecStatus,
} from "../../core/src/index.ts";
import { computeSpecHash } from "../../core/src/index.ts";

export interface ParsedSpecResult {
  specification: Specification;
  rawContent: string;
}

/**
 * Parses a markdown specification file into a structured Specification domain object
 */
export function parseSpecificationMarkdown(markdown: string): Specification {
  let title = "Untitled Feature Specification";
  let overview = "";
  let version = 1;
  let status: SpecStatus = "draft";
  let approvedBy: string | undefined;
  let approvedAt: number | undefined;

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
          if (key === "status") status = value as SpecStatus;
          if (key === "approved_by" || key === "author") approvedBy = value;
          if (key === "approved_at") approvedAt = parseInt(value, 10) || undefined;
        }
      }
    }
  }

  // 2. Extract sections by markdown headers
  const plan: string[] = [];
  const criteria: AcceptanceCriterion[] = [];
  const lines = body.split("\n");

  let currentSection: "none" | "overview" | "plan" | "criteria" = "none";
  let overviewLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("# ")) {
      if (title === "Untitled Feature Specification") {
        title = line.replace(/^#\s+/, "").trim();
      }
      currentSection = "overview";
      continue;
    }

    if (line.startsWith("## Implementation Plan") || line.startsWith("## Plan")) {
      currentSection = "plan";
      continue;
    }

    if (line.startsWith("## Acceptance Criteria") || line.startsWith("## Criteria")) {
      currentSection = "criteria";
      continue;
    }

    if (line.startsWith("## ")) {
      currentSection = "overview";
      continue;
    }

    // Process section lines
    if (currentSection === "overview" && line) {
      overviewLines.push(line);
    } else if (currentSection === "plan" && line) {
      const cleanStep = line.replace(/^(?:\d+\.|\-|\*)\s+/, "").trim();
      if (cleanStep) plan.push(cleanStep);
    } else if (currentSection === "criteria" && line) {
      // Check for checklist pattern: - [ ] or - [x]
      const match = line.match(/^-\s+\[([ xX])\]\s*(.*)$/);
      if (match) {
        const completed = match[1].toLowerCase() === "x";
        const rawDescription = match[2].trim();

        // Check for explicit ID: "AC-1: Description" or "AC-01 - Description"
        const idMatch = rawDescription.match(/^([A-Z0-9_\-]+)\s*[:\-]\s*(.*)$/);
        let id = `AC-${criteria.length + 1}`;
        let description = rawDescription;

        if (idMatch) {
          id = idMatch[1];
          description = idMatch[2];
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

  overview = overviewLines.join("\n").trim();
  const hash = computeSpecHash(title, overview, plan, criteria);

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

