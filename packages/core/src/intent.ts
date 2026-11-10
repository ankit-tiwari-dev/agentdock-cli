import { createHash } from "node:crypto";

export type CriterionCategory =
  | "DETERMINISTIC_TESTABLE"
  | "SEMANTIC_BEHAVIORAL"
  | "NEGATIVE_INVARIANT";

export interface AcceptanceCriterion {
  id: string; // e.g. "AC-1"
  rawText: string;
  description: string;
  category: CriterionCategory;
  completed: boolean;
  associatedTestFiles?: string[];
  evidenceNote?: string;
}

export type SpecStatus = "draft" | "awaiting_approval" | "approved" | "superseded";

export interface Specification {
  id: string;
  sessionId?: string;
  version: number;
  title: string;
  overview: string;
  plan: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  hash: string; // SHA-256
  status: SpecStatus;
  approvedBy?: string;
  approvedAt?: number;
  createdAt: number;
}

/**
 * Computes a deterministic SHA-256 hash of normalized specification content
 */
export function computeSpecHash(
  title: string,
  overview: string,
  plan: string[],
  criteria: AcceptanceCriterion[]
): string {
  const normalized = JSON.stringify({
    title: title.trim(),
    overview: overview.trim().replace(/\r\n/g, "\n"),
    plan: plan.map((p) => p.trim()),
    criteria: criteria.map((c) => ({
      id: c.id.trim(),
      description: c.description.trim(),
      category: c.category,
    })),
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function createSpecification(params: {
  id?: string;
  sessionId?: string;
  version?: number;
  title: string;
  overview: string;
  plan: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  status?: SpecStatus;
}): Specification {
  const hash = computeSpecHash(
    params.title,
    params.overview,
    params.plan,
    params.acceptanceCriteria
  );

  return {
    id: params.id ?? `spec_${hash.slice(0, 12)}`,
    sessionId: params.sessionId,
    version: params.version ?? 1,
    title: params.title,
    overview: params.overview,
    plan: params.plan,
    acceptanceCriteria: params.acceptanceCriteria,
    hash,
    status: params.status ?? "draft",
    createdAt: Date.now(),
  };
}

