// The "Depends on" column of docs/ARCHITECTURE.md → Packages, as rules. Change both together.
const ALLOWED = {
  core: [],
  storage: ["core"],
  "git-analyzer": ["core"],
  intent: ["core", "storage"],
  "policy-engine": ["core", "git-analyzer"],
  context: ["core", "storage", "intent", "policy-engine"],
  daemon: ["core", "storage", "policy-engine", "agent-adapters"],
  "agent-adapters": ["core", "daemon"],
  verifier: ["core", "git-analyzer", "intent"],
  explanation: ["core", "git-analyzer"],
};

const packageRules = Object.entries(ALLOWED).map(([name, deps]) => ({
  name: `layer-${name}`,
  comment: `${name} may import only: ${deps.length ? deps.join(", ") : "nothing"} (docs/ARCHITECTURE.md)`,
  severity: "error",
  from: { path: `^packages/${name}/src/` },
  to: { path: "^packages/([^/]+)/src/", pathNot: [`^packages/(${[name, ...deps].join("|")})/src/`] },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    ...packageRules,
    {
      name: "no-package-cycle",
      comment: "Dependencies between packages only point downwards (docs/ARCHITECTURE.md).",
      severity: "error",
      from: { path: "^packages/([^/]+)/src/" },
      to: { circular: true, viaOnly: { path: "^packages/[^/]+/src/" } },
    },
    {
      name: "src-not-to-tests",
      comment: "Shipped code never imports test code.",
      severity: "error",
      from: { path: "^packages/[^/]+/src/" },
      to: { path: "^packages/[^/]+/tests/" },
    },
  ],
  options: {
    includeOnly: "^packages/[^/]+/src/",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    moduleSystems: ["es6"],
  },
};
