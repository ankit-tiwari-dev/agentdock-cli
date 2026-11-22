import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/*.vsix"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // One owner for shared values: a second hand-written copy drifts (ISSUE.md I-34, I-59; CLAUDE.md rule table).
    files: ["packages/*/src/**/*.ts"],
    ignores: ["packages/core/src/paths.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='.ctrlplane']",
          message:
            "Use CTRLPLANE_DIR or ctrlplaneDir() / auditDbPath() / daemonLockPath() from packages/core/src/paths.ts.",
        },
        {
          selector: "Literal[value='audit.db']",
          message: "Use auditDbPath() from packages/core/src/paths.ts.",
        },
        {
          selector: "Literal[value='sess_default']",
          message: "Use DEFAULT_SESSION_ID from packages/core/src/paths.ts.",
        },
        {
          selector: "MemberExpression[property.name='CTRLPLANE_HOME']",
          message: "Use ctrlplaneHome() from packages/core/src/paths.ts; it treats an empty CTRLPLANE_HOME as unset.",
        },
        {
          selector: "NewExpression[callee.name='Set'] > ArrayExpression > Literal[value='UserPromptSubmit']",
          message:
            "A hook-event set already exists: use CONTEXT_EVENTS from packages/core/src/paths.ts, or add one there.",
        },
      ],
    },
  },
  prettier,
);
