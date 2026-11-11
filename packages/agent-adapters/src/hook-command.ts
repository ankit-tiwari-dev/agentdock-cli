import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_BIN = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)).replace(/\\/g, "/");

/**
 * The command agents run for each hook. It points at this checkout's CLI with an absolute path
 * (forward slashes work in cmd, PowerShell and bash). CTRLPLANE_HOOK_COMMAND overrides it only
 * when CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE=1 is set as well: otherwise anything that can set one
 * environment variable for `ctrlplane init` could install a hook that does nothing.
 */
export function defaultHookCommand(): string {
  const override = process.env.CTRLPLANE_HOOK_COMMAND?.trim();
  if (override && process.env.CTRLPLANE_ALLOW_HOOK_COMMAND_OVERRIDE === "1") return override;
  return `node "${CLI_BIN}" hook`;
}

/**
 * The exact shapes `init` writes, now and in earlier versions: `node "<...>/cli/src/bin.ts" hook <Event>`,
 * `[npx [-y]] ctrlplane hook <Event>` or `npx -y @ctrlplane/cli hook <Event>`, optionally `--agent <name>`.
 * Anything else (a user's `~/bin/ctrlplane hook-audit.sh`) belongs to someone else and is left alone.
 * After `node\s+` the path starts with a quote or a non-space: same matches as `node\s+"?[^"]*`, but a long
 * run of spaces can only be split one way, so the check stays linear on it.
 */
const OUR_HOOK_COMMAND =
  /^\s*(?:node\s+(?:"[^"]*|[^\s"][^"]*)?[\\/]cli[\\/]src[\\/]bin\.ts"?|(?:npx\s+(?:-y\s+|--yes\s+)?)?(?:@ctrlplane\/cli(?:@[\w.-]+)?|ctrlplane))\s+hook(?:\s+[A-Za-z]+)?(?:\s+--agent\s+[\w-]+)?\s*$/;

/** Recognises hook entries we wrote, including those from earlier versions. */
export function isCtrlplaneCommand(command: unknown): boolean {
  return typeof command === "string" && OUR_HOOK_COMMAND.test(command);
}

export function readJsonObject(path: string): { data: Record<string, unknown>; raw?: string } {
  if (!existsSync(path)) return { data: {} };
  const raw = readFileSync(path, "utf8");
  // Editors on Windows often save JSON with a byte-order mark, which JSON.parse rejects.
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return { data: {}, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); refusing to overwrite it.`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; refusing to overwrite it.`);
  }
  return { data: parsed as Record<string, unknown>, raw };
}

/**
 * Writes `data` only if it differs from what is on disk. The first time a file we did not
 * create is changed, a pristine copy is kept next to it (never overwritten afterwards).
 */
export function writeJsonIfChanged(
  path: string,
  data: unknown,
  originalRaw?: string,
): { changed: boolean; backupPath?: string } {
  const next = JSON.stringify(data, null, 2) + "\n";
  if (originalRaw !== undefined && originalRaw.replace(/\r\n/g, "\n").trim() === next.trim()) return { changed: false };

  let backupPath: string | undefined;
  if (originalRaw !== undefined) {
    backupPath = `${path}.ctrlplane-backup`;
    if (!existsSync(backupPath)) copyFileSync(path, backupPath);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { changed: true, backupPath };
}

export interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
  [key: string]: unknown;
}

export interface HookEventSpec {
  event: string;
  matcher?: string;
  timeoutSeconds: number;
}

/**
 * Merges our hooks into a Claude-style `hooks` object: `{ Event: [{ matcher, hooks: [{type, command}] }] }`.
 * Entries from other tools are left untouched; ours (current or legacy shape) are replaced.
 */
export function mergeHookGroups(
  hooks: Record<string, unknown>,
  specs: HookEventSpec[],
  commandFor: (event: string) => string,
): number {
  const alreadyCurrent = new Set<string>();
  for (const spec of specs) {
    const list = hooks[spec.event];
    if (!Array.isArray(list)) continue;
    const present = list.some(
      (g) =>
        Array.isArray((g as HookGroup)?.hooks) &&
        (g as HookGroup).hooks.some((h) => h?.command === commandFor(spec.event)),
    );
    if (present) alreadyCurrent.add(spec.event);
  }

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    hooks[event] = value
      .map((group) => {
        if (!group || typeof group !== "object") return group;
        const g = group as Record<string, unknown>;
        if (isCtrlplaneCommand(g.command)) return null;
        if (Array.isArray(g.hooks)) {
          const kept = (g.hooks as Record<string, unknown>[]).filter((h) => !isCtrlplaneCommand(h?.command));
          if (kept.length === 0) return null;
          return { ...g, hooks: kept };
        }
        return g;
      })
      .filter((g) => g !== null);
  }

  for (const spec of specs) {
    const list = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as unknown[]) : [];
    const group: HookGroup = {
      hooks: [{ type: "command", command: commandFor(spec.event), timeout: spec.timeoutSeconds }],
    };
    if (spec.matcher !== undefined) group.matcher = spec.matcher;
    list.push(group);
    hooks[spec.event] = list;
  }

  for (const [event, value] of Object.entries(hooks)) {
    if (Array.isArray(value) && value.length === 0) delete hooks[event];
  }
  return specs.filter((s) => !alreadyCurrent.has(s.event)).length;
}

/** Removes only our hook entries. */
export function stripHookGroups(hooks: Record<string, unknown>): number {
  let removed = 0;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const before = JSON.stringify(value);
    const kept = value
      .map((group) => {
        const g = group as Record<string, unknown>;
        if (isCtrlplaneCommand(g?.command)) return null;
        if (Array.isArray(g?.hooks)) {
          const h = (g.hooks as Record<string, unknown>[]).filter((x) => !isCtrlplaneCommand(x?.command));
          return h.length ? { ...g, hooks: h } : null;
        }
        return g;
      })
      .filter((g) => g !== null);
    if (JSON.stringify(kept) !== before) removed++;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}
