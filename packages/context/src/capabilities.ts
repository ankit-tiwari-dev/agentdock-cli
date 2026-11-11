import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CapabilityKind = "mcp" | "skill" | "agent" | "command" | "hook" | "plugin";

export interface Capability {
  kind: CapabilityKind;
  name: string;
  /** Config file or folder the capability came from; home paths start with `~`. */
  source: string;
}

const MAX_JSON_BYTES = 20 * 1024 * 1024;

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_JSON_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function keysOf(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every tool source an agent session in this project can draw on (MCP servers, skills, subagents,
 * slash commands, hooks, plugins), each with the file it came from.
 */
export function scanCapabilities(projectRoot: string, home = homedir()): Capability[] {
  const out: Capability[] = [];
  const label = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length).replace(/\\/g, "/")}` : p.replace(/\\/g, "/").replace(projectRoot.replace(/\\/g, "/") + "/", ""));
  const add = (kind: CapabilityKind, name: string, source: string) => {
    if (!out.some((c) => c.kind === kind && c.name === name && c.source === label(source))) out.push({ kind, name, source: label(source) });
  };

  const projectMcp = join(projectRoot, ".mcp.json");
  for (const name of keysOf(readJson(projectMcp)?.mcpServers)) add("mcp", name, projectMcp);

  const userClaude = join(home, ".claude.json");
  const userState = readJson(userClaude);
  for (const name of keysOf(userState?.mcpServers)) add("mcp", name, userClaude);
  const projects = userState?.projects as Record<string, Record<string, unknown>> | undefined;
  if (projects) {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const entry = Object.entries(projects).find(([p]) => norm(p) === norm(projectRoot));
    for (const name of keysOf(entry?.[1]?.mcpServers)) add("mcp", name, `${userClaude} (project entry)`);
  }

  const settingsFiles = [join(home, ".claude", "settings.json"), join(projectRoot, ".claude", "settings.json"), join(projectRoot, ".claude", "settings.local.json")];
  for (const file of settingsFiles) {
    const s = readJson(file);
    if (!s) continue;
    for (const name of keysOf(s.mcpServers)) add("mcp", name, file);
    for (const name of keysOf(s.enabledPlugins)) add("plugin", name, file);
    const hooks = s.hooks as Record<string, { hooks?: { command?: string }[] }[]> | undefined;
    for (const [event, groups] of Object.entries(hooks ?? {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (typeof h?.command === "string") add("hook", `${event}: ${h.command.replace(/\s+/g, " ").slice(0, 80)}`, file);
        }
      }
    }
  }

  for (const base of [join(projectRoot, ".claude"), join(home, ".claude")]) {
    for (const d of listDir(join(base, "skills"))) {
      if (existsSync(join(base, "skills", d, "SKILL.md"))) add("skill", d, join(base, "skills", d));
    }
    for (const f of listDir(join(base, "agents"))) if (f.endsWith(".md")) add("agent", f.slice(0, -3), join(base, "agents", f));
    for (const f of listDir(join(base, "commands"))) if (f.endsWith(".md")) add("command", f.slice(0, -3), join(base, "commands", f));
  }

  const codexConfig = join(home, ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    try {
      for (const m of readFileSync(codexConfig, "utf8").matchAll(/^\[mcp_servers\.([^\]\s]+)\]/gm)) add("mcp", m[1].replace(/^"|"$/g, ""), codexConfig);
    } catch {
      // Unreadable config: nothing to report from it.
    }
  }

  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

const key = (c: Capability) => `${c.kind}\u0000${c.name}\u0000${c.source}`;

export function diffCapabilities(previous: Capability[], current: Capability[]): { added: Capability[]; removed: Capability[] } {
  const prev = new Set(previous.map(key));
  const curr = new Set(current.map(key));
  return { added: current.filter((c) => !prev.has(key(c))), removed: previous.filter((c) => !curr.has(key(c))) };
}

export function renderCapabilities(items: Capability[]): string {
  if (!items.length) return "No MCP servers, skills, agents, commands, hooks or plugins found.";
  return items.map((c) => `${c.kind.padEnd(7)} ${c.name}  ← ${c.source}`).join("\n");
}
