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
  hunks: DiffHunk[];
  addedLinesCount: number;
  deletedLinesCount: number;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/... b/...
    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        files.push(currentFile);
      }
      currentHunk = null;

      const parts = line.split(" ");
      const oldPath = parts[2]?.replace(/^a\//, "") || "";
      const newPath = parts[3]?.replace(/^b\//, "") || "";

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
          oldPath: line.replace(/^---\s+(?:a\/)?/, ""),
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

    if (line.startsWith("new file mode")) {
      currentFile.isNewFile = true;
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      currentFile.isDeletedFile = true;
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentFile.newPath = line.replace(/^\+\+\+\s+(?:b\/)?/, "");
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
        currentFile.addedLinesCount++;
        currentHunk.lines.push({
          type: "add",
          content: line.slice(1),
          newLineNumber: newLine++,
        });
      } else if (line.startsWith("-")) {
        currentFile.deletedLinesCount++;
        currentHunk.lines.push({
          type: "delete",
          content: line.slice(1),
          oldLineNumber: oldLine++,
        });
      } else if (line.startsWith(" ") || line === "") {
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
