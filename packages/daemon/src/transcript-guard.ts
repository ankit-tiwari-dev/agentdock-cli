import { createReadStream, promises as fsp } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

export type TranscriptRefusal = "not-jsonl" | "missing" | "outside-projects" | "not-a-file" | "too-large";

export interface GuardFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ size: number; isFile(): boolean }>;
}

export interface TranscriptOpener {
  lines(realPath: string, maxBytes: number): AsyncIterable<string>;
}

const nodeFs: GuardFs = { realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p) };

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Decides whether the daemon may read a transcript path that arrived in a hook payload. The path comes from the
 * agent, so it is only trusted after links are resolved: the real file must be a .jsonl file of at most 50 MB under
 * the real `<home>/.claude/projects`. Nothing is opened here.
 */
export async function checkTranscriptPath(
  rawPath: string,
  o: { home: string; fs?: GuardFs },
): Promise<{ ok: true; realPath: string; size: number } | { ok: false; reason: TranscriptRefusal }> {
  const fs = o.fs ?? nodeFs;
  if (extname(rawPath).toLowerCase() !== ".jsonl") return { ok: false, reason: "not-jsonl" };

  let root: string;
  try {
    root = await fs.realpath(join(o.home, ".claude", "projects"));
  } catch {
    return { ok: false, reason: "outside-projects" };
  }

  let real: string;
  try {
    real = await fs.realpath(rawPath);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!isInside(root, real)) return { ok: false, reason: "outside-projects" };
  if (extname(real).toLowerCase() !== ".jsonl") return { ok: false, reason: "not-jsonl" };

  let info: { size: number; isFile(): boolean };
  try {
    info = await fs.stat(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!info.isFile()) return { ok: false, reason: "not-a-file" };
  if (info.size > MAX_TRANSCRIPT_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true, realPath: real, size: info.size };
}

/** Streams a file line by line and never reads past maxBytes, even if the file grew after it was checked. */
export const defaultOpener: TranscriptOpener = {
  lines: async function* (realPath: string, maxBytes: number) {
    // 16 KB reads keep each parse step short, so a hook arriving mid-parse waits under a millisecond.
    const stream = createReadStream(realPath, { start: 0, end: maxBytes - 1, highWaterMark: 16 * 1024 });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      yield* reader;
    } finally {
      reader.close();
      stream.destroy();
    }
  },
};
