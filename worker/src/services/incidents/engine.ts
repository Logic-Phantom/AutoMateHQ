import { SEVERITY_RANK, type IncidentSeverity } from '../../../../shared/constants';
import { all, first, parseJson, run, stmt, type Db, type DbStatement } from '../../lib/db';
import type { Reason } from '../monitoring/classifier';

export interface IncidentRow {
  id: number;
  project_id: number | null;
  source_id: number | null;
  fingerprint: string;
  severity: IncidentSeverity;
  category: string;
  title: string;
  description: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  related_run_id: number | null;
  occurrence_count: number;
  last_notified_at: string | null;
  last_notified_severity: string | null;
  metadata_json: string;
}

/** 엔진이 자동으로 열고 닫는 incident 범주. 그 외(인증 오류 등 이벤트성)는 이벤트 처리기가 관리한다. */
export const MANAGED_CATEGORIES = ['RUN_FAILED', 'MISSED_RUN', 'LONG_RUNNING', 'COLLECTION_ERROR', 'PUBLICATION_FAILED'];

export function fingerprintFor(projectId: number, code: string): string {
  return `project:${projectId}:${code}`;
}

export type IncidentTransition =
  | { kind: 'opened'; incident: Pick<IncidentRow, 'project_id' | 'severity' | 'title' | 'fingerprint'> }
  | { kind: 'escalated'; incident: Pick<IncidentRow, 'id' | 'project_id' | 'severity' | 'title' | 'fingerprint'> }
  | { kind: 'resolved'; incident: Pick<IncidentRow, 'id' | 'project_id' | 'severity' | 'title' | 'fingerprint'> };

/**
 * 판정 사유(managed)를 미해결 incident와 맞춘다.
 * - 새 사유 → incident 생성(opened)
 * - 같은 사유 지속 → last_seen 갱신, 관련 run이 바뀌면 occurrence_count 증가
 * - 심각도 상승 → escalated
 * - 사유가 사라짐 → resolved(복구)
 * 쓰기는 statements 배열로 돌려줘 호출자가 한 번의 batch로 실행한다(D1 쿼리 수 절약).
 */
export function reconcileProjectIncidents(
  db: Db,
  projectId: number,
  reasons: Reason[],
  openIncidents: IncidentRow[],
  now: Date,
): { statements: DbStatement[]; transitions: IncidentTransition[] } {
  const iso = now.toISOString();
  const statements: DbStatement[] = [];
  const transitions: IncidentTransition[] = [];
  const managed = reasons.filter((r) => r.managed && MANAGED_CATEGORIES.includes(r.code));
  const openByFp = new Map(
    openIncidents.filter((i) => i.project_id === projectId && MANAGED_CATEGORIES.includes(i.category)).map((i) => [i.fingerprint, i]),
  );

  for (const reason of managed) {
    const fp = fingerprintFor(projectId, reason.code);
    const severity = (reason.severity === 'info' ? 'low' : reason.severity) as IncidentSeverity;
    const existing = openByFp.get(fp);
    if (!existing) {
      statements.push(
        stmt(
          db,
          `INSERT INTO incidents (project_id, fingerprint, severity, category, title, description, status, first_seen_at,
             last_seen_at, related_run_id, occurrence_count, metadata_json)
           VALUES (?,?,?,?,?,?,'open',?,?,?,1,'{}')
           ON CONFLICT(fingerprint) WHERE status IN ('open','acknowledged') DO NOTHING`,
          projectId,
          fp,
          severity,
          reason.code,
          reason.message.slice(0, 200),
          reason.message,
          iso,
          iso,
          reason.relatedRunId ?? null,
        ),
      );
      transitions.push({ kind: 'opened', incident: { project_id: projectId, severity, title: reason.message, fingerprint: fp } });
    } else {
      openByFp.delete(fp);
      const newRun = reason.relatedRunId != null && reason.relatedRunId !== existing.related_run_id;
      const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity];
      statements.push(
        stmt(
          db,
          `UPDATE incidents SET last_seen_at=?, severity=?, title=?, description=?, related_run_id=COALESCE(?, related_run_id),
             occurrence_count = occurrence_count + ? WHERE id=?`,
          iso,
          escalated ? severity : existing.severity,
          reason.message.slice(0, 200),
          reason.message,
          reason.relatedRunId ?? null,
          newRun ? 1 : 0,
          existing.id,
        ),
      );
      if (escalated) transitions.push({ kind: 'escalated', incident: { ...existing, severity } });
    }
  }

  for (const stale of openByFp.values()) {
    statements.push(stmt(db, `UPDATE incidents SET status='resolved', resolved_at=?, last_seen_at=? WHERE id=?`, iso, iso, stale.id));
    transitions.push({ kind: 'resolved', incident: stale });
  }
  return { statements, transitions };
}

/** 이벤트성 incident(인증 오류, 서명 불일치 등)를 열거나 갱신한다. */
export async function raiseIncident(
  db: Db,
  input: {
    projectId: number | null;
    fingerprint: string;
    severity: IncidentSeverity;
    category: string;
    title: string;
    description?: string;
    relatedRunId?: number | null;
    metadata?: Record<string, unknown>;
  },
  now: Date,
): Promise<{ created: boolean; id: number }> {
  const iso = now.toISOString();
  const existing = await first<IncidentRow>(
    db,
    `SELECT * FROM incidents WHERE fingerprint = ? AND status IN ('open','acknowledged')`,
    input.fingerprint,
  );
  if (existing) {
    await run(
      db,
      `UPDATE incidents SET last_seen_at=?, occurrence_count=occurrence_count+1,
         severity = CASE WHEN ? > (CASE severity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 ELSE 3 END) THEN ? ELSE severity END
       WHERE id=?`,
      iso,
      SEVERITY_RANK[input.severity],
      input.severity,
      existing.id,
    );
    return { created: false, id: existing.id };
  }
  const res = await run(
    db,
    `INSERT INTO incidents (project_id, fingerprint, severity, category, title, description, status, first_seen_at, last_seen_at,
       related_run_id, occurrence_count, metadata_json) VALUES (?,?,?,?,?,?,'open',?,?,?,1,?)`,
    input.projectId,
    input.fingerprint,
    input.severity,
    input.category,
    input.title.slice(0, 200),
    input.description ?? '',
    iso,
    iso,
    input.relatedRunId ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
  return { created: true, id: res.meta.last_row_id };
}

export async function resolveByFingerprint(db: Db, fingerprint: string, now: Date): Promise<number> {
  const res = await run(
    db,
    `UPDATE incidents SET status='resolved', resolved_at=? WHERE fingerprint=? AND status IN ('open','acknowledged')`,
    now.toISOString(),
    fingerprint,
  );
  return res.meta.changes;
}

export const listOpenIncidents = (db: Db) =>
  all<IncidentRow>(db, `SELECT * FROM incidents WHERE status IN ('open','acknowledged') ORDER BY last_seen_at DESC`);

export function toIncidentDto(i: IncidentRow) {
  return {
    id: i.id,
    projectId: i.project_id,
    fingerprint: i.fingerprint,
    severity: i.severity,
    category: i.category,
    title: i.title,
    description: i.description,
    status: i.status,
    firstSeenAt: i.first_seen_at,
    lastSeenAt: i.last_seen_at,
    resolvedAt: i.resolved_at,
    relatedRunId: i.related_run_id,
    occurrenceCount: i.occurrence_count,
    metadata: parseJson<Record<string, unknown>>(i.metadata_json, {}),
  };
}
