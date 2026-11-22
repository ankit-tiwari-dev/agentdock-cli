# Decisions

One entry per decision: what we chose, why, and what we gave up. Append new entries and never rewrite old ones. When a decision changes, add a new entry that supersedes the old one.

## D-1 · Small packages, a per-project daemon, and hooks that work without it

- **Decision:** the engine is split into the packages listed in `docs/ARCHITECTURE.md`. One daemon runs per project. Every hook can still evaluate the rules on its own when the daemon is down.
- **Why:** a supervisor that stops supervising when a background process dies gives false safety. The daemon only makes hooks faster and keeps a fuller audit trail.
- **Cost:** the rules must stay cheap enough to load in a short-lived process. The policy-engine perf test guards this.
- **Planned:** a compiled Go hook binary, to cut the Node start-up time from each hook, and a React dashboard in the AgentDock app. Neither exists yet.

## D-2 · Run TypeScript directly, no build step

- **Decision:** Node runs the `.ts` sources by stripping types. This is on by default from Node 22.18. `tsc` only type-checks (`noEmit`).
- **Why:** there is no `dist/` that can drift from the source, and a stack trace points at the real file and line.
- **Cost:** only erasable TypeScript syntax is allowed (`CLAUDE.md` → Code invariants, `docs/PITFALLS.md` → P-1).

## D-3 · One root tsconfig

- **Decision:** a single `tsconfig.json` covers `packages/*/src` and `packages/*/tests`.
- **Why:** the editor and `npm run typecheck` then report the same errors. Per-package configs drifted and caused 743 editor-only errors (`ISSUE.md` → I-4).

## D-4 · Local-first storage in SQLite

- **Decision:** all audit data stays on the developer's machine in `node:sqlite`. Secrets are redacted before anything is written.
- **Why:** tool payloads contain source code and credentials. Nothing leaves the machine unless the developer exports it.

## D-5 · AI summaries are opt-in and use the local `claude` CLI

- **Decision:** session summaries are deterministic by default. With `aiSummaries` turned on, AgentDock calls `claude -p` with no tools, no MCP servers and a fixed system prompt, from a temporary folder, with `CTRLPLANE_NESTED=1`.
- **Why:** no API key to manage and no new network destination. The nested flag stops the summary run from being supervised and summarised itself.

## D-6 · Context is information, never instructions

- **Decision:** the SessionStart context pack only contains an approved spec, the project's own captured intents, summaries and handoffs, and memory the developer added. It is capped at 6000 characters and labelled as background.
- **Why:** anything injected into an agent's context can steer it. Agents are denied `ctrlplane memory add|rm`, so an agent cannot plant instructions for the next session.

## D-7 · Ideas from other tools are re-implemented, never copied

- **Decision:** a feature seen in another project is written from a description of its behaviour, by someone who has not read that project's code.
- **Why:** copied code carries its license with it, including notices that must be kept. Independent code carries none.

## D-8 · Releases are GitHub Releases only

- **Decision:** a `v*` tag runs every CI and security gate, then attaches a source archive of the tagged tree and its `SHA256SUMS` to a GitHub Release (`.github/workflows/release.yml`). Nothing is published to npm or an extension marketplace. The tag must equal `v` + the root `package.json` version.
- **Why a source archive:** the CLI imports the other packages by relative path, so the `cli` package alone would not run. The shipped code has no third-party runtime dependencies, so the archive plus Node is the whole install.
- **Why:** one release channel to secure and support while the product is pre-1.0.

## D-9 · Every CI check blocks, and exceptions expire

- **Decision:** lint, format, typecheck, hygiene, tests on Linux, Windows and macOS with Node 22 and 24, CodeQL, dependency review, OSV and a full-history secret scan all fail the run. A known advisory or a fake test secret is excused by name in `osv-scanner.toml` or `.gitleaks.toml`, never by turning a scan off. An OSV exception has an `ignoreUntil` date.
- **Why:** a check that only warns is ignored within a week. An exception with an end date gets looked at again; a disabled scan does not.
- **Cost:** a new advisory in a dev tool can turn the weekly run red with no code change. That is the point: someone decides.

