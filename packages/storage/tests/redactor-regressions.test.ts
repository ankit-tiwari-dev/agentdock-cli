import test from "node:test";
import assert from "node:assert/strict";
import { redactObject, redactSecrets } from "../src/index.ts";

test("regression: redaction keeps no character of the secret value", () => {
  const secrets = {
    env: "STRIPE_SECRET_KEY=Zq9xKp2LmN4vB7wR1tY8",
    openai: "sk-Zq9xKp2LmN4vB7wR1tY8uI0oP3aS6dF5gH",
    github: "ghp_Zq9xKp2LmN4vB7wR1tY8uI0oP3aS6dF5gHjk",
  };
  for (const [name, input] of Object.entries(secrets)) {
    const out = redactSecrets(input).sanitized;
    assert.ok(!out.includes("Zq9x"), `${name} leaked a fragment: ${out}`);
  }
});

test("redaction covers JWTs, bearer tokens, connection-string passwords and Slack tokens", () => {
  const input = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    "postgres://app:hunter2secret@db:5432/main",
    "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "xoxb-123456789012-abcdefghijkl",
  ].join("\n");
  const out = redactSecrets(input).sanitized;
  assert.ok(!out.includes("abcdefghijklmnopqrstuvwx"));
  assert.ok(!out.includes("hunter2secret"));
  assert.ok(out.includes("postgres://app:[REDACTED_SECRET:PASSWORD]@db:5432/main"));
  assert.ok(!out.includes("dozjgNryP4J3"));
  assert.ok(!out.includes("xoxb-123456789012"));
});

test("regression: a private-key block is redacted without its END line, and ENCRYPTED, DSA and PGP blocks too", () => {
  const cases = {
    truncated: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefghijklmnop",
    encrypted:
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkq\n-----END ENCRYPTED PRIVATE KEY-----",
    dsa: "-----BEGIN DSA PRIVATE KEY-----\nMIIBuwIBAAKBgQDdsa0123456789\n-----END DSA PRIVATE KEY-----",
    pgp: "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF0abcdefghijk\n-----END PGP PRIVATE KEY BLOCK-----",
  };
  for (const [name, input] of Object.entries(cases)) {
    const out = redactSecrets(input).sanitized;
    assert.equal(out, "[REDACTED_SECRET:PRIVATE_KEY_BLOCK]", `${name}: ${out}`);
  }
  const around = redactSecrets(
    "before\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabc\n-----END EC PRIVATE KEY-----\nafter",
  ).sanitized;
  assert.equal(around, "before\n[REDACTED_SECRET:PRIVATE_KEY_BLOCK]\nafter");
});

// Fake tokens are joined at run time so the source never holds a full token-shaped string:
// secret scanners (ours and the hosting provider's) would otherwise flag these fixtures.
const token = (...parts: string[]) => parts.join("");

test("regression: provider tokens, auth headers, URL passwords, JSON/YAML and short .env secrets are redacted", () => {
  const cases: Record<string, { input: string; secret: string }> = {
    stripeLive: {
      input: `STRIPE=${token("sk_", "live_", "51Habcdefghij", "klmnopqrstuvwxyzABCDEFG")}`,
      secret: "51Habcdefghij",
    },
    stripeRestricted: {
      input: `const s = '${token("rk_", "live_", "51Habcdefghij", "klmnopqrstuvwxyzABCDEFG")}'`,
      secret: "51Habcdefghij",
    },
    gitlab: { input: `token ${token("glpat", "-", "abcdefghijklmnopqrst")}`, secret: "abcdefghijklmnopqrst" },
    npm: {
      input: `//registry.npmjs.org/:_authToken ${token("npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789")}`,
      secret: "abcdefghijklmnop",
    },
    huggingFace: { input: token("hf", "_", "abcdefghijklmnopqrstuvwxyzABCDEFGH"), secret: "abcdefghijklmnop" },
    awsTemporary: { input: "key ASIAIOSFODNN7EXAMPLE", secret: "IOSFODNN7EXAMPLE" },
    bearerLower: { input: "authorization: bearer abcdefghijklmnopqrstuvwxyz0123", secret: "abcdefghijklmnop" },
    basic: { input: 'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng=="', secret: "dXNlcjpwYXNz" },
    jsonKey: { input: '{"api_key": "a1b2c3d4e5f6a7b8c9d0e1f2"}', secret: "a1b2c3d4" },
    jsonSecretAccessKey: {
      input: '{"SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}',
      secret: "wJalrXUtnFEMI",
    },
    yaml: { input: "db:\n  password: Sup3rS3cretPassw0rd!\n  host: db", secret: "Sup3rS3cret" },
    envShort: { input: "DB_PASSWORD=hunter2", secret: "hunter2" },
    envSpecial: { input: "DB_PASSWORD=p@ss!w0rd#2024xyzABC", secret: "p@ss" },
    envQuotedSpaces: { input: 'SECRET_KEY="correct horse battery staple"', secret: "correct horse" },
    envLower: { input: "export db_password=abcdefghijklmnopqrstuv", secret: "abcdefghijklmnop" },
  };
  for (const [name, { input, secret }] of Object.entries(cases)) {
    const out = redactSecrets(input).sanitized;
    assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    assert.ok(out.includes("[REDACTED_SECRET:"), `${name} not redacted: ${out}`);
  }
  assert.equal(
    redactSecrets("redis://:s3cretpassw0rd@cache:6379").sanitized,
    "redis://:[REDACTED_SECRET:PASSWORD]@cache:6379",
  );
  assert.equal(
    redactSecrets("postgres://admin:p@ssw0rd123@db:5432/x").sanitized,
    "postgres://admin:[REDACTED_SECRET:PASSWORD]@db:5432/x",
  );
  assert.equal(
    redactSecrets("export DB_PASSWORD=hunter2 && run").sanitized,
    "export DB_PASSWORD=[REDACTED_SECRET:ENV] && run",
  );
});

