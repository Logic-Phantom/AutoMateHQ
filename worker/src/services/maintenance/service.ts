import type { MaintenanceMode } from '../../../../shared/constants';
import type { AppDeps, Env } from '../../env';
import { all, bool, first, parseJson, run, type Db } from '../../lib/db';
import { AppError, conflict, notFound } from '../../lib/http';
import { audit, rateLimit } from '../../repositories/common';
import { listIntegrations, markIntegrationStatus, readCredentials, type IntegrationRow } from '../../repositories/integrations';
import { getProject } from '../../repositories/projects';
import { randomToken, sha256Hex, timingSafeEqual } from '../../security/crypto';
import { redact } from '../../security/redact';
import { fireRoutine } from '../claude/routine';
import { buildRoutinePrompt, checkMaintenancePolicy, judgeCallback } from './policy';

export interface RoutineCredentials {
  fireUrl: string;
  token: string;
}

interface JobRow {
  id: number;
  project_id: number;
  incident_id: number | null;
  integration_id: number | null;
  mode: MaintenanceMode;
  status: string;
  analysis_kind: string;
  routine_session_id: string | null;
  routine_session_url: string | null;
  callback_token_hash: string | null;
  branch_name: string | null;
  pull_request_url: string | null;
  tests_passed: number | null;
  summary: string | null;
  findings_json: string;
  started_at: string | null;
  completed_at: string | null;
  approval_state: string;
  created_at: string;
  updated_at: string;
  project_name?: string;
}

export function toJobDto(j: JobRow) {
  return {
    id: j.id,
    projectId: j.project_id,
    projectName: j.project_name,
    incidentId: j.incident_id,
    mode: j.mode,
    status: j.status,
    analysisKind: j.analysis_kind,
    routineSessionUrl: j.routine_session_url,
    branchName: j.branch_name,
    pullRequestUrl: j.pull_request_url,
    testsPassed: j.tests_passed === null ? null : j.tests_passed === 1,
    summary: j.summary,
    findings: parseJson<{ title: string; severity: string; detail?: string }[]>(j.findings_json, []),
    startedAt: j.started_at,
    completedAt: j.completed_at,
    approvalState: j.approval_state,
    createdAt: j.created_at,
  };
}

export async function listJobs(db: Db, projectId?: number) {
  const rows = await all<JobRow>(
    db,
    `SELECT j.*, p.name AS project_name FROM maintenance_jobs j JOIN projects p ON p.id = j.project_id
     WHERE (? IS NULL OR j.project_id = ?) ORDER BY j.id DESC LIMIT 100`,
    projectId ?? null,
    projectId ?? null,
  );
  return rows.map(toJobDto);
}

function pickRoutine(routines: IntegrationRow[], mode: MaintenanceMode, hasIncident: boolean): IntegrationRow | null {
  const usable = routines.filter((r) => r.status === 'connected' && r.encrypted_credentials);
  const purpose = (r: IntegrationRow) => parseJson<{ purpose?: string }>(r.metadata_json, {}).purpose;
  if (mode === 'DRAFT_PR') return usable.find((r) => purpose(r) === 'draft_pr') ?? null;
  if (hasIncident) return usable.find((r) => purpose(r) === 'incident') ?? usable.find((r) => purpose(r) === 'audit') ?? null;
  return usable.find((r) => purpose(r) === 'audit') ?? null;
}

