export interface RedactionResult {
  sanitized: string;
  secretsDetectedCount: number;
  detectedCategories: string[];
}

const REDACTION_PATTERNS: Array<{
  category: string;
  regex: RegExp;
  replacement: (match: string, ...groups: string[]) => string;
}> = [
  // No replacement keeps any character of the secret: even a short fragment narrows a brute force.
  {
    category: "ANTHROPIC_KEY",
    regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    replacement: () => `[REDACTED_SECRET:ANTHROPIC_KEY]`,
  },
  {
    category: "OPENAI_KEY",
    regex: /sk-(?:proj-)?[a-zA-Z0-9_-]{30,}/g,
    replacement: () => `[REDACTED_SECRET:OPENAI_KEY]`,
  },
  {
    category: "GITHUB_TOKEN",
    regex: /(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{40,})/g,
    replacement: () => `[REDACTED_SECRET:GITHUB_TOKEN]`,
  },
  {
    category: "SLACK_TOKEN",
    regex: /xox[abposr]-[a-zA-Z0-9-]{10,}/g,
    replacement: () => `[REDACTED_SECRET:SLACK_TOKEN]`,
  },
  {
    category: "GOOGLE_API_KEY",
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: () => `[REDACTED_SECRET:GOOGLE_API_KEY]`,
  },
  {
    category: "JWT",
    regex: /eyJ[a-zA-Z0-9_-]{8,}\.eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
    replacement: () => `[REDACTED_SECRET:JWT]`,
  },
  {
    category: "BEARER_TOKEN",
    regex: /(Bearer\s+)[a-zA-Z0-9_\-.=+/]{16,}/g,
    replacement: (_m, prefix) => `${prefix}[REDACTED_SECRET:BEARER_TOKEN]`,
  },
  {
    category: "CONNECTION_STRING",
    regex: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi,
    replacement: (_m, prefix, _password, at) => `${prefix}[REDACTED_SECRET:PASSWORD]${at}`,
  },
  // AWS Access Key ID
  {
    category: "AWS_KEY",
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: () => `[REDACTED_SECRET:AWS_KEY]`,
  },
  // Private Keys
  {
    category: "PRIVATE_KEY",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: () => `[REDACTED_SECRET:PRIVATE_KEY_BLOCK]`,
  },
  // Generic .env credential assignments
  {
    category: "ENV_SECRET",
    regex:
      /([A-Z0-9_]*(?:SECRET|KEY|PASSWORD|TOKEN|AUTH|PASSWD)[A-Z0-9_]*\s*=\s*['"]?)([a-zA-Z0-9\-_./+=]{16,})(['"]?)/gi,
    replacement: (_m, prefix, _secret, suffix) => `${prefix}[REDACTED_SECRET:ENV]${suffix}`,
  },
];

/**
 * Sanitizes input text, replacing sensitive API tokens and credentials
 */
export function redactSecrets(input: string): RedactionResult {
  if (!input || typeof input !== "string") {
    return { sanitized: "", secretsDetectedCount: 0, detectedCategories: [] };
  }

  let sanitized = input;
  let count = 0;
  const categories: string[] = [];

  for (const { category, regex, replacement } of REDACTION_PATTERNS) {
    const matches = sanitized.match(regex);
    if (matches && matches.length > 0) {
      count += matches.length;
      if (!categories.includes(category)) {
        categories.push(category);
      }
      sanitized = sanitized.replace(regex, replacement);
    }
  }

  return {
    sanitized,
    secretsDetectedCount: count,
    detectedCategories: categories,
  };
}

/**
 * Recursively redacts sensitive values inside objects and arrays
 */
export function redactObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return redactSecrets(obj).sanitized as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as unknown as T;
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = redactObject(val);
    }
    return result as unknown as T;
  }
  return obj;
}
