import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Session, Specification, AuditEvent, VerificationReport } from "../../core/src/index.ts";
import { redactObject, redactSecrets } from "./redactor.ts";
import { BlobStore, BLOB_THRESHOLD_BYTES } from "./blob.ts";

export class StorageEngine {
  private db: DatabaseSync;
  private blobStore: BlobStore;

  constructor(dbPath: string = ":memory:", blobDir?: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(dbPath);
    // An in-memory store must not write into whatever folder the process happens to run in. Its blobs go to a
    // fresh temp folder with a random name, made on the first blob write: a fixed name (such as one built from
    // the pid) could be created first by another local user, who could then read or plant blobs.
    const resolvedBlobDir =
      blobDir ??
      (dbPath === ":memory:" ? () => mkdtempSync(join(tmpdir(), "ctrlplane-blobs-")) : join(dirname(dbPath), "blobs"));
    this.blobStore = new BlobStore(resolvedBlobDir);

    this.initPragmas();
    this.initSchema();
    this.upgradeSchema();
  }

  private initPragmas(): void {
    // busy_timeout comes first and each pragma is tried on its own: a lock that makes the WAL switch fail must not
    // leave the rest unset. 1000 ms keeps a hook that waits on a locked database inside its 1500 ms budget.
    for (const pragma of ["busy_timeout = 1000", "journal_mode = WAL", "synchronous = NORMAL", "foreign_keys = ON"]) {
      try {
        this.db.exec(`PRAGMA ${pragma};`);
      } catch {
        // Memory DB, unsupported pragma or a locked database: keep the defaults for this one.
      }
    }
  }