/** HQ에 쌓인 데이터만으로 하는 규칙 기반 점검(AI 아님). */
async function ruleBasedFindings(db: Db, projectId: number, now: Date) {
  const since = new Date(now.getTime() - 14 * 86400_000).toISOString();
  const runs = await all<{ status: string; error_code: string | null; workflow_name: string | null; started_at: string | null }>(
    db,
    `SELECT status, error_code, workflow_name, started_at FROM runs WHERE project_id=? AND COALESCE(started_at, created_at) >= ?
     ORDER BY started_at DESC LIMIT 200`,
    projectId,
    since,
  );
  const incidents = await all<{ category: string; title: string; occurrence_count: number }>(
    db,
    `SELECT category, title, occurrence_count FROM incidents WHERE project_id=? AND status IN ('open','acknowledged')`,
    projectId,
  );
  const findings: { title: string; severity: string; detail?: string }[] = [];
  const failures = runs.filter((r) => r.status === 'failure');
  if (runs.length === 0) findings.push({ title: '최근 14일 실행 기록 없음', severity: 'medium', detail: '연동 또는 일정 설정을 확인하세요.' });
  if (failures.length > 0) {
    const rate = Math.round((failures.length / runs.length) * 100);
    findings.push({ title: `최근 14일 실패 ${failures.length}회 / ${runs.length}회 (${rate}%)`, severity: rate >= 30 ? 'high' : 'medium' });
    const codes = new Map<string, number>();
    for (const f of failures) codes.set(f.error_code ?? 'UNKNOWN', (codes.get(f.error_code ?? 'UNKNOWN') ?? 0) + 1);
    for (const [code, count] of codes) findings.push({ title: `오류 코드 ${code}: ${count}회`, severity: 'info' });
    // 연속 실패
    let streak = 0;
    for (const r of runs) {
      if (r.status === 'failure') streak++;
      else if (r.status === 'success') break;
    }
    if (streak >= 2) findings.push({ title: `연속 실패 ${streak}회`, severity: 'high', detail: '같은 원인일 가능성이 높아 재실행 전에 원인 분석이 필요합니다.' });
  }
  for (const i of incidents) findings.push({ title: `미해결 장애: ${i.title}`, severity: 'medium', detail: `반복 ${i.occurrence_count}회` });
  return { findings, failures: failures.length, total: runs.length };
}

