// Runs a gate command; before the given date a failure is reported but does not fail the run.
// Usage: node scripts/warn-window.ts <YYYY-MM-DD> <node script> [args...]
// Use it only for a gate that is new and still being tuned; CONSTRAINTS.md names the date.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function warnOnly(until: string, today: Date = new Date()): boolean {
  return today.toISOString().slice(0, 10) < until;
}

export function main(argv: string[]): number {
  const [until, script, ...args] = argv;
  if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until) || !script) {
    console.error("warn-window: usage: node scripts/warn-window.ts <YYYY-MM-DD> <node script> [args...]");
    return 2;
  }
  // A gate that cannot start must fail even inside the window, or a broken path reads as a passing gate.
  if (!existsSync(script)) {
    console.error(`warn-window: ${script} does not exist`);
    return 2;
  }
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  if (r.error) {
    console.error("warn-window: " + r.error.message);
    return 2;
  }
  const status = r.status ?? 1;
  if (status === 0) return 0;
  if (warnOnly(until)) {
    console.error(`warn-window: failed with exit ${status}; warning only until ${until}`);
    return 0;
  }
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
