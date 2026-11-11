export type FileClassification =
  "TEST_FILE" | "CTRLPLANE_FILE" | "AGENT_SETTINGS_FILE" | "CONFIG_FILE" | "SENSITIVE_FILE" | "SOURCE_FILE";

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
  const slashed = filePath.replace(/\\/g, "/");
  const normalized = slashed.toLowerCase();
  const base = slashed.slice(slashed.lastIndexOf("/") + 1);
  return (
    // A test folder at any depth, including the top level: tests/, test/, __tests__/.
    /(^|\/)(tests?|__tests__)\//.test(normalized) ||
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(normalized) ||
    // Go and pytest: *_test.go, *_test.py.
    /_test\.[a-zA-Z0-9]+$/.test(normalized) ||
    normalized.endsWith("test.py") ||
    // pytest: test_*.py
    /^test_.*\.py$/i.test(base) ||
    // JUnit: FooTest.java, FooTests.java (case-sensitive, so Contest.java is not a test).
    /Tests?\.java$/.test(base)
  );
}

export function isCtrlplaneFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith(".ctrlplane/") || normalized.includes("/.ctrlplane/");
}

export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (/^\.env\.(example|sample|template|dist|defaults)$/.test(base)) return false;
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
    normalized.includes("/.ssh/") ||
    normalized.startsWith(".ssh/") ||
    normalized.endsWith("/.aws/credentials") ||
    base === ".npmrc" ||
    base === ".netrc" ||
    base === ".pgpass"
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
