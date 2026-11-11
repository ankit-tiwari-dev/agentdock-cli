import type { DependencyDelta } from "../../core/src/index.ts";
import { parseUnifiedDiff } from "../../git-analyzer/src/index.ts";

export function auditDependencyChanges(rawDiff: string): DependencyDelta[] {
  const fileDiffs = parseUnifiedDiff(rawDiff);
  const deltas: DependencyDelta[] = [];

  const pkgDiff = fileDiffs.find((f) => f.newPath.endsWith("package.json") || f.oldPath.endsWith("package.json"));
  if (!pkgDiff) return deltas;

  for (const hunk of pkgDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") {
        // e.g. "stripe": "^14.0.0",
        const match = line.content.match(/"([^"]+)":\s*"([^"]+)"/);
        if (match) {
          const packageName = match[1];
          const version = match[2];

          // Ignore scripts, name, version, etc.
          if (!["name", "version", "description", "main", "type", "scripts"].includes(packageName)) {
            deltas.push({
              packageName,
              version,
              isDev: hunk.header.includes("devDependencies") || line.content.includes("dev"),
              status: "added",
              securityNote: `Review newly introduced dependency '${packageName}' for security CVEs before deploying.`,
            });
          }
        }
      }
    }
  }

  return deltas;
}