## D-10 · An approval belongs to the exact spec text

- **Decision:** `ctrlplane spec approve` writes `approved_hash` next to `status: approved`. A spec whose title and body no longer match that hash loads as `draft`, and so does a spec marked approved by hand with no hash. Agents may not run `spec approve`.
- **Why:** the approved spec is injected into every session as the agreed criteria. If an edit kept the approval, an agent could change a criterion and still have it shown as agreed.
- **Cost:** a spec approved before this change, or edited after approval, must be approved again.

## D-11 · Docker is for developing the CLI, not for running it

- **Decision:** `.devcontainer/` gives contributors the toolchain CI uses (Node 24, Go 1.27, make, git), and CI runs `make ci` inside it. There is no image for running the CLI, the daemon or the hooks.
- **Why:** the agent starts `ctrlplane hook` before every tool call, on the machine where the agent runs, with a 1500 ms budget. Starting a container per call would spend most of that budget, and the hook would see only the folders shared with the container. The daemon also has to read the same project folders and git state as the agent. Version drift for users is handled by `engines`, `.nvmrc`, `npm ci` and the CI matrix; the dev container removes it for contributors.
- **Cost:** two base images to keep current (Dependabot updates their digests; a new Node or Go release line is moved by hand, together with `.nvmrc`, `engines` and the workflows).

## D-12 · The code is MIT licensed

- **Decision:** the code is released under the MIT License (`LICENSE` at the repo root).
- **Why:** it makes the project open source with the fewest conditions for users and contributors: they only have to keep the copyright and license notice.
- **Cost:** anyone may reuse the code, including commercially, with no obligation to share their changes.

## D-13 · Supervisor API keys live only in the OS keychain

- **Decision:** `ctrlplane supervisor` manages the provider and API key for the dashboard's supervisor. This is a deliberate step past D-5, which kept AgentDock free of key management. Keys are read at a hidden prompt or from `--stdin` and stored in the OS keychain through each OS's own tool (Windows Credential Manager through Windows PowerShell, macOS `security`, Linux `secret-tool`). The key reaches the tool on stdin, never in its arguments. The provider, model and base URL go in `$CTRLPLANE_HOME/supervisor.json`, which holds no secret and is written through a temp file and a rename. Agents are denied `supervisor use|set-key|remove-key`.
- **Why:** a key in a file or an argument ends up in backups, shell history or the process list. Calling the OS tools keeps the shipped code free of third-party runtime dependencies (D-8) and of native modules. A Windows script read from stdin is used because `cmdkey` would put the key in its arguments.
- **Cost:** Linux users need `libsecret-tools` and a running Secret Service. Each Windows keychain call starts PowerShell (about a second). The tool calls are tested with a fake runner in CI; the real keychain test (`packages/cli/tests/keychain-os.test.ts`) runs only with `AGENTDOCK_REAL_KEYCHAIN=1`.

## D-14 · The daemon records Claude Code cost; nothing else reads transcripts

- **Decision:** after a Claude Code `Stop` or `SessionEnd`, the daemon reads that session's transcript and replaces the session's rows in `session_usage`: one row per model with token counts, cost at the catalog price of the day, an unknown-model flag and the turn count. No prompt, reply or file name is stored. The transcript path comes from the hook payload, so the file is read only when its real path (links resolved) is a `.jsonl` file of at most 50 MB under the real `~/.claude/projects`. It is streamed line by line and never read past 50 MB. A refused or failed read logs one line with the reason or error code and the session id, never the path, and keeps the earlier rows. The job waits until the session has been quiet for one second, runs off the hook's path and is never retried; the next Stop reads the whole file again. Hooks recorded without a daemon get no cost. `idx_events_created_at` is built by the daemon at start, not when the database opens.
- **Why:** cost is per model because each model has its own price. Replacing instead of adding makes a second read of the same file harmless. A path an agent sends could point at any file, so it is checked after links are resolved. Parsing a large transcript takes tens of milliseconds of the daemon's time, so a burst of Stops is read once, after it ends, and the hook keeps its speed. Building an index holds the write lock; every hook process opens the database, so only the long-running daemon builds it.
- **Cost:** cost appears about a second after Claude Code stops, and only while the daemon runs. Stored cost does not change when prices do; the token counts are kept so it can be recomputed later. Codex and OpenCode sessions get no cost until their transcripts can be parsed.

