import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditDbPath,
  buildContextPack,
  renderCapabilities,
  scanCapabilities,
  supervisionState,
  writeHandoff,
} from "../../../context/src/index.ts";
import { buildProjectEngine } from "../../../policy-engine/src/index.ts";
import { StorageEngine } from "../../../storage/src/index.ts";
import type { CommandResult } from "./policies-cmd.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function withStorage<T>(root: string, fn: (s: StorageEngine) => T): T {
  const dir = join(root, ".ctrlplane");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const storage = new StorageEngine(auditDbPath(root));
  try {
    return fn(storage);
  } finally {
    storage.close();
  }
}

/** Prints exactly what a new session would receive at SessionStart. */
export async function handleContextCommand(args: string[], projectPath = process.cwd()): Promise<CommandResult> {
  const root = resolve(projectPath);
  const project = await buildProjectEngine(root).catch(() => null);
  const dbPath = auditDbPath(root);
  const storage = existsSync(dbPath) ? new StorageEngine(dbPath) : null;
  try {
    const pack = buildContextPack({
      projectRoot: root,
      storage,
      source: flag(args, "--source") ?? "startup",
      supervision: project ? supervisionState(project, root) : undefined,
      maxChars: project?.config.context.maxChars,
    });
    return { output: pack ?? "Nothing recorded yet: a new session would start without a context pack.", exitCode: 0 };
  } finally {
    storage?.close();
  }
}

export function handleHandoffCommand(args: string[], projectPath = process.cwd()): CommandResult {
  const root = resolve(projectPath);
  if (args[0] === "show") {
    return withStorage(root, (s) => {
      const last = s.listContextEntries("handoff", { limit: 1 })[0];
      return {
        output: last
          ? `Handoff from ${new Date(last.createdAt).toLocaleString()}\n${last.body}`
          : "No handoff written yet.",
        exitCode: 0,
      };
    });
  }
  const note = flag(args, "--note") ?? (args[0] && !args[0].startsWith("--") ? args.join(" ") : undefined);
  const body = withStorage(root, (s) => writeHandoff(s, root, { note }));
  return { output: `Handoff saved. The next session starts with:\n\n${body}`, exitCode: 0 };
}

export function handleMemoryCommand(
  sub: string | undefined,
  args: string[],
  projectPath = process.cwd(),
): CommandResult {
  const root = resolve(projectPath);
  const usage = 'Usage: ctrlplane memory add "<note>" [--tags a,b] [--pin] | search "<words>" | list | rm <id>';
  return withStorage(root, (s) => {
    if (sub === "add") {
      const text = args
        .filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--tags")
        .join(" ")
        .trim();
      if (!text) return { output: usage, exitCode: 2 };
      const tags = (flag(args, "--tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const id = s.addMemory(text, { tags, pinned: args.includes("--pin") });
      return { output: `Saved memory #${id}.`, exitCode: 0 };
    }
    if (sub === "search") {
      const q = args.join(" ").trim();
      if (!q) return { output: usage, exitCode: 2 };
      const hits = s.searchMemory(q);
      return {
        output: hits.length
          ? hits
              .map(
                (n) =>
                  `#${n.id} ${n.pinned ? "[pinned] " : ""}${n.body}${n.tags.length ? `  (${n.tags.join(", ")})` : ""}`,
              )
              .join("\n")
          : "No matching notes.",
        exitCode: 0,
      };
    }
    if (sub === "list" || sub === undefined) {
      const notes = s.listMemory(50);
      return {
        output: notes.length
          ? notes.map((n) => `#${n.id} ${n.pinned ? "[pinned] " : ""}${n.body}`).join("\n")
          : "No notes yet.",
        exitCode: 0,
      };
    }
    if (sub === "rm") {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return { output: usage, exitCode: 2 };
      return s.deleteMemory(id)
        ? { output: `Deleted memory #${id}.`, exitCode: 0 }
        : { output: `No memory #${id}.`, exitCode: 2 };
    }
    return { output: usage, exitCode: 2 };
  });
}

export function handleCapabilitiesCommand(projectPath = process.cwd()): CommandResult {
  return { output: renderCapabilities(scanCapabilities(resolve(projectPath))), exitCode: 0 };
}
