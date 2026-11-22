// The CONSTRAINTS.md checks wired into an agent's loop.
//   edit  Claude Code PostToolUse hook: the floor guard, a few seconds.
//   stop  Claude Code Stop hook: the task-end checks, only when the working tree has uncommitted code changes.
//   task  the same task-end checks, run by hand (npm run check:task).
// Hook modes exit 2 with the findings on stderr so the agent sees them and keeps working; a check that could
// not run is reported but never blocks.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Check {
  name: string;
  script: string;
  /** Runs after the parallel checks, alone, because timing-sensitive tests flake when the machine is busy. */
  alone?: boolean;
}

export const TASK_CHECKS: Check[] = [
  { name: "lint", script: "lint" },
  { name: "format", script: "format:check" },
  { name: "typecheck", script: "typecheck" },
  { name: "floor", script: "check:floor" },
  { name: "architecture", script: "check:arch" },
  { name: "tests + coverage", script: "check:coverage", alone: true },
];

const CODE_CHANGE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json)$|(^|\/)CONSTRAINTS\.md$|(^|\/)\.constraintsignore$/;

export function changedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => (l.slice(3).split(" -> ").pop() ?? "").replace(/^"|"$/g, ""));
}

export function hasCodeChanges(porcelain: string): boolean {
  return changedFiles(porcelain).some((f) => CODE_CHANGE.test(f));
}

function readStdin(): Record<string, unknown> {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function runScript(script: string): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(`npm run --silent ${script}`, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, output }));
    child.on("error", (e) => resolve({ status: 2, output: e.message }));
  });
}

export interface Deps {
  run: (script: string) => Promise<{ status: number; output: string }>;
  stdin: () => Record<string, unknown>;
  gitStatus: () => string | null;
}

const realDeps: Deps = {
  run: runScript,
  stdin: readStdin,
  gitStatus: () => {
    const r = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  },
};

export async function runTaskChecks(run: Deps["run"] = runScript): Promise<{ failed: string[]; report: string }> {
  const started = performance.now();
  const runCheck = async (c: Check) => ({ check: c, ...(await run(c.script)) });
  const results = await Promise.all(TASK_CHECKS.filter((c) => !c.alone).map(runCheck));
  for (const c of TASK_CHECKS.filter((x) => x.alone)) results.push(await runCheck(c));
  const failed = results.filter((r) => r.status !== 0).map((r) => r.check.name);
  const lines = results.map((r) => `${r.status === 0 ? "pass" : "FAIL"}  ${r.check.name}`);
  for (const r of results.filter((x) => x.status !== 0)) {
    lines.push(
      "",
      `--- ${r.check.name} (npm run ${r.check.script}) ---`,
      r.output.trim().split("\n").slice(-40).join("\n"),
    );
  }
  lines.push("", `checks took ${((performance.now() - started) / 1000).toFixed(0)} s`);
  return { failed, report: lines.join("\n") };
}

export async function main(mode: string | undefined, deps: Deps = realDeps): Promise<number> {
  if (mode === "edit") {
    deps.stdin();
    const r = await deps.run("check:floor");
    if (r.status === 1) {
      console.error("CONSTRAINTS.md floor: this edit lowers the bar.\n" + r.output.trim());
      return 2;
    }
    if (r.status !== 0) console.error("floor guard could not run: " + r.output.trim());
    return 0;
  }
  if (mode === "stop" || mode === "task") {
    if (mode === "stop") {
      // A Stop hook that blocks again after the agent already responded to it would loop.
      if (deps.stdin().stop_hook_active === true) return 0;
      const porcelain = deps.gitStatus();
      if (porcelain === null || !hasCodeChanges(porcelain)) return 0;
    }
    const { failed, report } = await runTaskChecks(deps.run);
    if (failed.length === 0) {
      if (mode === "task") console.log(report);
      return 0;
    }
    console.error(`CONSTRAINTS.md task-end checks failed: ${failed.join(", ")}\n\n${report}`);
    return mode === "stop" ? 2 : 1;
  }
  console.error("agent-check: usage: node scripts/agent-check.ts <edit|stop|task>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.chdir(join(import.meta.dirname, ".."));
  process.exitCode = await main(process.argv[2]);
}
