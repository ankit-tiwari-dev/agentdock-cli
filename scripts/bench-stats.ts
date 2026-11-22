// Small helpers shared by the benchmark gates.

/** Nearest-rank percentile of a non-empty sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** The number in "at most <n> ms" on the CONSTRAINTS.md table row whose first cell is `label`. */
export function readThresholdMs(constraints: string, label: string): number | null {
  for (const line of constraints.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells[1] !== label) continue;
    const m = /at most\s+(\d+(?:\.\d+)?)\s*ms/i.exec(cells.slice(2).join(" "));
    if (m) return Number(m[1]);
  }
  return null;
}
