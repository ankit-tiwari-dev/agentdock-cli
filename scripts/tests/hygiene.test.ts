import test from "node:test";
import assert from "node:assert/strict";
import {
  findBuildArtifacts,
  findCrlfInIndex,
  findForbiddenNames,
  findLockfileDrift,
  findPackagesWithoutTests,
  findPlanningReferences,
  findUnpinnedActions,
  findUnpinnedImages,
  sha256,
} from "../hygiene.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

test("hygiene - a forbidden word is found in any case and between punctuation, but not inside another word", () => {
  const words = new Set([sha256("zebra")]);
  const pairs = new Set([sha256("blue whale")]);
  assert.equal(findForbiddenNames("a.md", "built with (ZEBRA) tools", words, pairs).length, 1);
  assert.equal(findForbiddenNames("a.md", "the Blue-Whale tracker", words, pairs).length, 1);
  assert.equal(findForbiddenNames("a.md", "zebras and whales", words, pairs).length, 0);
});

test("hygiene - the real name list does not flag ordinary project words", () => {
  assert.deepEqual(findForbiddenNames("a.md", "mission statement, control plane, failure, track"), []);
});

test("hygiene - planning-document references are reported with their line", () => {
  const text = ["fine line", "see " + "§" + "4 for details", "story " + "US-" + "12", "an open " + "question"].join(
    "\n",
  );
  const findings = findPlanningReferences("doc.md", text);
  assert.deepEqual(
    findings.map((f) => f.file),
    ["doc.md:2", "doc.md:3", "doc.md:4"],
  );
  assert.deepEqual(findPlanningReferences("doc.md", "criterion AC-1 and the .ctrlplane/spec.md file"), []);
});

test("hygiene - tracked build output and local state are reported", () => {
  const files = [
    "README.md",
    "agentdock-0.1.0.vsix",
    "packages/core/tsconfig.tsbuildinfo",
    "dist/index.js",
    ".ctrlplane/audit.db",
    ".ctrlplane/blobs/abc.gz",
    ".env",
    ".env.local",
    ".env.example",
    "packages/cli/src/build-info.ts",
  ];
  assert.deepEqual(
    findBuildArtifacts(files).map((f) => f.file),
    [
      "agentdock-0.1.0.vsix",
      "packages/core/tsconfig.tsbuildinfo",
      "dist/index.js",
      ".ctrlplane/audit.db",
      ".ctrlplane/blobs/abc.gz",
      ".env",
      ".env.local",
    ],
  );
});

test("hygiene - workflow actions must be pinned to a full commit SHA", () => {
  const workflow = [
    "steps:",
    `  - uses: actions/checkout@${SHA} # v7.0.1`,
    "  - uses: actions/setup-node@v7",
    `  - uses: github/codeql-action/init@${SHA}`,
    "    uses: some/action@main",
    "  - uses: ./.github/actions/local",
    `  - uses: docker://ghcr.io/x/y@sha256:${"a".repeat(64)}`,
    "  - uses: docker://ghcr.io/x/y:latest",
  ].join("\n");
  assert.deepEqual(
    findUnpinnedActions("ci.yml", workflow).map((f) => f.file),
    ["ci.yml:3", "ci.yml:5", "ci.yml:8"],
  );
});

test("hygiene - every package needs at least one test file", () => {
  const findings = findPackagesWithoutTests([
    { name: "core", testFiles: ["core.test.ts"] },
    { name: "empty", testFiles: [] },
    { name: "helpers-only", testFiles: ["fixtures.ts"] },
  ]);
  assert.deepEqual(
    findings.map((f) => f.file),
    ["packages/empty", "packages/helpers-only"],
  );
});

test("hygiene - the lockfile must list exactly the packages on disk", () => {
  const lockfile = { packages: { "": {}, "packages/core": {}, "packages/gone": {}, "node_modules/x": {} } };
  const details = findLockfileDrift(["core", "new"], lockfile).map((f) => f.detail);
  assert.equal(details.length, 2);
  assert.match(details[0], /packages\/new is missing/);
  assert.match(details[1], /packages\/gone no longer exists/);
});

test("hygiene - files stored with CRLF in the index are reported", () => {
  const listing = [
    "i/lf    w/crlf  attr/text=auto eol=lf \tREADME.md",
    "i/crlf  w/crlf  attr/                 \tbad.ts",
    "i/mixed w/mixed attr/                 \tmixed.ts",
    "i/-text w/-text attr/                 \tlogo.png",
  ].join("\n");
  assert.deepEqual(
    findCrlfInIndex(listing).map((f) => f.file),
    ["bad.ts", "mixed.ts"],
  );
});

test("regression: hygiene - a flow-style `- { uses: ... }` step must be pinned too", () => {
  const workflow = [
    "steps:",
    "  - { uses: actions/checkout@v4 }",
    "  - { name: Setup, uses: 'actions/setup-node@v7', with: { node-version: 24 } }",
    `  - { uses: actions/checkout@${SHA} }`,
  ].join("\n");
  assert.deepEqual(
    findUnpinnedActions("ci.yml", workflow).map((f) => f.detail),
    ["actions/checkout@v4 is not pinned to a commit SHA", "actions/setup-node@v7 is not pinned to a commit SHA"],
  );
});

test("regression: hygiene - an empty *.test.ts file does not count as a test", () => {
  const contents: Record<string, string> = {
    "core/core.test.ts": 'test("works", () => {});',
    "vitest/a.test.ts": 'it("works", () => {});',
    "suite/a.test.ts": 'describe("x", () => {});',
    "empty/empty.test.ts": "",
    "comment/c.test.ts": "// tests go here later\n",
  };
  const findings = findPackagesWithoutTests(
    [
      { name: "core", testFiles: ["core.test.ts"] },
      { name: "vitest", testFiles: ["a.test.ts"] },
      { name: "suite", testFiles: ["a.test.ts"] },
      { name: "empty", testFiles: ["empty.test.ts"] },
      { name: "comment", testFiles: ["c.test.ts"] },
    ],
    (pkg, file) => contents[`${pkg}/${file}`] ?? "",
  );
  assert.deepEqual(
    findings.map((f) => f.file),
    ["packages/empty", "packages/comment"],
  );
});

test("hygiene - every image a Dockerfile pulls is named by digest; an earlier stage or scratch needs none", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const dockerfile = [
    `FROM node:24-bookworm@${digest} AS build`,
    `COPY --from=golang:1.27-bookworm@${digest} /usr/local/go /usr/local/go`,
    "COPY --from=golang:1.27-bookworm /usr/local/go /usr/local/go",
    "COPY --chown=node:node --from=busybox:latest /bin/sh /bin/sh",
    "COPY --from=build /src/out /out",
    "COPY --from=0 /src/out /out",
    "COPY package.json ./",
    "from --platform=linux/amd64 node:latest as tools",
    "FROM tools",
    "FROM scratch",
    "FROM node:24-bookworm",
  ].join("\n");
  assert.deepEqual(
    findUnpinnedImages("Dockerfile", dockerfile).map((f) => `${f.file} ${f.detail}`),
    [
      "Dockerfile:3 golang:1.27-bookworm is not pinned to a digest",
      "Dockerfile:4 busybox:latest is not pinned to a digest",
      "Dockerfile:8 node:latest is not pinned to a digest",
      "Dockerfile:11 node:24-bookworm is not pinned to a digest",
    ],
  );
});
