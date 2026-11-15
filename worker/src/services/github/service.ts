import type { AppDeps, Env } from '../../env';
import { all, first, run, stmt, type Db } from '../../lib/db';
import { AppError, badRequest, conflict, notFound } from '../../lib/http';
import { audit } from '../../repositories/common';
import { getIntegration, markIntegrationStatus, readCredentials } from '../../repositories/integrations';
import type { ProjectRow, SourceRow } from '../../repositories/projects';
import { raiseIncident, resolveByFingerprint } from '../incidents/engine';
import { addRunEvent, upsertRunStmt } from '../runs';
import { GithubApiError, GithubClient, normalizeRunStatus, type WorkflowRunApi } from './client';

export interface GithubCredentials {
  token: string;
}

export async function getGithubClient(env: Env, db: Db, deps: AppDeps): Promise<{ client: GithubClient; integrationId: number } | null> {
  if (env.APP_MODE === 'demo') return null; // 샘플 모드에서는 외부 호출을 하지 않는다
  const row = await getIntegration(db, 'github');
  if (!row || row.status === 'not_connected') return null;
  const creds = await readCredentials<GithubCredentials>(env, row);
  if (!creds?.token) return null;
  return { client: new GithubClient(creds.token, deps.fetch), integrationId: row.id };
}

/** 인증/권한 오류는 연동 상태에 반영하고 전역 incident로 묶는다(프로젝트마다 중복 생성하지 않음). */
export async function recordGithubAuthError(db: Db, integrationId: number, err: GithubApiError, now: Date) {
  if (err.code === 'AUTH_INVALID') {
    await markIntegrationStatus(db, integrationId, 'reauth_required', now, { code: err.code, message: err.message });
    await raiseIncident(
      db,
      {
        projectId: null,
        fingerprint: 'integration:github:AUTH_INVALID',
        severity: 'high',
        category: 'INTEGRATION_AUTH',
        title: 'GitHub 토큰 인증 실패(401) — 토큰 재발급·재연결 필요',
        description: err.message,
      },
      now,
    );
  } else if (err.code === 'RATE_LIMITED') {
    await markIntegrationStatus(db, integrationId, 'connected', now, { code: err.code, message: err.message });
  }
}

export function runFromApi(project: ProjectRow, source: SourceRow | null, r: WorkflowRunApi) {
  const status = normalizeRunStatus(r.status, r.conclusion);
  return {
    projectId: project.id,
    sourceId: source?.id ?? null,
    sourceType: 'github_actions' as const,
    externalRunId: String(r.id),
    triggerType: r.event,
    workflowName: r.name,
    runAttempt: r.run_attempt ?? 1,
    status,
    startedAt: r.run_started_at ?? r.created_at,
    completedAt: r.status === 'completed' ? r.updated_at : null,
    branch: r.head_branch,
    commitSha: r.head_sha,
    externalUrl: r.html_url,
    errorCode: status === 'failure' ? (r.conclusion ?? 'failure').toUpperCase() : null,
    safeErrorMessage: status === 'failure' ? `GitHub Actions ${r.conclusion ?? 'failure'}` : null,
  };
}

/**
 * GitHub Actions 실행 기록 동기화(폴링). Webhook이 놓친 이벤트를 보완한다.
 * 한 번에 몇 개 프로젝트만 처리한다(무료 플랜 subrequest/CPU 제한).
 */
export async function syncGithubProjects(
  env: Env,
  db: Db,
  deps: AppDeps,
  opts: { maxProjects: number; projectId?: number },
): Promise<{ synced: number; errors: number; skipped: string | null }> {
  const gh = await getGithubClient(env, db, deps);
  if (!gh) return { synced: 0, errors: 0, skipped: 'GitHub 미연결' };
  const now = deps.now();
  const projects = opts.projectId
    ? await all<ProjectRow>(db, `SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`, opts.projectId)
    : await all<ProjectRow>(
        db,
        `SELECT p.* FROM projects p WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.repo_owner IS NOT NULL
           AND EXISTS (SELECT 1 FROM project_sources s WHERE s.project_id = p.id AND s.source_type='github_actions' AND s.is_enabled=1)
         ORDER BY COALESCE(p.last_synced_at, '') ASC LIMIT ?`,
        opts.maxProjects,
      );
  let synced = 0;
  let errors = 0;
  for (const p of projects) {
    const source = await first<SourceRow>(
      db,
      `SELECT * FROM project_sources WHERE project_id=? AND source_type='github_actions' AND is_enabled=1 LIMIT 1`,
      p.id,
    );
    try {
      // event로 거르지 않는다: 예약 실행이 실패해 수동(workflow_dispatch)으로 다시 돌린 경우도 같은 회차로 인정한다.
      const runs = await gh.client.listRuns(p.repo_owner!, p.repo_name!, {
        workflowFile: source && source.external_identifier !== '*' ? source.external_identifier : null,
        perPage: 15,
      });
      const iso = now.toISOString();
      await db.batch([
        ...runs.map((r) => upsertRunStmt(db, runFromApi(p, source, r), now)),
        stmt(db, `UPDATE projects SET last_synced_at=?, last_sync_error_code=NULL WHERE id=?`, iso, p.id),
      ]);
      await resolveByFingerprint(db, 'integration:github:AUTH_INVALID', now);
      synced++;
    } catch (err) {
      errors++;
      const e = err instanceof GithubApiError ? err : new GithubApiError('NETWORK_ERROR', null, String(err));
      await run(db, `UPDATE projects SET last_synced_at=?, last_sync_error_code=? WHERE id=?`, now.toISOString(), e.code, p.id);
      await recordGithubAuthError(db, gh.integrationId, e, now);
      if (e.code === 'AUTH_INVALID' || e.code === 'RATE_LIMITED') break; // 나머지 프로젝트도 실패할 것이므로 중단
    }
  }
  return { synced, errors, skipped: null };
}