## D-15 · CONSTRAINTS.md holds the merge bar, and new gates warn for two weeks first

- **Decision:** `CONSTRAINTS.md` lists every check that decides whether a change can merge, with its number, the command that produces the verdict and where it runs. The coverage gate and the hook-latency check read their numbers from it, so a number is written in one place. A floor of moves that lower the bar (new suppression comments, stubs, skipped or deleted tests, removed assertions, a loosened threshold or a new exception) is checked on the diff after every agent edit and in CI, and blocks from the start. Changed-line coverage, architecture (dependency-cruiser, a dev dependency) and hook latency warn until 2026-12-05 and block after it. `.claude/settings.json` runs the floor after each edit and the task-end checks when an agent stops with uncommitted code changes.
- **Why:** agents write more code than anyone reads line by line, so the bar has to live in checks that run inside their loop, with numbers chosen once instead of argued per PR. A threshold read from the file that documents it cannot drift from its documentation. Two weeks of warnings let the numbers, measured on one Windows machine, be checked against CI before they cost a red build; D-9's rule that every check blocks applies once the window ends.
- **Cost:** CI's `constraints` job runs the suite a second time with coverage, and checks out the full history for the merge base. dependency-cruiser joins the dev dependencies that osv-scanner and Dependabot watch. The floor guard is a set of regular expressions: it catches the cheap ways to turn a check green, not a determined attempt to hide a change.

## D-16 · A repo's own config can only tighten supervision

- **Decision:**
  - `.ctrlplane/policies.json`, the project file committed with the repo, can only tighten a rule. Turning a rule off, setting it to observe, or giving it a less strict action is ignored with a warning, and `policies disable|observe` write to `policies.local.json` instead.
  - `customRulesFile` is read only from `$CTRLPLANE_HOME/policies.json`, and only as a real path inside `CTRLPLANE_HOME`.
  - A relative `CTRLPLANE_HOME` is refused.
  - A daemon control frame is built only by `sendDaemonControl`, and shutdown needs the token the daemon writes into `daemon.lock` at each start.
- **Why:** a cloned repo, or an agent that writes its config, decides what that file says. Before this:
  - the repo could switch off the secret-read and destructive-shell rules (ISSUE.md I-62);
  - it could run its own code in the hook and the daemon (I-61);
  - it could point user state into the project (I-67);
  - and an agent could stop the daemon through its own hook payload (I-63).
- **Cost:**
  - A team can no longer ship a softer rule set in the repo; each developer sets it in `policies.local.json` or their user config.
  - Custom rules move to the user config.
  - Params such as allow lists can still be set from the project file.

## D-17 · AgentDock supervises agents; it never runs them

- **Decision:**
  - AgentDock is a local supervisor for coding agents that an agent harness (Claude Code, Codex, OpenCode) runs.
  - **What AgentDock owns:**
    - the verdict on each tool call;
    - the audit trail;
    - the session lifecycle as the harness reports it through hooks (start, stop, handoff, waiting for approval);
    - the context a new session starts with.
  - **What it does not do:**
    - It does not start, schedule, retry or sandbox agents: no agent processes, containers, job queues, task graphs or scheduling.
    - It is not a network proxy. It sees only what a harness's hooks report.
    - It is not a secrets manager. The harness keeps its own credentials.
    - It offers no SDK or middleware for developers who build their own agents.
  - **Who it is for:**
    - It is built for one developer using a harness on their own machine.
    - A team stays possible later only through portable artifacts: the project policy committed with the repo (D-16) and an exported audit trail. No hosting, accounts or multi-tenancy are built.
  - **The audit trail:** it is a local SQLite event log in `.ctrlplane/audit.db`, protected by policy rules. It is not called immutable unless tamper evidence, such as a hash chain, is built.
  - **Naming:** AgentDock is "the local safety and audit layer for AI coding agents". It is not described as a "control plane" or an "orchestrator".
  - **The editor extension** leaves the AgentDock repo; editor work, if it comes back, gets its own repo.
