import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Session,
  Specification,
  AuditEvent,
  FileSnapshot,
  VerificationReport,
  CriterionFinding,
} from "../../core/src/index.ts";
import { redactObject } from "./redactor.ts";
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
    const resolvedBlobDir =
      blobDir ?? (dbPath === ":memory:" ? "./.ctrlplane/blobs" : join(dirname(dbPath), "blobs"));
    this.blobStore = new BlobStore(resolvedBlobDir);

    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
    } catch {
      // Memory DB or unsupported pragma fallback
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
        created_at INTEGER NOT NULL
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
      session.metadata ? JSON.stringify(session.metadata) : null
    );
    return Number(res.changes) > 0;
  }

  public updateSessionGit(id: string, gitBranch: string, baseCommitSha: string): void {
    this.db.prepare(`UPDATE sessions SET git_branch = ?, base_commit_sha = ? WHERE id = ?`).run(gitBranch, baseCommitSha, id);
  }

  public lastSequenceNum(sessionId: string): number {
    const row = this.db.prepare(`SELECT max(sequence_num) AS n FROM events WHERE session_id = ?`).get(sessionId) as
      | { n: number | null }
      | undefined;
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
      session.metadata ? JSON.stringify(session.metadata) : null
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
    let sanitizedOutput = event.toolOutput ? redactObject(event.toolOutput) : null;
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
        policy_verdict, policy_reason, execution_duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      event.policyReason ?? null,
      event.executionDurationMs ?? null,
      event.createdAt
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
        executionDurationMs: r.execution_duration_ms
          ? Number(r.execution_duration_ms)
          : undefined,
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
      spec.createdAt
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
      report.createdAt
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
        finding.rationale
      );
    }
  }

  public close(): void {
    this.db.close();
  }
}
