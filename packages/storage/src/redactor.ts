export interface RedactionResult {
  sanitized: string;
  secretsDetectedCount: number;
  detectedCategories: string[];
}

const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "apikey",
  "accesskey",
  "privatekey",
  "secretkey",
]);
/** Words that turn a trailing `key` into a credential (`api_key`, `SecretAccessKey`, `AccountKey`); `commit_key` is not one. */
const KEY_QUALIFIERS = new Set(["api", "access", "private", "secret", "account", "master", "encryption", "signing"]);

/**
 * True when a variable or field name ends in a credential word, in any case and with `_`, `-` or camelCase
 * between words: `DB_PASSWORD`, `apiKey`, `x-api-key`, `client_secret`. Not `tokenizer`, `passwordInput`,
 * `max_tokens` or `commit_key`.
 */
function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = words[words.length - 1];
  if (!last) return false;
  return SECRET_WORDS.has(last) || (last === "key" && KEY_QUALIFIERS.has(words[words.length - 2] ?? ""));
}

const isRedacted = (value: string) => value.startsWith("[REDACTED_SECRET:");
/** Long and plain enough to be a token rather than code such as `await` or `getToken(req)`. */
const TOKEN_LIKE = /^[a-zA-Z0-9\-_./+=]{16,}/;

const REDACTION_PATTERNS: Array<{
  category: string;
  regex: RegExp;
  /** Returning the match unchanged means "not a secret" and is not counted. */
  replacement: (match: string, ...groups: (string | undefined)[]) => string;
}> = [
  // No replacement keeps any character of the secret: even a short fragment narrows a brute force.
  // Private keys (RSA, EC, OPENSSH, DSA, ENCRYPTED, PGP ... BLOCK). A block cut off before its END line is
  // redacted to the end of the text.
  {
    category: "PRIVATE_KEY",
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replacement: () => `[REDACTED_SECRET:PRIVATE_KEY_BLOCK]`,
  },
  // Token prefixes only count at the start of a word, so `task-scheduler-...` or `desk-booking-...` stay intact.
  {
    category: "ANTHROPIC_KEY",
    regex: /(?<![A-Za-z0-9])sk-ant-[a-zA-Z0-9_-]{20,}/g,
    replacement: () => `[REDACTED_SECRET:ANTHROPIC_KEY]`,
  },
  {
    category: "OPENAI_KEY",
    regex: /(?<![A-Za-z0-9])sk-(?:proj-)?[a-zA-Z0-9_-]{30,}/g,
    replacement: () => `[REDACTED_SECRET:OPENAI_KEY]`,
  },
  {
    category: "STRIPE_KEY",
    regex: /(?<![A-Za-z0-9])[sr]k_live_[a-zA-Z0-9]{16,}/g,
    replacement: () => `[REDACTED_SECRET:STRIPE_KEY]`,
  },
  {
    category: "GITHUB_TOKEN",
    regex: /(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{40,})/g,
    replacement: () => `[REDACTED_SECRET:GITHUB_TOKEN]`,
  },
  {
    category: "GITLAB_TOKEN",
    regex: /(?<![A-Za-z0-9])glpat-[a-zA-Z0-9_-]{20,}/g,
    replacement: () => `[REDACTED_SECRET:GITLAB_TOKEN]`,
  },
  {
    category: "NPM_TOKEN",
    regex: /(?<![A-Za-z0-9_])npm_[a-zA-Z0-9]{36,}/g,
    replacement: () => `[REDACTED_SECRET:NPM_TOKEN]`,
  },
  {
    category: "HUGGINGFACE_TOKEN",
    regex: /(?<![A-Za-z0-9_])hf_[a-zA-Z0-9]{30,}/g,
    replacement: () => `[REDACTED_SECRET:HUGGINGFACE_TOKEN]`,
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
    regex: /(\bBearer\s+)[a-zA-Z0-9_\-.=+/]{16,}/g,
    replacement: (_m, prefix) => `${prefix}[REDACTED_SECRET:BEARER_TOKEN]`,
  },
  // Any case after an Authorization header (`authorization: bearer ...`), but not "bearer" in ordinary prose.
  {
    category: "BEARER_TOKEN",
    regex: /(\bAuthorization["']?\s*[:=]\s*["']?Bearer\s+)[a-zA-Z0-9_\-.=+/]{16,}/gi,
    replacement: (_m, prefix) => `${prefix}[REDACTED_SECRET:BEARER_TOKEN]`,
  },
  {
    category: "BASIC_AUTH",
    regex: /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[a-zA-Z0-9+/]{8,}={0,2}/gi,
    replacement: (_m, prefix) => `${prefix}[REDACTED_SECRET:BASIC_AUTH]`,
  },
  // The user may be empty (`redis://:pass@host`), and the password runs to the last `@` before the host, so a
  // password that contains `@` is redacted whole.
  {
    category: "CONNECTION_STRING",
    // The lookbehind lets a scheme start only at a word start; without it, a long run of letters takes quadratic time.
    regex: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s/"'`]{3,})(@)/gi,
    replacement: (_m, prefix, _password, at) => `${prefix}[REDACTED_SECRET:PASSWORD]${at}`,
  },
  // AWS access key IDs: long-term (AKIA) and temporary (ASIA)
  {
    category: "AWS_KEY",
    regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
    replacement: () => `[REDACTED_SECRET:AWS_KEY]`,
  },
  // `.env` and shell assignments to a secret-named variable. A quoted value is redacted whatever it holds. An
  // unquoted value is redacted whatever its length in `UPPER_NAME=value` form; with a lowercase name or spaces
  // around `=` (code such as `const token = await getToken()`) only when it looks like a token.
  {
    category: "ENV_SECRET",
    regex:
      /(?<![A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]*)([ \t]*=(?![=>~])[ \t]*)(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s'"`;,&)\]}<>]+))/g,
    replacement: (m, name = "", eq = "", dq, sq, bare) => {
      if (!isSecretName(name)) return m;
      const quoted = dq ?? sq;
      if (quoted !== undefined) {
        const q = dq !== undefined ? '"' : "'";
        return quoted && !isRedacted(quoted) ? `${name}${eq}${q}[REDACTED_SECRET:ENV]${q}` : m;
      }
      if (!bare || isRedacted(bare)) return m;
      const envStyle = eq === "=" && /^[A-Z][A-Z0-9_]*$/.test(name);
      return envStyle || TOKEN_LIKE.test(bare) ? `${name}${eq}[REDACTED_SECRET:ENV]` : m;
    },
  },
  // JSON, YAML and object literals with a quoted value: `{"api_key": "..."}`, `{ password: '...' }`.
  {
    category: "CONFIG_SECRET",
    regex: /(?<![A-Za-z0-9_-])(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1([ \t]*:[ \t]*)(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')/g,
    replacement: (m, q = "", name = "", sep = "", dq, sq) => {
      const value = dq ?? sq ?? "";
      const vq = dq !== undefined ? '"' : "'";
      return isSecretName(name) && value && !isRedacted(value)
        ? `${q}${name}${q}${sep}${vq}[REDACTED_SECRET:CONFIG]${vq}`
        : m;
    },
  },
  // A YAML line with a bare value: `password: Sup3rS3cret!`. A TypeScript member such as `password: string;` is not.
  {
    category: "CONFIG_SECRET",
    regex:
      /^([ \t]*(?:-[ \t]+)?)(["']?)([A-Za-z_][A-Za-z0-9_-]*)\2([ \t]*:[ \t]+)(?!(?:string|number|boolean|null|undefined|true|false|~)[ \t]*$)([^\s'"#&*!|>{}[\],;]\S*?)(?<![;,])([ \t]+#[^\n]*)?[ \t]*$/gm,
    replacement: (m, indent = "", q = "", name = "", sep = "", value = "", comment) =>
      isSecretName(name) && !isRedacted(value)
        ? `${indent}${q}${name}${q}${sep}[REDACTED_SECRET:CONFIG]${comment ?? ""}`
        : m,
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
    let hits = 0;
    sanitized = sanitized.replace(regex, (match: string, ...groups: (string | undefined)[]) => {
      const out = replacement(match, ...groups);
      if (out !== match) hits++;
      return out;
    });
    if (hits > 0) {
      count += hits;
      if (!categories.includes(category)) {
        categories.push(category);
      }
    }
  }

  return {
    sanitized,
    secretsDetectedCount: count,
    detectedCategories: categories,
  };
}

/**
 * Recursively redacts sensitive values inside objects and arrays. A string stored under a secret-named key
 * (`password`, `apiKey`, `client_secret`, ...) is replaced whole, whatever it looks like.
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
      result[key] = typeof val === "string" && val && isSecretName(key) ? "[REDACTED_SECRET:FIELD]" : redactObject(val);
    }
    return result as unknown as T;
  }
  return obj;
}