- **Why:**
  - The hook path is agent-neutral, and that is where AgentDock's value sits.
  - Harnesses and agent frameworks already own execution, and change fast.
  - A proxy, a secrets broker, an SDK and team hosting would each be a separate product with different competitors.
  - The guard still has open gaps that matter more to a developer than any of those: `ISSUE.md` I-46 (shell forms the rules still allow) and I-48 (a crash in the hook allows the tool call outside CI).
  - The extension has never loaded (AgentDock `ISSUE.md` I-6).
- **Cost:**
  - AgentDock depends on harnesses keeping their hook APIs, and cannot govern what no hook shows it.
  - Developers building their own agents and teams wanting central policy are not served.
  - Hardening the hook path, I-46 and I-48 first, comes before any new capability.
  - Removing the extension, and changing the CLI help text and both READMEs to the new name, are follow-up tasks.

## D-18 · A crash in the hook blocks the tool call, and only the developer can get past it

- **Decision:**
  - When the hook fails unexpectedly while judging a `PreToolUse` call, it denies the call, locally as in CI.
  - The denial names the error and the way out: "Run 'ctrlplane pause' in your terminal to temporarily bypass, or report this bug."
  - Agents stay unable to run `ctrlplane pause` themselves (D-6, `CLI_COMMAND_SAFETY`).
  - A crash in any other hook event (prompt submit, session start, stop, `PostToolUse`) lets the event through and prints a `[ctrlplane warning] ...` line on stderr.
  - **The pause is the way out, and it is checked first.**
    - The hook reads the pause state before it parses the payload, loads config or evaluates any rule.
    - The check uses nothing that can throw. If it fails anyway, the hook treats the project as not paused.
  - **While a pause is active, a crash allows the call.** This covers a crash anywhere: in parsing, config loading, or an always-on rule. Without a pause, a crash still denies.
  - **A call allowed this way is recorded.** It gets an audit row with verdict `ALLOW` and rule `CRASH-WHILE-PAUSED`, so the `audit.db` contract and the dashboard stay unchanged.
  - **What the row stores, under D-4:**
    - **If the redactor works:** the payload and the error message, both redacted.
    - **If the redactor throws:** only the tool name, the payload's size in bytes, a SHA-256 of the payload and the error's type. No argument text.
    - **Stack frames:** only AgentDock's own, with paths relative to AgentDock. No absolute paths, home folders, project files or command text.
  - **If writing the row fails,** one stderr line with the same fields goes out instead. That failure never crashes the hook.
- **Why:**
  - A crash is the one case where nothing judged the call, so allowing it would let an agent buy an unsupervised call by making the hook fail (D-17).
  - The other events run nothing, so failing them would lock the session without protecting anything.
  - The pause has to be read before anything that can crash, or the way out the message names would not work.
  - Allowing crashes only during a pause keeps them developer-only, because agents cannot start a pause.
- **Cost:**
  - A bad release stops every agent's tool calls until the developer pauses or fixes it.
  - During a pause, an agent that can make the hook crash gets that call unsupervised. Always-on rules no longer protect it, and it is only recorded.
  - When the redactor is what crashed, the record shows that a call ran but not what it contained.

## D-19 · AgentDock catches mistakes; it is not a boundary against a hostile agent

- **Decision:**
  - AgentDock's promise is a guardrail: it catches the destructive things agents do by mistake or by being over-eager, and keeps the record. Examples: recursive deletes, force pushes and branch clobbering, reading secret files, edits to its own state.
  - It is not a sandbox, and does not claim to contain an agent that is deliberately trying to evade supervision. That containment belongs to the OS, a container, or the harness's own sandbox, and the README says so plainly.
  - Rules stay a deny-list.
  - Known evasion forms are closed when they are cheap and likely; the rest are listed as known limits.
  - Strict allow-listing ("ask before any command not explicitly allowed") is not built now; it may come later if users ask for it.