test("regression: ordinary code that only looks like a secret is left unchanged", () => {
  const unchanged = [
    "npm i @acme/task-scheduler-worker-pool-implementation",
    "src/components/desk-booking-calendar-view-container.tsx",
    "const tokenizer = createTokenizerForLanguage(lang)",
    'const passwordInput = document.getElementById("password")',
    "keyboardLayoutName=international_english_us",
    "commit_key=4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "const authorName = process.env.AUTHOR_NAME_DEFAULT",
    "monkeyPatchedFunction=originalImplementationXYZ",
    "AUTH_REDIRECT_URL=https://example.com/callback/path",
    "const token = await getToken(req)",
    "interface Login {\n  password: string;\n}",
    "max_tokens=4096",
    "the bearer of this message",
    "the bearer responsibilities are listed below",
    "Basic configuration options",
    "see git@github.com:org/repo.git",
  ];
  for (const input of unchanged) assert.equal(redactSecrets(input).sanitized, input);
  assert.equal(
    redactSecrets("ok: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789").sanitized,
    "ok: [REDACTED_SECRET:ANTHROPIC_KEY]",
  );
  assert.equal(
    redactSecrets("key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789").sanitized,
    "key [REDACTED_SECRET:OPENAI_KEY]",
  );
});

test("regression: redactObject redacts a value whose key name is a secret and keeps other keys", () => {
  const out = redactObject({
    password: "Sup3rS3cretPassw0rd",
    env: { OPENAI_API_KEY: "short", DB_PASSWORD: "hunter2", HOME: "/home/dev" },
    api_key: "k1",
    apiKey: "k2",
    "x-api-key": "k3",
    SecretAccessKey: "k4",
    access_key: "k5",
    private_key: "k6",
    credential: "k7",
    auth: "k8",
    passwd: "k9",
    client_secret: "k10",
    token: "k11",
    user: "alice",
    tokenizer: "bpe",
    max_tokens: 4096,
    commit_key: "4b825dc6",
    author: "bob",
    passwordInput: "pw-field",
  });
  const R = "[REDACTED_SECRET:FIELD]";
  assert.deepEqual(out, {
    password: R,
    env: { OPENAI_API_KEY: R, DB_PASSWORD: R, HOME: "/home/dev" },
    api_key: R,
    apiKey: R,
    "x-api-key": R,
    SecretAccessKey: R,
    access_key: R,
    private_key: R,
    credential: R,
    auth: R,
    passwd: R,
    client_secret: R,
    token: R,
    user: "alice",
    tokenizer: "bpe",
    max_tokens: 4096,
    commit_key: "4b825dc6",
    author: "bob",
    passwordInput: "pw-field",
  });
});

test("regression: a long run of letters is redacted in linear time", () => {
  // The connection-string scheme could start at every letter, and each start rescanned the rest of the run.
  for (const text of ["a".repeat(200_000), "a-".repeat(100_000)]) {
    const started = performance.now();
    redactSecrets(text);
    const ms = performance.now() - started;
    assert.ok(ms < 300, `${ms.toFixed(0)} ms for ${text.length} characters`);
  }
});
