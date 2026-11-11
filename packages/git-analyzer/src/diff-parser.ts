export interface DiffLine {
  type: "add" | "delete" | "normal";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  isNewFile: boolean;
  isDeletedFile: boolean;
  /** Set from `rename from` / `rename to` headers; a pure rename has no hunks. */
  isRenamed?: boolean;
  hunks: DiffHunk[];
  addedLinesCount: number;
  deletedLinesCount: number;
}

/** The path a diff is about: the old path for a deleted file (its new path is `/dev/null`). */
export function fileDiffPath(diff: FileDiff): string {
  if (diff.isDeletedFile || diff.newPath === "/dev/null") return diff.oldPath || diff.newPath;
  return diff.newPath || diff.oldPath;
}

/** Undoes git's C-style quoting of a path (`"b/caf\303\251.ts"`); octal escapes are UTF-8 bytes. */
function unquoteCPath(quoted: string): string {
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  for (let i = 1; i < quoted.length - 1; i++) {
    const ch = quoted[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(quoted.slice(i + 1))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else {
      const next = quoted[i + 1] ?? "";
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * A path from a `---` / `+++` / `rename` header: drops the TAB git appends to a path with spaces,
 * unquotes a C-quoted path, then strips the `a/` or `b/` prefix.
 */
function headerPath(raw: string, prefix?: "a/" | "b/"): string {
  let path = raw.split("\t")[0];
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = unquoteCPath(path);
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
  return path;
}

/** The two paths of a `diff --git a/x b/x` line, quoted or not. */
function gitHeaderPaths(rest: string): [string, string] {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted && (quoted[1].startsWith('"') || quoted[2].startsWith('"'))) {
    return [headerPath(quoted[1], "a/"), headerPath(quoted[2], "b/")];
  }
  // Unquoted paths may contain spaces: `a/my file.ts b/my file.ts` splits in the middle.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
    return [headerPath(rest.slice(0, half), "a/"), headerPath(rest.slice(half + 1), "b/")];
  }
  const parts = rest.split(" ");
  return [headerPath(parts[0] ?? "", "a/"), headerPath(parts[1] ?? "", "b/")];
}

/**
 * Parses a standard Git unified diff string into structured FileDiff objects
 */
export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff || !rawDiff.trim()) return [];

  const files: FileDiff[] = [];
  const lines = rawDiff.split(/\r?\n/);
  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Lines still owed to the current hunk by its `@@ -a,b +c,d @@` header. While either is above
  // zero, a line such as `+++ i;` is an added line, not a file header.
  let oldRemaining = 0;
  let newRemaining = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/... b/...
    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        files.push(currentFile);
      }
      currentHunk = null;
      oldRemaining = 0;
      newRemaining = 0;

      const [oldPath, newPath] = gitHeaderPaths(line.slice("diff --git ".length));

      currentFile = {
        oldPath,
        newPath,
        isNewFile: false,
        isDeletedFile: false,
        hunks: [],
        addedLinesCount: 0,
        deletedLinesCount: 0,
      };
      continue;
    }

    if (!currentFile) {
      // In case diff starts without diff --git header (e.g. from git diff single file)
      if (line.startsWith("--- ")) {
        currentFile = {
          oldPath: headerPath(line.slice(4), "a/"),
          newPath: "",
          isNewFile: false,
          isDeletedFile: false,
          hunks: [],
          addedLinesCount: 0,
          deletedLinesCount: 0,
        };
      }
      continue;
    }

    const insideHunk = currentHunk !== null && (oldRemaining > 0 || newRemaining > 0);

    if (!insideHunk && line.startsWith("rename from ")) {
      currentFile.oldPath = headerPath(line.slice("rename from ".length));
      currentFile.isRenamed = true;
      continue;
    }

    if (!insideHunk && line.startsWith("rename to ")) {
      currentFile.newPath = headerPath(line.slice("rename to ".length));
      currentFile.isRenamed = true;
      continue;
    }

    if (line.startsWith("new file mode")) {
      currentFile.isNewFile = true;
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      currentFile.isDeletedFile = true;
      continue;
    }

    if (!insideHunk && line.startsWith("--- ")) {
      const oldPath = headerPath(line.slice(4), "a/");
      if (oldPath !== "/dev/null") currentFile.oldPath = oldPath;
      continue;
    }

    if (!insideHunk && line.startsWith("+++ ")) {
      currentFile.newPath = headerPath(line.slice(4), "b/");
      continue;
    }

    // Hunk header: @@ -1,4 +1,5 @@ optional context
    if (line.startsWith("@@ ")) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[3], 10);
        const oldLines = match[2] ? parseInt(match[2], 10) : 1;
        const newLines = match[4] ? parseInt(match[4], 10) : 1;
        oldRemaining = oldLines;
        newRemaining = newLines;

        currentHunk = {
          oldStart: oldLine,
          oldLines,
          newStart: newLine,
          newLines,
          header: match[5] || "",
          lines: [],
        };
      }
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+")) {
        newRemaining--;
        currentFile.addedLinesCount++;
        currentHunk.lines.push({
          type: "add",
          content: line.slice(1),
          newLineNumber: newLine++,
        });
      } else if (line.startsWith("-")) {
        oldRemaining--;
        currentFile.deletedLinesCount++;
        currentHunk.lines.push({
          type: "delete",
          content: line.slice(1),
          oldLineNumber: oldLine++,
        });
      } else if (line.startsWith(" ") || line === "") {
        oldRemaining--;
        newRemaining--;
        currentHunk.lines.push({
          type: "normal",
          content: line.startsWith(" ") ? line.slice(1) : line,
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
        });
      }
    }
  }

  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk);
    files.push(currentFile);
  }

  return files;
}