  /**
   * Adds columns that newer versions write to a database an older version created. `CREATE TABLE IF NOT EXISTS`
   * leaves an existing table as it is, so each new column is added here. Old rows keep NULL in it.
   */
  private upgradeSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name),
    );
    if (columns.has("rule_id")) return;
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN rule_id TEXT;");
    } catch {
      // Another process (the daemon or a hook) added it first, or the database is read-only: both are fine.
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        project_path TEXT NOT NULL,
        git_branch TEXT NOT NULL,
        base_commit_sha TEXT NOT NULL,
        head_commit_sha TEXT,
        spec_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS specifications (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        overview TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        criteria_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by TEXT,
        approved_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence_num INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        tool_input_json TEXT,
        tool_output_json TEXT,
        is_blob_stored INTEGER NOT NULL DEFAULT 0,
        policy_verdict TEXT,
        policy_reason TEXT,
        execution_duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        rule_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence_num);

      CREATE TABLE IF NOT EXISTS file_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id),
        file_path TEXT NOT NULL,
        is_test_file INTEGER NOT NULL DEFAULT 0,
        change_type TEXT NOT NULL,
        diff_unified TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        spec_hash TEXT NOT NULL,
        git_commit_sha TEXT NOT NULL,
        overall_status TEXT NOT NULL,
        deterministic_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verification_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
        criterion_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        verdict TEXT NOT NULL,
        evidence_json TEXT,
        associated_test_file TEXT,
        rationale TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        meta_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_kind_time ON context_entries(kind, created_at);

      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, tags, content='memory', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, body, tags) VALUES (new.id, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, body, tags) VALUES ('delete', old.id, old.body, old.tags);
      END;
    `);
  }

  // --- Session Methods ---

  /** Creates the session row on first sight so its events satisfy the foreign key. Returns true if created. */
  public ensureSession(session: Session): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (
        id, agent_type, project_path, git_branch, base_commit_sha,
        head_commit_sha, spec_id, status, started_at, ended_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      session.id,
      session.agentType,
      session.projectPath,
      session.gitBranch,
      session.baseCommitSha,
      session.headCommitSha ?? null,
      session.specId ?? null,
      session.status,
      session.startedAt,
      session.endedAt ?? null,
      session.metadata ? JSON.stringify(session.metadata) : null,
    );
    return Number(res.changes) > 0;
  }

  public updateSessionGit(id: string, gitBranch: string, baseCommitSha: string): void {
    this.db
      .prepare(`UPDATE sessions SET git_branch = ?, base_commit_sha = ? WHERE id = ?`)
      .run(gitBranch, baseCommitSha, id);
  }

  public lastSequenceNum(sessionId: string): number {
    const row = this.db.prepare(`SELECT max(sequence_num) AS n FROM events WHERE session_id = ?`).get(sessionId) as
      { n: number | null } | undefined;
    return Number(row?.n ?? 0);
  }

  public insertSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, agent_type, project_path, git_branch, base_commit_sha,
        head_commit_sha, spec_id, status, started_at, ended_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.agentType,
      session.projectPath,
      session.gitBranch,
      session.baseCommitSha,
      session.headCommitSha ?? null,
      session.specId ?? null,
      session.status,
      session.startedAt,
      session.endedAt ?? null,
      session.metadata ? JSON.stringify(session.metadata) : null,
    );
  }

  public getSession(id: string): Session | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: String(row.id),
      agentType: row.agent_type as Session["agentType"],
      projectPath: String(row.project_path),
      gitBranch: String(row.git_branch),
      baseCommitSha: String(row.base_commit_sha),
      headCommitSha: row.head_commit_sha ? String(row.head_commit_sha) : undefined,
      specId: row.spec_id ? String(row.spec_id) : undefined,
      status: row.status as Session["status"],
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : undefined,
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
    };
  }

  public updateSessionStatus(id: string, status: Session["status"]): void {
    const endedAt = status === "completed" || status === "aborted" ? Date.now() : null;
    const stmt = this.db.prepare(`
      UPDATE sessions SET status = ?, ended_at = coalesce(?, ended_at) WHERE id = ?
    `);
    stmt.run(status, endedAt, id);
  }

  public listSessions(limit = 20): Session[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      agentType: row.agent_type as Session["agentType"],
      projectPath: String(row.project_path),
      gitBranch: String(row.git_branch),
      baseCommitSha: String(row.base_commit_sha),
      headCommitSha: row.head_commit_sha ? String(row.head_commit_sha) : undefined,
      specId: row.spec_id ? String(row.spec_id) : undefined,
      status: row.status as Session["status"],
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : undefined,
    }));
  }

  // --- Event Ingestion & Redaction ---

  public insertEvent(event: AuditEvent): void {
    // Redact sensitive credentials prior to disk writes
    const sanitizedInput = event.toolInput ? redactObject(event.toolInput) : null;
    const sanitizedOutput = event.toolOutput ? redactObject(event.toolOutput) : null;
    let isBlobStored = 0;

    let outputJson = sanitizedOutput ? JSON.stringify(sanitizedOutput) : null;
    if (outputJson && outputJson.length > BLOB_THRESHOLD_BYTES) {
      const stored = this.blobStore.store(outputJson);
      outputJson = JSON.stringify({
        _blob_ref: stored.sha256,
        original_size: stored.originalSizeBytes,
      });
      isBlobStored = 1;
    }

    const stmt = this.db.prepare(`
      INSERT INTO events (
        id, session_id, sequence_num, event_type, tool_name,
        tool_input_json, tool_output_json, is_blob_stored,
        policy_verdict, policy_reason, execution_duration_ms, created_at, rule_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.sessionId,
      event.sequenceNum,
      event.eventType,
      event.toolName ?? null,
      sanitizedInput ? JSON.stringify(sanitizedInput) : null,
      outputJson,
      isBlobStored,
      event.policyVerdict ?? null,
      // A policy reason quotes the command that triggered it, so it can carry the same secrets as the input.
      event.policyReason ? redactSecrets(event.policyReason).sanitized : null,
      event.executionDurationMs ?? null,
      event.createdAt,
      event.ruleId ?? null,
    );
  }

  public listEventsForSession(sessionId: string): AuditEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? ORDER BY sequence_num ASC
    `);
    const rows = stmt.all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => {
      let output: Record<string, unknown> | undefined;
      if (r.tool_output_json) {
        const parsed = JSON.parse(String(r.tool_output_json));
        if (r.is_blob_stored === 1 && parsed._blob_ref) {
          try {
            output = JSON.parse(this.blobStore.retrieve(parsed._blob_ref));
          } catch {
            output = { _error: "blob_unavailable", ref: parsed._blob_ref };
          }
        } else {
          output = parsed;
        }
      }

      return {
        id: String(r.id),
        sessionId: String(r.session_id),
        sequenceNum: Number(r.sequence_num),
        eventType: r.event_type as AuditEvent["eventType"],
        toolName: r.tool_name ? String(r.tool_name) : undefined,
        toolInput: r.tool_input_json ? JSON.parse(String(r.tool_input_json)) : undefined,
        toolOutput: output,
        isBlobStored: r.is_blob_stored === 1,
        policyVerdict: r.policy_verdict as AuditEvent["policyVerdict"],
        policyReason: r.policy_reason ? String(r.policy_reason) : undefined,
        executionDurationMs: r.execution_duration_ms ? Number(r.execution_duration_ms) : undefined,
        ruleId: r.rule_id ? String(r.rule_id) : undefined,
        createdAt: Number(r.created_at),
      };
    });
  }

  // --- Specifications ---

  public insertSpecification(spec: Specification): void {
    const stmt = this.db.prepare(`
      INSERT INTO specifications (
        id, session_id, version, title, overview, plan_json,
        criteria_json, hash, status, approved_by, approved_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      spec.id,
      spec.sessionId ?? null,
      spec.version,
      spec.title,
      spec.overview,
      JSON.stringify(spec.plan),
      JSON.stringify(spec.acceptanceCriteria),
      spec.hash,
      spec.status,
      spec.approvedBy ?? null,
      spec.approvedAt ?? null,
      spec.createdAt,
    );
  }

  public getSpecification(id: string): Specification | null {
    const stmt = this.db.prepare(`SELECT * FROM specifications WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: String(row.id),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      version: Number(row.version),
      title: String(row.title),
      overview: String(row.overview),
      plan: JSON.parse(String(row.plan_json)),
      acceptanceCriteria: JSON.parse(String(row.criteria_json)),
      hash: String(row.hash),
      status: row.status as Specification["status"],
      approvedBy: row.approved_by ? String(row.approved_by) : undefined,
      approvedAt: row.approved_at ? Number(row.approved_at) : undefined,
      createdAt: Number(row.created_at),
    };
  }

  // --- Verification Runs ---

  public insertVerificationRun(report: VerificationReport): void {
    const runStmt = this.db.prepare(`
      INSERT INTO verification_runs (
        id, session_id, spec_hash, git_commit_sha, overall_status,
        deterministic_json, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    runStmt.run(
      report.id,
      report.sessionId,
      report.specHash,
      report.gitCommitSha,
      report.overallStatus,
      JSON.stringify(report.deterministicResults),
      report.summary,
      report.createdAt,
    );

    const findingStmt = this.db.prepare(`
      INSERT INTO verification_findings (
        id, run_id, criterion_id, tier, verdict, evidence_json,
        associated_test_file, rationale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const finding of report.findings) {
      const findingId = `find_${Math.random().toString(36).slice(2, 10)}`;
      findingStmt.run(
        findingId,
        report.id,
        finding.criterionId,
        finding.tier,
        finding.verdict,
        finding.evidence ? JSON.stringify(finding.evidence) : null,
        finding.associatedTestFile ?? null,
        finding.rationale,
      );
    }
  }

  // --- Context (intents, summaries, handoffs, capability snapshots) ---

  public addContextEntry(entry: Omit<ContextEntry, "id" | "createdAt"> & { createdAt?: number }): number {
    const res = this.db
      .prepare(`INSERT INTO context_entries (session_id, kind, body, meta_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(
        entry.sessionId ?? null,
        entry.kind,
        redactSecrets(entry.body).sanitized,
        entry.meta ? JSON.stringify(redactObject(entry.meta)) : null,
        entry.createdAt ?? Date.now(),
      );
    return Number(res.lastInsertRowid);
  }

  /** Keeps a single row per (session, kind), for rolling summaries that are rewritten every turn. */
  public replaceContextEntry(
    entry: Omit<ContextEntry, "id" | "createdAt"> & { sessionId: string; createdAt?: number },
  ): number {
    this.db.prepare(`DELETE FROM context_entries WHERE kind = ? AND session_id = ?`).run(entry.kind, entry.sessionId);
    return this.addContextEntry(entry);
  }

  /** Newest first. */
  public listContextEntries(kind: ContextKind, options: { sessionId?: string; limit?: number } = {}): ContextEntry[] {
    const rows = (
      options.sessionId
        ? this.db
            .prepare(
              `SELECT * FROM context_entries WHERE kind = ? AND session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(kind, options.sessionId, options.limit ?? 20)
        : this.db
            .prepare(`SELECT * FROM context_entries WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(kind, options.limit ?? 20)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      sessionId: r.session_id ? String(r.session_id) : undefined,
      kind: String(r.kind) as ContextKind,
      body: String(r.body),
      meta: r.meta_json ? JSON.parse(String(r.meta_json)) : undefined,
      createdAt: Number(r.created_at),
    }));
  }

  // --- Project memory (full-text searchable notes) ---

  public addMemory(body: string, options: { tags?: string[]; pinned?: boolean } = {}): number {
    const res = this.db
      .prepare(`INSERT INTO memory (body, tags, pinned, created_at) VALUES (?, ?, ?, ?)`)
      .run(
        redactSecrets(body).sanitized,
        (options.tags ?? []).map((t) => redactSecrets(t).sanitized).join(" "),
        options.pinned ? 1 : 0,
        Date.now(),
      );
    return Number(res.lastInsertRowid);
  }

  public deleteMemory(id: number): boolean {
    return Number(this.db.prepare(`DELETE FROM memory WHERE id = ?`).run(id).changes) > 0;
  }

  /** Pinned first, then newest. */
  public listMemory(limit = 20): MemoryNote[] {
    return (
      this.db
        .prepare(`SELECT * FROM memory ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]
    ).map(toMemoryNote);
  }

  /** Ranked full-text search. Free text is reduced to quoted words so punctuation cannot break the FTS query syntax. */
  public searchMemory(query: string, limit = 10): MemoryNote[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const match = words.map((w) => `"${w}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.rowid WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts), m.pinned DESC LIMIT ?`,
      )
      .all(match, limit) as Record<string, unknown>[];
    return rows.map(toMemoryNote);
  }

  public close(): void {
    this.db.close();
  }
}

export type ContextKind = "intent" | "summary" | "compact" | "handoff" | "capabilities";

export interface ContextEntry {
  id: number;
  sessionId?: string;
  kind: ContextKind;
  body: string;
  meta?: Record<string, unknown>;
  createdAt: number;
}

export interface MemoryNote {
  id: number;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
}

function toMemoryNote(r: Record<string, unknown>): MemoryNote {
  return {
    id: Number(r.id),
    body: String(r.body),
    tags: String(r.tags ?? "")
      .split(" ")
      .filter(Boolean),
    pinned: Number(r.pinned) === 1,
    createdAt: Number(r.created_at),
  };
}
