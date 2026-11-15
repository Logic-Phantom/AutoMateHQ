import { first, run, stmt, type Db, type DbStatement } from '../lib/db';
import { redact } from '../security/redact';

export interface RunUpsert {
  projectId: number;
  sourceId: number | null;
  sourceType: 'github_actions' | 'heartbeat';
  externalRunId: string;
  triggerType?: string | null;
  workflowName?: string | null;
  runAttempt?: number;
  status: string;
  stage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  externalUrl?: string | null;
  summary?: string | null;
  errorCode?: string | null;
  safeErrorMessage?: string | null;
  metrics?: Record<string, number> | null;
}

/**
 * 실행 기록 upsert. 같은 (프로젝트, 소스, 외부 run id) 는 한 행만 유지한다.
 * 완료 상태가 다시 running으로 되돌아가지 않게 한다(늦게 도착한 start 이벤트 대비).
 */
export function upsertRunStmt(db: Db, r: RunUpsert, now: Date): DbStatement {
  const iso = now.toISOString();
  const duration =
    r.startedAt && r.completedAt
      ? Math.max(0, Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000))
      : null;
  return stmt(
    db,
    `INSERT INTO runs (project_id, source_id, source_type, external_run_id, trigger_type, workflow_name, run_attempt, status, stage,
       started_at, completed_at, duration_seconds, branch, commit_sha, external_url, summary, error_code, safe_error_message,
       metrics_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id, source_type, external_run_id) DO UPDATE SET
       status = CASE
         WHEN runs.status IN ('success','failure','cancelled','skipped') AND excluded.status IN ('queued','running')
              AND excluded.run_attempt <= runs.run_attempt THEN runs.status
         ELSE excluded.status END,
       stage = COALESCE(excluded.stage, runs.stage),
       trigger_type = COALESCE(excluded.trigger_type, runs.trigger_type),
       workflow_name = COALESCE(excluded.workflow_name, runs.workflow_name),
       run_attempt = MAX(excluded.run_attempt, runs.run_attempt),
       started_at = COALESCE(runs.started_at, excluded.started_at),
       completed_at = COALESCE(excluded.completed_at, runs.completed_at),
       duration_seconds = CASE
         WHEN COALESCE(excluded.completed_at, runs.completed_at) IS NOT NULL AND COALESCE(runs.started_at, excluded.started_at) IS NOT NULL
         THEN MAX(0, CAST(ROUND((julianday(COALESCE(excluded.completed_at, runs.completed_at))
                                 - julianday(COALESCE(runs.started_at, excluded.started_at))) * 86400) AS INTEGER))
         ELSE runs.duration_seconds END,
       branch = COALESCE(excluded.branch, runs.branch),
       commit_sha = COALESCE(excluded.commit_sha, runs.commit_sha),
       external_url = COALESCE(excluded.external_url, runs.external_url),
       summary = COALESCE(excluded.summary, runs.summary),
       error_code = excluded.error_code,
       safe_error_message = excluded.safe_error_message,
       metrics_json = CASE WHEN excluded.metrics_json = '{}' THEN runs.metrics_json ELSE excluded.metrics_json END,
       updated_at = excluded.updated_at`,
    r.projectId,
    r.sourceId,
    r.sourceType,
    r.externalRunId,
    r.triggerType ?? null,
    r.workflowName ?? null,
    r.runAttempt ?? 1,
    r.status,
    r.stage ?? null,
    r.startedAt ?? null,
    r.completedAt ?? null,
    duration,
    r.branch ?? null,
    r.commitSha ?? null,
    r.externalUrl ?? null,
    r.summary ? redact(r.summary, 500) : null,
    r.errorCode ?? null,
    r.safeErrorMessage ? redact(r.safeErrorMessage, 300) : null,
    JSON.stringify(r.metrics ?? {}),
    iso,
    iso,
  );
}

export async function upsertRun(db: Db, r: RunUpsert, now: Date): Promise<number> {
  await upsertRunStmt(db, r, now).run();
  const row = await first<{ id: number }>(
    db,
    `SELECT id FROM runs WHERE project_id=? AND source_type=? AND external_run_id=?`,
    r.projectId,
    r.sourceType,
    r.externalRunId,
  );
  return row!.id;
}

export async function addRunEvent(
  db: Db,
  runId: number,
  eventType: string,
  now: Date,
  extra: { status?: string | null; stage?: string | null; message?: string | null } = {},
) {
  await run(
    db,
    `INSERT INTO run_events (run_id, event_type, status, stage, message, created_at) VALUES (?,?,?,?,?,?)`,
    runId,
    eventType,
    extra.status ?? null,
    extra.stage ?? null,
    extra.message ? redact(extra.message, 500) : null,
    now.toISOString(),
  );
}
