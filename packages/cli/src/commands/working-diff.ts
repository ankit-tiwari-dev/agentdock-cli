import { execFileSync } from "node:child_process";

/**
 * The working tree's changes against HEAD (`git diff HEAD`), or undefined outside a git repo or
 * before the first commit. Untracked files are not included, as in `git diff`.
 */
export function readWorkingTreeDiff(projectPath: string): string | undefined {
  try {
    return execFileSync("git", ["diff", "HEAD"], {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}
