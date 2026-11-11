import test from "node:test";
import assert from "node:assert/strict";
import { parseSpecificationMarkdown, SpecManager } from "../src/index.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("regression: an acceptance criterion edited after approval makes the spec a draft again", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ctrlplane-spec-"));
  try {
    const manager = new SpecManager(tmpDir);
    manager.init("Login");
    const approved = manager.approve("dev");
    const saved = readFileSync(manager.getSpecPath(), "utf8");
    assert.equal(manager.load().status, "approved", "writing the approval does not invalidate it");
    assert.equal(manager.load().hash, approved.hash);

    writeFileSync(
      manager.getSpecPath(),
      saved.replace("AC-4: Existing tests remain intact and unmodified.", "AC-4: Agent may delete failing tests."),
    );
    assert.equal(manager.load().status, "draft");
    assert.match(saved, new RegExp(`^approved_hash: ${approved.hash}$`, "m"));

    manager.approve("dev");
    assert.equal(manager.load().status, "approved", "approving again records the new content");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("regression: approving a spec without frontmatter writes it, and Approved, a BOM and CRLF are read", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ctrlplane-spec-"));
  try {
    const manager = new SpecManager(tmpDir);
    manager.init();
    writeFileSync(manager.getSpecPath(), "# T\n\n## Acceptance Criteria\n- [ ] works\n");
    assert.equal(manager.approve().status, "approved");
    assert.equal(manager.load().status, "approved");
    assert.equal(manager.load().title, "T");

    writeFileSync(
      manager.getSpecPath(),
      "---\r\ntitle: T\r\nstatus: draft\r\n---\r\n# T\r\n## Criteria\r\n- [ ] works\r\n",
    );
    manager.approve();
    assert.equal(manager.load().status, "approved", "CRLF spec");

    const body = "# T\n## Acceptance Criteria\n- [ ] works\n";
    const { hash } = parseSpecificationMarkdown(body);
    const fm = (status: string) => `---\ntitle: T\nstatus: ${status}\napproved_hash: ${hash}\n---\n${body}`;
    assert.equal(parseSpecificationMarkdown(fm("Approved")).status, "approved");
    const withBom = parseSpecificationMarkdown(`\uFEFF${fm("approved")}`);
    assert.equal(withBom.status, "approved");
    assert.equal(withBom.title, "T");
    assert.equal(parseSpecificationMarkdown(fm("approved").replace(hash, "0".repeat(64))).status, "draft");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("regression: * and 1. checklist items count, fenced # lines are not headings, IDs never collide", () => {
  const md = [
    "---",
    "title: T",
    "status: draft",
    "---",
    "# T",
    "## Acceptance Criteria",
    "- [ ] first thing",
    "- [ ] AC-1: second thing",
    "* [ ] star bullet",
    "1. [x] numbered",
    "- [ ] UI - shows banner",
    "- [ ] UI - hides banner",
    "```bash",
    "# run the suite",
    "npm test",
    "```",
    "- [ ] after code block",
    "",
  ].join("\n");
  const spec = parseSpecificationMarkdown(md);
  assert.deepEqual(
    spec.acceptanceCriteria.map((c) => [c.id, c.description, c.completed]),
    [
      ["AC-2", "first thing", false],
      ["AC-1", "second thing", false],
      ["AC-3", "star bullet", false],
      ["AC-4", "numbered", true],
      ["AC-5", "UI - shows banner", false],
      ["AC-6", "UI - hides banner", false],
      ["AC-7", "after code block", false],
    ],
  );
  assert.equal(spec.overview, "");
});

// Spec text is written by whoever edits the repo, agents included, and is parsed inside the hook's 1500 ms
// budget. 300 ms leaves room for a slow CI runner.
const LINEAR_BUDGET_MS = 300;
const LONG = 100_000;

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

test("regression: a checklist line with a long run of spaces before a line break parses in linear time", () => {
  const md = `## Acceptance Criteria\n- [ ]${" ".repeat(LONG)}x\ry\n`;
  assert.ok(elapsedMs(() => parseSpecificationMarkdown(md)) < LINEAR_BUDGET_MS);

  const parsed = parseSpecificationMarkdown(
    [
      "## Acceptance Criteria",
      "- [ ]   Login works  ",
      "* [x] AC-7 :  Logout works",
      "1. [X]\u2028AC-8 - Session expires",
      "- [ ] broken\rline",
      "- [ ] AC-9: split\u2028line",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.acceptanceCriteria.map((c) => [c.id, c.description, c.completed]),
    [
      ["AC-1", "Login works", false],
      ["AC-7", "Logout works", true],
      ["AC-8", "Session expires", true],
    ],
  );
});

// The ID check only ever sees text the checklist match already trimmed and cut at the line end, so the old
// code was already fast here. Kept so the rewrite stays fast and keeps its meaning.
test("criterion IDs stay fast on a long run of spaces after the ID", () => {
  const md = `## Acceptance Criteria\n- [ ] A-9-${" ".repeat(LONG)}x\n- [ ] A-9${" ".repeat(LONG)}x\n`;
  assert.ok(elapsedMs(() => parseSpecificationMarkdown(md)) < LINEAR_BUDGET_MS);
  const parsed = parseSpecificationMarkdown(
    "## Criteria\n- [ ] AC-2 - - dashed\n- [ ] UI - shows banner\n- [ ] AB-3:\n",
  );
  assert.deepEqual(
    parsed.acceptanceCriteria.map((c) => [c.id, c.description]),
    [
      ["AC-2", "- dashed"],
      ["AC-3", "UI - shows banner"],
      ["AB-3", ""],
    ],
  );
});
