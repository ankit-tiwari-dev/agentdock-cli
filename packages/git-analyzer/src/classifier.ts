export type FileClassification =
  | "TEST_FILE"
  | "CTRLPLANE_FILE"
  | "AGENT_SETTINGS_FILE"
  | "CONFIG_FILE"
  | "SENSITIVE_FILE"
  | "SOURCE_FILE";

export function isAgentSettingsFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.claude/settings") ||
    normalized.startsWith(".claude/settings") ||
    normalized.includes("/.codex/hooks.json") ||
    normalized.startsWith(".codex/hooks.json") ||
    normalized.includes("/.cursor/hooks.json") ||
    normalized.startsWith(".cursor/hooks.json") ||
    normalized.includes("/.opencode/opencode.json") ||
    normalized.startsWith(".opencode/opencode.json") ||
    normalized.includes("/.gemini/config/hooks.json") ||
    normalized.startsWith(".gemini/config/hooks.json")
  );
}

export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(normalized) ||
    /_test\.[a-zA-Z0-9]+$/.test(normalized) ||
    normalized.endsWith("test.py") ||
    normalized.endsWith("_test.go")
  );
}

export function isCtrlplaneFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith(".ctrlplane/") || normalized.includes("/.ctrlplane/");
}

export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith(".env") ||
    normalized.includes(".env.") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.includes("/.ssh/") ||
    normalized.endsWith("id_rsa")
  );
}

export function isConfigFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith("package.json") ||
    normalized.endsWith("tsconfig.json") ||
    normalized.includes("tsconfig.") ||
    normalized.endsWith(".eslintrc") ||
    normalized.endsWith(".prettierrc") ||
    normalized.includes(".config.")
  );
}

export function classifyFile(filePath: string): FileClassification {
  if (isCtrlplaneFile(filePath)) return "CTRLPLANE_FILE";
  if (isAgentSettingsFile(filePath)) return "AGENT_SETTINGS_FILE";
  if (isSensitiveFile(filePath)) return "SENSITIVE_FILE";
  if (isTestFile(filePath)) return "TEST_FILE";
  if (isConfigFile(filePath)) return "CONFIG_FILE";
  return "SOURCE_FILE";
}