export async function startMaintenance(
  env: Env,
  db: Db,
  deps: AppDeps,
  projectId: number,
  input: { mode: MaintenanceMode; incidentId?: number; instructions?: string },
  actor: string,
) {
  const now = deps.now();
  const iso = now.toISOString();
  const project = await getProject(db, projectId);
  if (!project) throw notFound('프로젝트가 없습니다.');

  const insertJob = async (status: string, summary: string, extra: { findings?: unknown[]; kind?: string; integrationId?: number | null } = {}) => {
    const res = await run(
      db,
      `INSERT INTO maintenance_jobs (project_id, incident_id, integration_id, mode, status, analysis_kind, summary, findings_json,
         dedupe_key, started_at, completed_at, approval_state, actor, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId,
      input.incidentId ?? null,
      extra.integrationId ?? null,
      input.mode,
      status,
      extra.kind ?? 'rule_based',
      summary,
      JSON.stringify(extra.findings ?? []),
      `${projectId}:${input.mode}:${input.incidentId ?? '-'}`,
      iso,
      ['blocked', 'rule_based_done', 'not_configured', 'failed'].includes(status) ? iso : null,
      input.mode === 'AUDIT' ? 'not_required' : 'pending',
      actor,
      iso,
      iso,
    );
    return res.meta.last_row_id;
  };

  const decision = checkMaintenancePolicy(
    {
      maintenanceEnabled: bool(project.maintenance_enabled),
      maintenanceMode: project.maintenance_mode,
      defaultBranch: project.default_branch,
      isActive: bool(project.is_active),
    },
    input.mode,
  );
  if (!decision.allowed) {
    const id = await insertJob('blocked', decision.reason);
    await audit(db, now, actor, 'maintenance.blocked', 'project', projectId, { mode: input.mode, reason: decision.reason });
    return { jobId: id, status: 'blocked', routineConfigured: null, message: decision.reason };
  }

  const active = await first<{ id: number }>(
    db,
    `SELECT id FROM maintenance_jobs WHERE dedupe_key=? AND status IN ('started','running') AND created_at > ?`,
    `${projectId}:${input.mode}:${input.incidentId ?? '-'}`,
    new Date(now.getTime() - 3600_000).toISOString(),
  );
  if (active) throw conflict('같은 유지보수 작업이 이미 실행 중입니다.', { jobId: active.id });

  const rule = await ruleBasedFindings(db, projectId, now);
  const incident = input.incidentId
    ? await first<{ title: string; description: string; category: string }>(db, `SELECT title, description, category FROM incidents WHERE id=?`, input.incidentId)
    : null;

  const routines = env.APP_MODE === 'demo' ? [] : await listIntegrations(db, 'claude_routine');
  const routine = pickRoutine(routines, input.mode, Boolean(incident));
  if (!routine) {
    const needsAi = input.mode !== 'AUDIT';
    const note = env.APP_MODE === 'demo' ? '샘플 모드: Claude Routine을 호출하지 않았습니다.' : 'Claude Code 연결 필요: 해당 용도의 Routine이 등록되지 않았습니다.';
    const id = await insertJob(needsAi ? 'not_configured' : 'rule_based_done', `${note} 규칙 기반 점검 결과만 기록했습니다.`, {
      findings: rule.findings,
    });
    await audit(db, now, actor, 'maintenance.rule_based', 'project', projectId, { mode: input.mode });
    return { jobId: id, status: needsAi ? 'not_configured' : 'rule_based_done', routineConfigured: false, message: note };
  }

  if (!(await rateLimit(db, `routine:${routine.id}`, 10, 3600, now))) {
    throw new AppError(429, 'RATE_LIMITED', 'Routine 호출이 시간당 HQ 한도(10회)를 넘었습니다.');
  }

  const callbackToken = randomToken(32);
  const jobId = await insertJob('started', 'Routine 세션 생성 요청 중', {
    findings: rule.findings,
    kind: 'claude_routine',
    integrationId: routine.id,
  });
  const failures = await all<{ workflow_name: string | null; started_at: string | null; external_url: string | null; safe_error_message: string | null }>(
    db,
    `SELECT workflow_name, started_at, external_url, safe_error_message FROM runs WHERE project_id=? AND status='failure' ORDER BY started_at DESC LIMIT 5`,
    projectId,
  );
  const base = env.PUBLIC_BASE_URL?.startsWith('https://') ? env.PUBLIC_BASE_URL.replace(/\/$/, '') : null;
  const prompt = buildRoutinePrompt({
    mode: input.mode,
    jobId,
    project: {
      name: project.name,
      projectKey: project.project_key,
      repo: project.repo_owner ? `${project.repo_owner}/${project.repo_name}` : null,
      defaultBranch: project.default_branch,
    },
    incident,
    recentFailures: failures.map((f) => ({ workflow: f.workflow_name, startedAt: f.started_at, url: f.external_url, error: f.safe_error_message })),
    instructions: input.instructions,
    callback: base ? { url: `${base}/api/v1/maintenance/callback`, token: callbackToken } : null,
  });

  const creds = await readCredentials<RoutineCredentials>(env, routine);
  const result = await fireRoutine(deps.fetch, creds!.fireUrl, creds!.token, prompt);
  if (!result.ok) {
    await run(
      db,
      `UPDATE maintenance_jobs SET status='failed', summary=?, completed_at=?, updated_at=? WHERE id=?`,
      result.message ?? 'Routine 호출 실패',
      iso,
      iso,
      jobId,
    );
    if (result.httpStatus === 401 || result.httpStatus === 404) {
      await markIntegrationStatus(db, routine.id, 'reauth_required', now, { code: String(result.httpStatus), message: result.message ?? '' });
    }
    await audit(db, now, actor, 'maintenance.routine_failed', 'project', projectId, { httpStatus: result.httpStatus });
    return { jobId, status: 'failed', routineConfigured: true, message: result.message };
  }
  await run(
    db,
    `UPDATE maintenance_jobs SET routine_session_id=?, routine_session_url=?, callback_token_hash=?, summary=?, updated_at=? WHERE id=?`,
    result.sessionId ?? null,
    result.sessionUrl ?? null,
    await sha256Hex(callbackToken),
    'Routine 세션이 시작되었습니다. 완료 여부는 세션에서 확인하거나 결과 회신을 기다립니다.',
    iso,
    jobId,
  );
  await markIntegrationStatus(db, routine.id, 'connected', now);
  await audit(db, now, actor, 'maintenance.routine_fired', 'project', projectId, { mode: input.mode, jobId });
  return { jobId, status: 'started', routineConfigured: true, sessionUrl: result.sessionUrl ?? null };
}

/** Routine이 보내는 결과 회신. 작업별 1회용 토큰(해시 비교)으로만 인증한다. */
export async function handleMaintenanceCallback(
  db: Db,
  now: Date,
  bearer: string | null,
  body: {
    jobId: number;
    status: 'running' | 'completed' | 'failed';
    summary?: string;
    testsPassed?: boolean | null;
    branchName?: string;
    pullRequestUrl?: string;
    findings?: { title: string; severity: string; detail?: string }[];
  },
) {
  const job = await first<JobRow & { default_branch: string }>(
    db,
    `SELECT j.*, p.default_branch FROM maintenance_jobs j JOIN projects p ON p.id = j.project_id WHERE j.id = ?`,
    body.jobId,
  );
  if (!job?.callback_token_hash || !bearer || !timingSafeEqual(await sha256Hex(bearer), job.callback_token_hash)) {
    throw new AppError(401, 'UNAUTHORIZED', '회신 인증 실패');
  }
  if (['completed', 'needs_review', 'failed', 'cancelled'].includes(job.status)) throw conflict('이미 종료된 작업입니다.');
  if (body.pullRequestUrl && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.pullRequestUrl)) {
    throw new AppError(400, 'BAD_REQUEST', 'PR URL 형식이 아닙니다.');
  }
  const verdict = judgeCallback(job.mode, job.default_branch, body);
  const findings = [...parseJson<unknown[]>(job.findings_json, []), ...(body.findings ?? []), ...verdict.flags.map((f) => ({ title: f, severity: 'high' }))];
  const iso = now.toISOString();
  await run(
    db,
    `UPDATE maintenance_jobs SET status=?, summary=COALESCE(?, summary), tests_passed=?, branch_name=COALESCE(?, branch_name),
       pull_request_url=COALESCE(?, pull_request_url), findings_json=?, completed_at=?, updated_at=?,
       callback_token_hash = CASE WHEN ? = 'running' THEN callback_token_hash ELSE NULL END
     WHERE id=?`,
    verdict.status,
    body.summary ? redact(body.summary, 4000) : null,
    body.testsPassed === undefined || body.testsPassed === null ? null : body.testsPassed ? 1 : 0,
    body.branchName ?? null,
    body.pullRequestUrl ?? null,
    JSON.stringify(findings.slice(0, 80)),
    verdict.status === 'running' ? null : iso,
    iso,
    verdict.status,
    job.id,
  );
  await audit(db, now, 'routine', 'maintenance.callback', 'maintenance_job', job.id, { status: verdict.status, flags: verdict.flags });
  return verdict;
}

/** 사람이 결과를 승인/반려한다. HQ는 어떤 경우에도 merge하지 않는다. */
export async function decideMaintenance(
  db: Db,
  now: Date,
  jobId: number,
  input: { decision: 'approved' | 'rejected'; pullRequestUrl?: string; note?: string },
  actor: string,
) {
  const job = await first<JobRow>(db, `SELECT * FROM maintenance_jobs WHERE id=?`, jobId);
  if (!job) throw notFound();
  await run(
    db,
    `UPDATE maintenance_jobs SET approval_state=?, pull_request_url=COALESCE(?, pull_request_url), updated_at=? WHERE id=?`,
    input.decision,
    input.pullRequestUrl ?? null,
    now.toISOString(),
    jobId,
  );
  await audit(db, now, actor, `maintenance.${input.decision}`, 'maintenance_job', jobId, { note: input.note ?? '' });
}

export async function cancelMaintenance(db: Db, now: Date, jobId: number, actor: string) {
  const job = await first<JobRow>(db, `SELECT * FROM maintenance_jobs WHERE id=?`, jobId);
  if (!job) throw notFound();
  if (!['started', 'running'].includes(job.status)) throw conflict('실행 중인 작업만 취소할 수 있습니다.');
  await run(
    db,
    `UPDATE maintenance_jobs SET status='cancelled', callback_token_hash=NULL, completed_at=?, updated_at=?,
       summary = COALESCE(summary,'') || ' / HQ에서 추적 취소함. 실행 중인 Routine 세션은 claude.ai에서 직접 중지해야 합니다.' WHERE id=?`,
    now.toISOString(),
    now.toISOString(),
    jobId,
  );
  await audit(db, now, actor, 'maintenance.cancel', 'maintenance_job', jobId);
}
