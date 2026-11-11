import test from "node:test";
import assert from "node:assert/strict";
import { parseSpecificationMarkdown, SpecManager } from "../src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Specification parser extracts frontmatter, plan, and criteria", () => {
  const md = `---
title: JWT Authentication
version: 2
status: awaiting_approval
author: alice
---

# JWT Authentication

## Overview
Implement JWT token authentication with rotation.

## Implementation Plan
1. Create user session table
2. Implement /api/login endpoint
3. Implement /api/refresh endpoint

## Acceptance Criteria
- [ ] AC-1: POST /api/login returns status code 200 with JWT tokens
- [ ] AC-2: Access token expires in 15 minutes
- [ ] AC-3: Must not store refresh token in plaintext
- [ ] AC-4: All existing tests remain passing
`;

  const spec = parseSpecificationMarkdown(md);

  assert.equal(spec.title, "JWT Authentication");
  assert.equal(spec.version, 2);
  assert.equal(spec.status, "awaiting_approval");
  assert.equal(spec.plan.length, 3);
  assert.equal(spec.acceptanceCriteria.length, 4);

  // Check categories
  assert.equal(spec.acceptanceCriteria[0].id, "AC-1");
  assert.equal(spec.acceptanceCriteria[0].category, "DETERMINISTIC_TESTABLE");
  assert.equal(spec.acceptanceCriteria[2].category, "NEGATIVE_INVARIANT");

  assert.equal(spec.hash.length, 64);
});

test("SpecManager creates template and records approvals", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ctrlplane-spec-"));
  const manager = new SpecManager(tmpDir);

  // 1. Initialize
  manager.init("User Profile", "Profile management feature");
  assert.equal(manager.exists(), true);

  const spec = manager.load();
  assert.equal(spec.title, "User Profile");
  assert.equal(spec.status, "draft");

  // 2. Approve
  const approved = manager.approve("bob");
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "bob");
  assert.ok(approved.approvedAt);

  rmSync(tmpDir, { recursive: true, force: true });
});
