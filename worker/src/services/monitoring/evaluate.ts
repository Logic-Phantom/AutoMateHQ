import type { IncidentSeverity, ProjectStatus } from '../../../../shared/constants';
import { all, bool, stmt, type Db, type DbStatement } from '../../lib/db';
import { getIntegration } from '../../repositories/integrations';
import { listProjects, listSources, type ProjectRow, type SourceRow } from '../../repositories/projects';
import { listOpenIncidents, MANAGED_CATEGORIES, reconcileProjectIncidents, type IncidentTransition } from '../incidents/engine';
import { classify, primaryReason, type Classification, type PublicationLite, type RunLite } from './classifier';

export interface ProjectEvaluation {
  project: ProjectRow;
  classification: Classification;
}

export interface EvaluationResult {
  evaluations: ProjectEvaluation[];
  transitions: IncidentTransition[];
}

interface RunRow {
  id: number;
  project_id: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  workflow_name: string | null;
  error_code: string | null;
  safe_error_message: string | null;
}

/**
 * 활성 프로젝트 전체를 판정한다. 읽기는 프로젝트 수와 무관하게 고정 개수 쿼리, 쓰기는 batch 1회.
 * (D1 무료 플랜의 호출당 쿼리 수 제한을 고려)
 */
export async function evaluateAll(db: Db, now: Date, opts: { persist: boolean } = { persist: true }): Promise<EvaluationResult> {
  const since = new Date(now.getTime() - 15 * 86400_000).toISOString();
  const [projects, sources, runs, pubs, openIncidents, github] = await Promise.all([
    listProjects(db, true),
    listSources(db),
    all<RunRow>(
      db,
      `SELECT id, project_id, status, started_at, completed_at, workflow_name, error_code, safe_error_message
       FROM runs WHERE COALESCE(started_at, created_at) >= ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT 2000`,
      since,
    ),
    all<{ project_id: number; status: string; platform: string; title: string | null; updated_at: string; error_code: string | null }>(
      db,
      `SELECT project_id, status, platform, title, updated_at, error_code FROM publications WHERE updated_at >= ? ORDER BY updated_at DESC`,
      since,
    ),
    listOpenIncidents(db),
    getIntegration(db, 'github'),
  ]);

  const byProject = <T extends { project_id: number }>(rows: T[]) => {
    const map = new Map<number, T[]>();
    for (const r of rows) {
      const list = map.get(r.project_id) ?? [];
      list.push(r);
      map.set(r.project_id, list);
    }
    return map;
  };
  const runsBy = byProject(runs);
  const pubsBy = byProject(pubs);
  const sourcesBy = byProject<SourceRow>(sources);

  const evaluations: ProjectEvaluation[] = [];
  const transitions: IncidentTransition[] = [];
  const writes: DbStatement[] = [];
  const iso = now.toISOString();

  for (const p of projects) {
    const srcs = (sourcesBy.get(p.id) ?? []).filter((s) => bool(s.is_enabled));
    const runLites: RunLite[] = (runsBy.get(p.id) ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      workflowName: r.workflow_name,
      errorCode: r.error_code,
      safeErrorMessage: r.safe_error_message,
    }));
    const pubLites: PublicationLite[] = (pubsBy.get(p.id) ?? []).map((x) => ({
      status: x.status,
      platform: x.platform,
      title: x.title,
      updatedAt: x.updated_at,
      errorCode: x.error_code,
    }));
    const external = openIncidents
      .filter((i) => i.project_id === p.id && !MANAGED_CATEGORIES.includes(i.category) && i.status === 'open')
      .map((i) => ({ severity: i.severity as IncidentSeverity, title: i.title, category: i.category }));

    const classification = classify({
      project: {
        id: p.id,
        isActive: bool(p.is_active),
        monitoringMode: p.monitoring_mode,
        hasGithubSource: srcs.some((s) => s.source_type === 'github_actions'),
        hasHeartbeatSource: srcs.some((s) => s.source_type === 'heartbeat'),
        createdAt: p.created_at,
        schedule: {
          cadence: p.expected_cadence,
          expectedDays: p.expected_days ? p.expected_days.split(',').map(Number) : [],
          intervalHours: p.interval_hours,
          expectedTimeLocal: p.expected_time_local,
          timezone: p.timezone,
          gracePeriodMinutes: p.grace_period_minutes,
        },
      },
      runs: runLites,
      publications: pubLites,
      githubIntegrationStatus: github?.status ?? 'not_connected',
      githubIntegrationError: github?.last_error_message_safe,
      lastSyncErrorCode: p.last_sync_error_code,
      externalIncidents: external,
      now,
    });
    evaluations.push({ project: p, classification });

    if (!opts.persist) continue;
    const reason = primaryReason(classification);
    writes.push(
      stmt(
        db,
        `UPDATE projects SET last_status=?, last_status_reason=?, last_evaluated_at=? WHERE id=?`,
        classification.status,
        reason?.message ?? null,
        iso,
        p.id,
      ),
    );
    // 비활성 프로젝트는 incident를 새로 열지 않고, 열린 것은 정리한다.
    const reasons = bool(p.is_active) ? classification.reasons : [];
    const rec = reconcileProjectIncidents(db, p.id, reasons, openIncidents, now);
    writes.push(...rec.statements);
    if (bool(p.is_active)) transitions.push(...rec.transitions);
  }

  if (opts.persist && writes.length > 0) {
    // D1 batch는 트랜잭션으로 실행된다. 너무 길어지지 않게 나눈다.
    for (let i = 0; i < writes.length; i += 80) await db.batch(writes.slice(i, i + 80));
  }
  return { evaluations, transitions };
}

export function statusOf(e: ProjectEvaluation): { isActive: boolean; status: ProjectStatus } {
  return { isActive: bool(e.project.is_active), status: e.classification.status };
}
