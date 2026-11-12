import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Finding {
  check: string;
  file: string;
  detail: string;
}

// SHA-256 of names that must never appear in the repo, stored hashed so this file does not contain them.
const FORBIDDEN_WORD_HASHES = new Set([
  "66de86f633ef64cb6fafbed1fff798f156e26ccf3534eb19d13026803348cab1",
  "5296f2991ad56c5f159ec54b85fd64bfa4b04466760948ca218de104e337feed",
  "3f1cc822c04e5a60be7c8142ad8797274a824c9ef0bd8b8175c77c639463cdaa",
  "36acdaacc4dfbe52037330a07b73169f848750c94c51d927c2943ae7e69d50d0",
  "ee8b0b1a6855e94df36492e9d05962d9d0a3aa75d861b03355e4851e94bc5698",
]);
const FORBIDDEN_PAIR_HASHES = new Set(["2cb9209d05b964e7291fb1ff5ddefd40f1ac9becffda4ba7d2cb29f158754dc9"]);

const PLANNING_REFERENCES: Array<[RegExp, string]> = [
  [/§\s?\d/, "section reference to a planning document"],
  [/\bUS-\d+\b/, "user-story id from a planning document"],
  [/\bopen\s+question\b/i, "planning-document wording"],
  [/\bowner\s+decision\b/i, "planning-document wording"],
  [/code-space[\\/]spec\b/i, "path to the private planning folder"],
];

const ARTIFACT_PATTERNS: RegExp[] = [
  /\.(vsix|tsbuildinfo|db|db-wal|db-shm|log)$/,
  /(^|\/)(node_modules|dist|build)\//,
  /(^|\/)\.ctrlplane\/(blobs\/|daemon\.lock$)/,
  /(^|\/)\.env(\.(?!example$)[^/]+)?$/,
];

const PINNED_ACTION = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;
const PINNED_DOCKER = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function findForbiddenNames(
  file: string,
  text: string,
  wordHashes: Set<string> = FORBIDDEN_WORD_HASHES,
  pairHashes: Set<string> = FORBIDDEN_PAIR_HASHES,
): Finding[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    if (wordHashes.has(sha256(words[i])) || (pair && pairHashes.has(sha256(pair)))) {
      return [{ check: "names", file, detail: "contains a name that must not appear in this repo" }];
    }
  }
  return [];
}

export function findPlanningReferences(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    for (const [pattern, why] of PLANNING_REFERENCES) {
      if (pattern.test(line)) findings.push({ check: "planning-refs", file: `${file}:${index + 1}`, detail: why });
    }
  });
  return findings;
}

export function findBuildArtifacts(files: string[]): Finding[] {
  return files
    .filter((file) => ARTIFACT_PATTERNS.some((pattern) => pattern.test(file)))
    .map((file) => ({ check: "artifacts", file, detail: "build output or local state is tracked" }));
}

export function findUnpinnedActions(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    // Block style `- uses: x` / `  uses: x`, and flow style `- { name: y, uses: x }`.
    const match = /(?:^\s*-?\s*|[{,]\s*)uses:\s*["']?([^"'\s#,}]+)/.exec(line);
    if (!match) return;
    const target = match[1];
    if (target.startsWith("./") || PINNED_ACTION.test(target) || PINNED_DOCKER.test(target)) return;
    findings.push({
      check: "pinned-actions",
      file: `${file}:${index + 1}`,
      detail: `${target} is not pinned to a commit SHA`,
    });
  });
  return findings;
}

const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/**
 * Every image a Dockerfile pulls, through `FROM` or `COPY --from=<image>`, is named by digest, so a rebuilt tag
 * cannot change what is built; Dependabot moves the digest. An earlier stage (by name or number) and `scratch`
 * name no image and pass.
 */
