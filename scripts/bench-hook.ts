// Wall time of one `ctrlplane hook PreToolUse` process with no daemon, the slowest path an agent waits on.
// Usage: node scripts/bench-hook.ts [--runs 30] [--check]
// With --check it compares p95 with the "Hook latency, no daemon" row in CONSTRAINTS.md and the 1500 ms hook timeout.
// Exit 0 pass, 1 over budget, 2 could not run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readThresholdMs, percentile } from "./bench-stats.ts";

export const LATENCY_ROW = "Hook latency, no daemon";
const HOOK_TIMEOUT_MS = 1500;
const BIN = fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url));

function payloads(dir: string): string[] {
  const base = { session_id: "bench", cwd: dir, hook_event_name: "PreToolUse" };
  return [
    { ...base, tool_name: "Bash", tool_input: { command: "ls -la" } },
    { ...base, tool_name: "Bash", tool_input: { command: "git push --force origin main && rm -rf /" } },
    {
      ...base,
      tool_name: "Write",
      tool_input: { file_path: join(dir, "src", "a.ts"), content: "export const a = 1;\n" },
    },
  ].map((p) => JSON.stringify(p));
}

export function runBench(runs: number): number[] {
  const dir = mkdtempSync(join(tmpdir(), "ctrlplane-bench-"));
  try {
    mkdirSync(join(dir, ".ctrlplane"));
    const env: NodeJS.ProcessEnv = { ...process.env, CTRLPLANE_HOME: join(dir, "user-home") };
    delete env.CI;
    delete env.CTRLPLANE_MODE;
    const inputs = payloads(dir);
    const times: number[] = [];
    for (let i = -2; i < runs; i++) {
      const start = performance.now();
      const r = spawnSync(process.execPath, [BIN, "hook", "PreToolUse", "--agent", "claude-code"], {
        cwd: dir,
        env,
        input: inputs[(i + 3) % inputs.length],
        encoding: "utf8",
      });
      const elapsed = performance.now() - start;
      if (r.error || (r.status !== 0 && r.status !== 2))
        throw new Error(`hook exited ${String(r.status)}: ${r.stderr.slice(0, 200)}`);
      if (i >= 0) times.push(elapsed);
    }
    return times;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function main(argv: string[]): number {
  const runsArg = argv.indexOf("--runs");
  const runs = runsArg > -1 ? Number(argv[runsArg + 1]) : 30;
  if (!Number.isInteger(runs) || runs < 5) {
    console.error("bench-hook: --runs needs an integer of at least 5");
    return 2;
  }
  let times: number[];
  try {
    times = runBench(runs);
  } catch (error) {
    console.error("bench-hook: " + (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  console.log(
    `bench-hook: ${runs} runs, p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (${process.platform}, node ${process.version})`,
  );
  if (!argv.includes("--check")) return 0;

  const budget = existsSync("CONSTRAINTS.md")
    ? readThresholdMs(readFileSync("CONSTRAINTS.md", "utf8"), LATENCY_ROW)
    : null;
  if (budget === null) {
    console.error(`bench-hook: CONSTRAINTS.md needs a "${LATENCY_ROW}" row with an "at most <n> ms" value`);
    return 2;
  }
  const limit = Math.min(budget, HOOK_TIMEOUT_MS);
  if (p95 <= limit) return 0;
  console.error(`bench-hook: p95 ${p95.toFixed(0)} ms is over the ${limit} ms budget`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