/** 워크플로 비활성화/삭제 감지. 연결 테스트 시 호출한다. */
export async function checkWorkflowState(gh: GithubClient, p: ProjectRow, workflowFile: string | null) {
  const repo = await gh.getRepo(p.repo_owner!, p.repo_name!);
  const workflows = await gh.listWorkflows(p.repo_owner!, p.repo_name!);
  const target = workflowFile ? workflows.find((w) => w.path.endsWith(`/${workflowFile}`)) : null;
  return {
    repo: { fullName: repo.full_name, private: repo.private, archived: repo.archived, defaultBranch: repo.default_branch },
    workflows: workflows.map((w) => ({ name: w.name, path: w.path, state: w.state })),
    target: workflowFile ? (target ? { name: target.name, state: target.state } : null) : undefined,
  };
}

/**
 * 승인 기반 재실행.
 * - 확인 문구 + idempotency key 필수
 * - 재실행 직전 GitHub에서 현재 상태를 다시 확인(실행 중/성공 run은 거부)
 */
export async function rerunWorkflow(
  env: Env,
  db: Db,
  deps: AppDeps,
  runId: number,
  input: { idempotencyKey: string; failedJobsOnly: boolean },
  actor: string,
) {
  const now = deps.now();
  const existing = await first<{ status: string; github_run_url: string | null }>(
    db,
    `SELECT status, github_run_url FROM rerun_requests WHERE idempotency_key = ?`,
    input.idempotencyKey,
  );
  if (existing) return { duplicate: true, status: existing.status, url: existing.github_run_url };

  const runRow = await first<{ id: number; project_id: number; source_type: string; external_run_id: string; status: string }>(
    db,
    `SELECT id, project_id, source_type, external_run_id, status FROM runs WHERE id = ?`,
    runId,
  );
  if (!runRow) throw notFound('실행 기록이 없습니다.');
  if (runRow.source_type !== 'github_actions') throw badRequest('GitHub Actions 실행만 재실행할 수 있습니다.');
  const project = await first<ProjectRow>(db, `SELECT * FROM projects WHERE id = ?`, runRow.project_id);
  if (!project?.repo_owner || !project.repo_name) throw badRequest('프로젝트에 저장소가 연결되지 않았습니다.');

  // 같은 run에 대한 최근 5분 내 요청은 중복으로 본다
  const recent = await first<{ id: number }>(
    db,
    `SELECT id FROM rerun_requests WHERE run_id = ? AND status IN ('requested','accepted') AND created_at > ?`,
    runId,
    new Date(now.getTime() - 5 * 60_000).toISOString(),
  );
  if (recent) throw conflict('이미 재실행을 요청했습니다. 잠시 후 상태를 확인하세요.');

  const gh = await getGithubClient(env, db, deps);
  if (!gh) throw new AppError(409, 'NOT_CONFIGURED', env.APP_MODE === 'demo' ? '샘플 모드에서는 재실행을 하지 않습니다.' : 'GitHub가 연결되지 않았습니다.');

  const insert = await run(
    db,
    `INSERT INTO rerun_requests (run_id, idempotency_key, status, actor, created_at) VALUES (?,?,'requested',?,?)`,
    runId,
    input.idempotencyKey,
    actor,
    now.toISOString(),
  );
  const reqId = insert.meta.last_row_id;

  try {
    const live = await gh.client.getRun(project.repo_owner, project.repo_name, runRow.external_run_id);
    const liveStatus = normalizeRunStatus(live.status, live.conclusion);
    if (liveStatus === 'running' || liveStatus === 'queued') throw conflict('이미 실행 중인 run은 재실행하지 않습니다.');
    if (liveStatus === 'success') throw conflict('성공한 run은 재실행하지 않습니다.');
    const status = await gh.client.rerun(project.repo_owner, project.repo_name, runRow.external_run_id, input.failedJobsOnly);
    await run(
      db,
      `UPDATE rerun_requests SET status='accepted', response_code=?, github_run_url=? WHERE id=?`,
      status,
      live.html_url,
      reqId,
    );
    await addRunEvent(db, runId, 'rerun_requested', now, { message: `재실행 요청 수락(HTTP ${status})` });
    await audit(db, now, actor, 'run.rerun', 'run', runId, { failedJobsOnly: input.failedJobsOnly, httpStatus: status });
    return { duplicate: false, status: 'accepted', url: live.html_url };
  } catch (err) {
    const message = err instanceof AppError || err instanceof GithubApiError ? err.message : '알 수 없는 오류';
    const code = err instanceof GithubApiError ? err.httpStatus : err instanceof AppError ? err.status : null;
    await run(
      db,
      `UPDATE rerun_requests SET status=?, response_code=?, safe_error_message=? WHERE id=?`,
      err instanceof AppError ? 'rejected' : 'failed',
      code,
      message,
      reqId,
    );
    await audit(db, now, actor, 'run.rerun_failed', 'run', runId, { reason: message });
    if (err instanceof GithubApiError) {
      await recordGithubAuthError(db, gh.integrationId, err, now);
      throw new AppError(err.code === 'AUTH_INVALID' ? 401 : err.code === 'PERMISSION_DENIED' ? 403 : 502, err.code, err.message);
    }
    throw err;
  }
}
