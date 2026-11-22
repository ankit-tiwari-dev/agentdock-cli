// Diff-scoped check of the CONSTRAINTS.md floor: flags moves that lower the bar, never moves that raise it.
// Usage: node scripts/floor-guard.ts [--base <ref>]   (default base: origin/main)
// Exit 0 clean, 1 at least one floor violation, 2 the guard could not run (never read a 2 as clean).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: string;
  file: string;
  text: string;
}

interface Line {
  file: string;
  text: string;
}

class GuardError extends Error {}

function git(args: string[], diffExit = false): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: unknown };
    // `git diff --no-index` exits 1 whenever the sides differ, which is the normal case for a new file.
    if (diffExit && e.status === 1 && typeof e.stdout === "string") return e.stdout;
    return null;
  }
}

function must(value: string | null, message: string): string {
  if (value === null) throw new GuardError(message);
  return value;
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_DIR = /(^|\/)tests?\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const isTestFile = (file: string): boolean => TEST_DIR.test(file) || TEST_NAME.test(file);
const CONSTRAINTS_FILE = /(^|\/)CONSTRAINTS\.md$/;
const EXCEPTION_ROW = /^\| *[WE]\d+ *\|/;
// A known-violations baseline is an exception list too: growing it silences the architecture check.
const KNOWN_VIOLATIONS_FILE = /(^|\/)\.dependency-cruiser-known-violations\.json$/;

const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|biome-ignore|istanbul ignore|c8 ignore|v8 ignore|nosemgrep|gitleaks:allow|Stryker disable/;
const STUBS =
  /throw new (Error|NotImplemented\w*)\(.*[Nn]ot [Ii]mplemented|catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|\bTODO\b|\bFIXME\b/;
const SKIPS = /\.(skip|todo|only)\s*\(|\bxit\(|\bxdescribe\(|\b(skip|todo|only)\s*:\s*(true|["'`])|\bt\.skip\(/;
const ASSERTION = /\b(assert|expect|should)\b/;

function pathOf(header: string): string {
  return header.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

export function parseDiff(diff: string): { added: Line[]; removed: Line[]; deleted: string[]; created: string[] } {
  const added: Line[] = [];
  const removed: Line[] = [];
  const deleted: string[] = [];
  const created: string[] = [];
  let file = "";
  let oldFile = "";
  let inHeader = false;
  // `---`/`+++` are headers only between a file's `diff` line and its first hunk; inside a hunk they are content.
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) inHeader = true;
    else if (line.startsWith("@@")) inHeader = false;
    else if (inHeader) {
      if (line.startsWith("--- ")) oldFile = pathOf(line.slice(4));
      else if (line.startsWith("+++ ")) {
        const newFile = pathOf(line.slice(4));
        file = newFile === "/dev/null" ? oldFile : newFile;
        if (newFile === "/dev/null") deleted.push(file);
        if (oldFile === "/dev/null") created.push(file);
      }
    } else if (line.startsWith("+")) added.push({ file, text: line.slice(1).replace(/\r$/, "") });
    else if (line.startsWith("-")) removed.push({ file, text: line.slice(1).replace(/\r$/, "") });
  }
  return { added, removed, deleted, created };
}

function ruleKey(text: string): string | null {
  const s = text.trim();
  if (s.startsWith("|")) {
    const first = s
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)[0];
    if (!first || /^-+$/.test(first)) return null;
    return first;
  }
  // A bullet led by a bold label explains a number; the numbers themselves live in table rows.
  if (/^[-*] \*\*/.test(s)) return null;
  if (/^[-*] /.test(s)) return s.slice(2).split(":")[0].trim();
  return null;
}

const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(?:\|\s*)?(or more|or higher|must not fall|must not drop)/;
const MAX_AFTER = /^\s*\S*\s*(?:\|\s*)?(or less|or lower|must not grow|must not exceed)/;

type Direction = "min" | "max" | null;

function thresholds(text: string): Array<{ n: number; dir: Direction }> {
  const out: Array<{ n: number; dir: Direction }> = [];
  const re = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const dir: Direction =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? "min"
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? "max"
          : null;
    out.push({ n: Number(m[0]), dir });
  }
  return out;
}

function compareRule(before: string, after: string): string | null {
  const was = thresholds(before);
  const now = thresholds(after);
  for (const dir of ["min", "max", null] as Direction[]) {
    const a = was.filter((x) => x.dir === dir);
    const b = now.filter((x) => x.dir === dir);
    for (let i = 0; i < a.length; i++) {
      const n = b[i];
      if (!n) return "threshold-removed";
      if (n.n === a[i].n) continue;
      if (dir === "min" ? n.n < a[i].n : dir === "max" ? n.n > a[i].n : true) {
        return dir ? "threshold-loosened" : "threshold-changed";
      }
    }
  }
  return null;
}

export function ignoreMatcher(patterns: string[]): (file: string) => boolean {
  const regexes = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"))
    .map((p) => {
      const parts = p.split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
      return new RegExp("^" + parts.join(".*") + "$");
    });
  return (file) => regexes.some((r) => r.test(file));
}

export function findFloorViolations(diff: string, ignored: (file: string) => boolean = () => false): Finding[] {
  const { added, removed, deleted, created } = parseDiff(diff);
  const findings: Finding[] = [];
  const flag = (rule: string, file: string, text: string): void => {
    findings.push({ rule, file, text: text.trim().slice(0, 120) });
  };
  // The change that first adds CONSTRAINTS.md sets the bar, so its exceptions and baseline are the starting point.
  const adopting = created.some((f) => CONSTRAINTS_FILE.test(f));

  for (const { file, text } of added) {
    if (ignored(file) && !/(^|\/)\.constraintsignore$/.test(file)) continue;
    if (CODE_FILE.test(file)) {
      if (SUPPRESSIONS.test(text)) flag("silenced-checker", file, text);
      if (STUBS.test(text)) flag("unfinished-work", file, text);
      if (isTestFile(file) && SKIPS.test(text)) flag("test-made-easier", file, text);
    }
    if (adopting) continue;
    if (KNOWN_VIOLATIONS_FILE.test(file) && /"from"\s*:/.test(text)) flag("baseline-grown", file, text);
    if (/(^|\/)\.constraintsignore$/.test(file) && text.trim() && !text.trim().startsWith("#"))
      flag("ignore-grown", file, text);
    if (CONSTRAINTS_FILE.test(file) && EXCEPTION_ROW.test(text.trim())) {
      const replaces = removed.some((r) => r.file === file && ruleKey(r.text) === ruleKey(text));
      if (!replaces) flag("new-exception", file, text);
    }
  }

  for (const file of deleted) {
    if (!ignored(file) && CODE_FILE.test(file) && isTestFile(file)) flag("test-deleted", file, "file deleted");
  }
  // A rewritten assertion removes one line and adds another; only a net loss per test file lowers the bar.
  const isAssertion = (l: Line) =>
    !ignored(l.file) &&
    !deleted.includes(l.file) &&
    CODE_FILE.test(l.file) &&
    isTestFile(l.file) &&
    ASSERTION.test(l.text);
  const addedAssertions = new Map<string, number>();
  for (const l of added.filter(isAssertion)) addedAssertions.set(l.file, (addedAssertions.get(l.file) ?? 0) + 1);
  const removedByFile = new Map<string, Line[]>();
  for (const l of removed.filter(isAssertion)) removedByFile.set(l.file, [...(removedByFile.get(l.file) ?? []), l]);
  for (const [file, lines] of removedByFile) {
    const lost = lines.length - (addedAssertions.get(file) ?? 0);
    for (const l of lines.slice(0, Math.max(0, lost))) flag("assertion-removed", file, l.text);
  }

  const removedRules = removed.filter((l) => CONSTRAINTS_FILE.test(l.file) && ruleKey(l.text) !== null);
  const addedRules = added.filter((l) => CONSTRAINTS_FILE.test(l.file) && ruleKey(l.text) !== null);
  for (const r of removedRules) {
    const a = addedRules.find((x) => x.file === r.file && ruleKey(x.text) === ruleKey(r.text));
    if (!a) {
      // Dropping an exception raises the bar, so it stays silent.
      if (!EXCEPTION_ROW.test(r.text.trim())) flag("rule-removed", r.file, r.text);
      continue;
    }
    if (EXCEPTION_ROW.test(r.text.trim())) {
      flag("exception-changed", r.file, r.text + "  ->  " + a.text);
      continue;
    }
    const verdict = compareRule(r.text, a.text);
    if (verdict) flag(verdict, r.file, r.text + "  ->  " + a.text);
  }
  return findings;
}

export function collectDiff(base: string): string {
  const top = must(git(["rev-parse", "--show-toplevel"]), "not inside a git work tree").trim();
  process.chdir(top);
  const mergeBase = must(
    git(["merge-base", base, "HEAD"]),
    `no merge base against ${base} (in CI, check out with fetch-depth: 0)`,
  ).trim();
  const tracked = must(
    git(["diff", "--unified=0", "--no-color", "--no-ext-diff", mergeBase, "--"]),
    `could not diff against ${mergeBase}`,
  );
  const untrackedList = must(git(["ls-files", "--others", "--exclude-standard"]), "could not list untracked files");
  const untracked = untrackedList
    .split("\n")
    .filter(Boolean)
    .map((f) =>
      must(
        git(["diff", "--no-index", "--unified=0", "--no-color", "/dev/null", f], true),
        `could not diff untracked file ${f}`,
      ),
    );
  return [tracked, ...untracked].join("\n");
}

export interface FloorException {
  id: string;
  rule: string;
  expires: string;
  matches: (file: string) => boolean;
}

/**
 * Rows of the CONSTRAINTS.md Exceptions table whose Rule cell names a floor rule (e.g. `assertion-removed`) and
 * that have not expired. Path holds one or more backticked globs. Adding a row is itself a `new-exception` finding,
 * so an exception always reaches a reviewer.
 */
export function readExceptions(constraints: string, today: Date = new Date()): FloorException[] {
  const day = today.toISOString().slice(0, 10);
  const out: FloorException[] = [];
  for (const line of constraints.split(/\r?\n/)) {
    if (!EXCEPTION_ROW.test(line.trim())) continue;
    const cells = line.split("|").map((c) => c.trim());
    const [id, rule, path] = [cells[1], cells[2].replace(/`/g, ""), cells[3]];
    const expires = cells[cells.length - 2];
    if (!/^[a-z]+(-[a-z]+)+$/.test(rule) || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || expires <= day) continue;
    const globs = [...path.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    out.push({ id, rule, expires, matches: ignoreMatcher(globs) });
  }
  return out;
}

export function main(argv: string[]): number {
  const i = argv.indexOf("--base");
  const base = i > -1 ? argv[i + 1] : "origin/main";
  if (!base) {
    console.error("floor-guard: --base needs a ref");
    return 2;
  }
  let diff: string;
  try {
    diff = collectDiff(base);
  } catch (error) {
    console.error("floor-guard: " + (error instanceof GuardError ? error.message : String(error)));
    return 2;
  }
  const ignored = ignoreMatcher(
    existsSync(".constraintsignore") ? readFileSync(".constraintsignore", "utf8").split(/\r?\n/) : [],
  );
  const exceptions = readExceptions(existsSync("CONSTRAINTS.md") ? readFileSync("CONSTRAINTS.md", "utf8") : "");
  const findings: Finding[] = [];
  for (const f of findFloorViolations(diff, ignored)) {
    const excepted = exceptions.find((e) => e.rule === f.rule && e.matches(f.file));
    if (excepted)
      console.log(`floor-guard: [${f.rule}] ${f.file} excepted by ${excepted.id} until ${excepted.expires}`);
    else findings.push(f);
  }
  if (findings.length === 0) {
    console.log("floor-guard: clean");
    return 0;
  }
  console.error(`floor-guard: ${findings.length} floor violation(s):`);
  for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
  if (findings.some((f) => f.rule === "rule-removed")) {
    console.error(
      "\nrule-removed can also mean a rule's label changed: rename a rule in one commit, change its numbers in another.",
    );
  }
  console.error("\nEach is a move that lowers the bar. Fix the code, or record a tracked exception in CONSTRAINTS.md.");
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