- **Why:**
  - A deny-list over shell commands can never be complete (`ISSUE.md` I-46), and only an OS-level sandbox truly contains a shell.
  - Agents cause harm by mistake far more often than by attack.
  - A promise the code can keep is worth more than a broader one it cannot.
  - Strict allow-listing would mean an approval prompt on ordinary work.
- **Cost:**
  - An agent that sets out to evade AgentDock can.
  - Developers who need containment must add a sandbox themselves.
  - I-46 closes as documented limits plus a few targeted fixes, not as complete shell coverage.

## D-20 · AgentDock keeps only what serves D-17; six features are removed

- **Decision:**
  - **Kept:**
    - the policy rules and verdicts, `pause` and the loop breaker;
    - the audit trail, with its search and timeline;
    - the approval lifecycle ("Needs you", Waiting on you);
    - the context pack: intents, session summaries, handoff notes, project memory, and the approved spec (D-6, D-10);
    - session cost recorded by the daemon (D-14);
    - `ctrlplane explain`, as a deterministic diff summary with blast radius and dependency changes.
  - **Removed:**
    - `ctrlplane verify` and the `verifier` package: AgentDock does not grade an agent's work;
    - `ctrlplane commit`: AgentDock does not stage files or author commits;
    - `ctrlplane coach`;
    - `ctrlplane cost`;
    - `ctrlplane backtrace`: the daemon stays the only reader of transcripts (D-14), so the parsing code it uses stays;
    - the comprehension quiz in `ctrlplane explain`.
  - **The dashboard:** it reviews what agents did: audit, timeline, approvals and the diff. It does not author plans: the Plan & review interview goes. Whether the AI explanation of a diff stays is not decided yet.
- **Why:**
  - Each removed feature sits outside the four things D-17 says AgentDock owns: verdicts, the audit trail, the session lifecycle, and session context.
  - `verify` could never pass from the CLI (`ISSUE.md` I-47), and `commit` staged every file, secrets included (I-6).
  - A smaller surface is less to secure, test and explain.
- **Cost:**
  - Anyone using these commands loses them; the README lists them today.
  - `ctrlplane explain` no longer quizzes the developer on a change.
  - Removing each command also removes its entry in `CLI_COMMAND_SAFETY`.

## D-21 · AgentDock calls no model provider and holds no keys; supersedes D-13

- **Decision:**
  - AgentDock sends nothing to a model provider and stores no API keys.
  - **Removed from the dashboard:**
    - the AI explanation of a diff;
    - with it, all of its provider stack: the Codex, Claude and OpenAI-compatible providers, `supervisor.json`, keychain reads, the `/api/supervisor/*` and `/api/reviewer/explain` routes, and the Settings page.
  - **Removed from the CLI:** `ctrlplane supervisor` (`use`, `set-key`, `remove-key`, `status`) and the OS keychain code.
  - The files AgentDock copied for them (`keychain.ts`, `supervisor-config.ts`) go too.
  - In their place, the dashboard's diff view shows the deterministic summary `ctrlplane explain` computes: blast radius and dependency changes.
  - This supersedes D-13. In AgentDock it supersedes D-3, D-9 and D-10, recorded there.
- **Why:**
  - The developer's own harness can already explain the diff it wrote. AgentDock's value is the neutral record and the guardrail, not a second model's opinion.
  - Code never leaves the machine and no secret is held, which is what "local safety and audit layer" promises.
  - The provider stack carried most of the security findings of the 2026-11-22 review, M1 and M2 among them.
- **Cost:**
  - About two weeks of provider work is retired.
  - Developers lose a plain-language review inside the dashboard.
  - **Not decided yet:**
    - D-5's opt-in AI session summaries still run the local `claude -p`, which conflicts with "AgentDock calls no model";
    - how the deterministic summary reaches the dashboard. The backend may not import CLI code (AgentDock D-10, its architecture rules), and the blast-radius code is not a standalone file that can be copied.
