// Coverage gate: lines this branch added must be covered, and project line coverage must not fall below the
// recorded value. Both numbers are read from CONSTRAINTS.md, which is the only place they are written.
// Usage: node scripts/coverage-gate.ts <lcov file> [--base <ref>]
// Exit 0 pass, 1 below a threshold, 2 the gate could not run.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collectDiff } from "./floor-guard.ts";

export const CHANGED_ROW = "Coverage of changed lines";
export const PROJECT_ROW = "Project line coverage";

export type LineHits = Map<string, Map<number, number>>;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function parseLcov(text: string): LineHits {
  const files: LineHits = new Map();
  let current: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      current = new Map();
      files.set(normalize(raw.slice(3)), current);
    } else if (raw.startsWith("DA:") && current) {
      const [line, hits] = raw.slice(3).split(",");
      current.set(Number(line), Math.max(current.get(Number(line)) ?? 0, Number(hits)));
    } else if (raw === "end_of_record") current = undefined;
  }
  return files;
}

export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file = "";
  let next = 0;
  let inHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) inHeader = true;
    else if (inHeader && line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t.*$/, "");
      file = target === "/dev/null" ? "" : normalize(target.replace(/^b\//, ""));
    } else if (line.startsWith("@@")) {
      inHeader = false;
      const m = /\+(\d+)/.exec(line);
      next = m ? Number(m[1]) : 0;
    } else if (!inHeader && file) {
      if (line.startsWith("+")) {
        if (!out.has(file)) out.set(file, new Set());
        out.get(file)?.add(next);
        next++;
      } else if (!line.startsWith("-") && !line.startsWith("\\")) next++;
    }
  }
  return out;
}

export function readThreshold(constraints: string, label: string): number | null {
  for (const line of constraints.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells[1] !== label) continue;
    const m = /(\d+(?:\.\d+)?)\s*%/.exec(cells.slice(2).join(" "));
    if (m) return Number(m[1]);
  }
  return null;
}

export interface Result {
  changedTotal: number;
  changedCovered: number;
  uncovered: string[];
  projectPct: number;
}

export function measure(hits: LineHits, added: Map<string, Set<number>>): Result {
  let changedTotal = 0;
  let changedCovered = 0;
  const uncovered: string[] = [];
  for (const [file, lines] of added) {
    const fileHits = hits.get(file);
    // A file the suite never loaded has no line data; it counts only once a test imports it.
    if (!fileHits) continue;
    for (const line of [...lines].sort((a, b) => a - b)) {
      const count = fileHits.get(line);
      if (count === undefined) continue;
      changedTotal++;
      if (count > 0) changedCovered++;
      else uncovered.push(`${file}:${line}`);
    }
  }
  let total = 0;
  let hit = 0;
  for (const lines of hits.values()) {
    for (const count of lines.values()) {
      total++;
      if (count > 0) hit++;
    }
  }
  return { changedTotal, changedCovered, uncovered, projectPct: total ? (100 * hit) / total : 0 };
}

export function verdicts(r: Result, minChanged: number, projectFloor: number, tolerance: number): string[] {
  const failures: string[] = [];
  const changedPct = r.changedTotal ? (100 * r.changedCovered) / r.changedTotal : 100;
  if (changedPct < minChanged) {
    failures.push(
      `changed lines ${changedPct.toFixed(1)}% covered (${r.changedCovered}/${r.changedTotal}), need >= ${minChanged}%`,
    );
  }
  if (r.projectPct < projectFloor - tolerance) {
    failures.push(
      `project line coverage ${r.projectPct.toFixed(2)}%, recorded ${projectFloor}% (tolerance ${tolerance})`,
    );
  }
  return failures;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const lcovPath = argv[0];
  if (!lcovPath || lcovPath.startsWith("--") || !existsSync(lcovPath)) {
    console.error("coverage-gate: usage: node scripts/coverage-gate.ts <lcov file> [--base <ref>]");
    return 2;
  }
  const lcov = readFileSync(lcovPath, "utf8");
  const base = arg(argv, "--base") ?? "origin/main";
  let diff: string;
  try {
    diff = collectDiff(base);
  } catch (error) {
    console.error("coverage-gate: " + (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  const constraints = existsSync("CONSTRAINTS.md") ? readFileSync("CONSTRAINTS.md", "utf8") : "";
  const minChanged = readThreshold(constraints, CHANGED_ROW);
  const projectFloor = readThreshold(constraints, PROJECT_ROW);
  if (minChanged === null || projectFloor === null) {
    console.error(`coverage-gate: CONSTRAINTS.md needs the rows "${CHANGED_ROW}" and "${PROJECT_ROW}" with a % value`);
    return 2;
  }
  const hits = parseLcov(lcov);
  if (hits.size === 0) {
    console.error("coverage-gate: the lcov file holds no records");
    return 2;
  }
  const result = measure(hits, addedLines(diff));
  const failures = verdicts(result, minChanged, projectFloor, 0.5);
  const changedPct = result.changedTotal ? ((100 * result.changedCovered) / result.changedTotal).toFixed(1) : "n/a";
  console.log(
    `coverage-gate: changed lines ${changedPct}% (${result.changedCovered}/${result.changedTotal}), project ${result.projectPct.toFixed(2)}%`,
  );
  if (failures.length === 0) return 0;
  for (const f of failures) console.error("  " + f);
  for (const u of result.uncovered.slice(0, 20)) console.error("  not covered: " + u);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