export function findUnpinnedImages(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const stages = new Set<string>(["scratch"]);
  text.split("\n").forEach((line, index) => {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    const copy = /^\s*COPY\s+(?:--\S+\s+)*?--from=(\S+)/i.exec(line);
    const image = from?.[1] ?? copy?.[1];
    if (image === undefined) return;
    const isStage = stages.has(image.toLowerCase()) || (copy !== null && /^\d+$/.test(image));
    if (!isStage && !PINNED_IMAGE.test(image)) {
      findings.push({
        check: "pinned-images",
        file: `${file}:${index + 1}`,
        detail: `${image} is not pinned to a digest`,
      });
    }
    if (from?.[2]) stages.add(from[2].toLowerCase());
  });
  return findings;
}

/** A test file counts only if it declares a test; an empty `*.test.ts` does not. */
const DECLARES_TEST = /\b(?:test|it|describe)\s*\(/;

export function findPackagesWithoutTests(
  packages: Array<{ name: string; testFiles: string[] }>,
  readTestFile?: (pkgName: string, file: string) => string,
): Finding[] {
  return packages
    .filter(
      (pkg) =>
        !pkg.testFiles.some(
          (file) => file.endsWith(".test.ts") && (!readTestFile || DECLARES_TEST.test(readTestFile(pkg.name, file))),
        ),
    )
    .map((pkg) => ({
      check: "tests",
      file: `packages/${pkg.name}`,
      detail: "package has no tests/*.test.ts that declares a test",
    }));
}

export function findLockfileDrift(packageDirs: string[], lockfile: { packages?: Record<string, unknown> }): Finding[] {
  const locked = new Set(Object.keys(lockfile.packages ?? {}).filter((key) => /^packages\/[^/]+$/.test(key)));
  const findings: Finding[] = [];
  for (const dir of packageDirs) {
    if (!locked.has(`packages/${dir}`)) {
      findings.push({
        check: "lockfile",
        file: "package-lock.json",
        detail: `packages/${dir} is missing; run npm install`,
      });
    }
  }
  for (const key of locked) {
    if (!packageDirs.includes(key.slice("packages/".length))) {
      findings.push({
        check: "lockfile",
        file: "package-lock.json",
        detail: `${key} no longer exists; run npm install`,
      });
    }
  }
  return findings;
}

/** `git ls-files --eol` lines whose index copy has CRLF endings. */
export function findCrlfInIndex(eolListing: string): Finding[] {
  return eolListing
    .split("\n")
    .filter((line) => /^i\/(crlf|mixed)\s/.test(line))
    .map((line) => ({
      check: "line-endings",
      file: line.split("\t").pop() ?? line,
      detail: "stored with CRLF line endings",
    }));
}

function runAllChecks(root: string): Finding[] {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Untracked files count too, so a local run catches a problem before it is committed.
  const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  const findings: Finding[] = [...findBuildArtifacts(files), ...findCrlfInIndex(git("ls-files", "--eol"))];

  for (const file of files) {
    if (file === "package-lock.json" || !existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), "utf8");
    findings.push(...findForbiddenNames(file, text), ...findPlanningReferences(file, text));
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(file)) findings.push(...findUnpinnedActions(file, text));
    if (/(^|\/)(Dockerfile|[^/]+\.Dockerfile)$/.test(file)) findings.push(...findUnpinnedImages(file, text));
  }

  const packageDirs = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
    .map((entry) => entry.name);
  findings.push(
    ...findPackagesWithoutTests(
      packageDirs.map((name) => {
        const testDir = join(root, "packages", name, "tests");
        return { name, testFiles: existsSync(testDir) ? readdirSync(testDir) : [] };
      }),
      (name, file) => readFileSync(join(root, "packages", name, "tests", file), "utf8"),
    ),
    ...findLockfileDrift(packageDirs, JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))),
  );
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const findings = runAllChecks(process.cwd());
  for (const finding of findings) process.stderr.write(`[${finding.check}] ${finding.file}: ${finding.detail}\n`);
  process.stdout.write(
    findings.length === 0 ? "hygiene: all checks passed\n" : `hygiene: ${findings.length} problem(s)\n`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}
