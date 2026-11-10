import type { SymbolBlastRadius } from "../../core/src/index.ts";
import { parseUnifiedDiff, type FileDiff } from "../../git-analyzer/src/index.ts";

export function computeDiffBlastRadius(rawDiff: string): SymbolBlastRadius[] {
  const fileDiffs = parseUnifiedDiff(rawDiff);
  const symbols: SymbolBlastRadius[] = [];

  for (const file of fileDiffs) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add" || line.type === "delete") {
          const match = line.content.match(
            /\b(?:export\s+)?(?:function|class|interface|type|const|let)\s+([a-zA-Z0-9_$]+)/
          );
          if (match) {
            const symbolName = match[1];
            if (!symbols.some((s) => s.symbolName === symbolName && s.filePath === file.newPath)) {
              symbols.push({
                symbolName,
                filePath: file.newPath || file.oldPath,
                referencesCount: 1,
                referencingFiles: [file.newPath || file.oldPath],
              });
            }
          }
        }
      }
    }
  }

  return symbols;
}

