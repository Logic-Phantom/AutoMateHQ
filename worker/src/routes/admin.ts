import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { PROJECT_PRESETS } from '../../../shared/presets';
import { DAILY_REPORT_TIME_LABEL, DAILY_REPORT_WINDOW_LABEL } from '../../../shared/constants';
import {
  githubTokenSchema,
  incidentActionSchema,
  maintenanceDecisionSchema,
  maintenanceRunSchema,
  manualUsageSchema,
  notificationSettingsSchema,
  projectInputSchema,
  projectPatchSchema,
  rerunSchema,
  routineInputSchema,
  validateProjectShape,
} from '../../../shared/schemas';
import type { AppDeps, Env } from '../env';
import { all, first, parseJson, run } from '../lib/db';
import { AppError, badRequest, conflict, notFound } from '../lib/http';
import { addDays, localDateString } from '../lib/time';
import {
  audit,
  getNotificationSettings,
  listAudit,
  putSetting,
  type NotificationSettings,
} from '../repositories/common';
import {
  getIntegration,
  getIntegrationById,
  listIntegrations,
  publicIntegration,
  upsertSingletonIntegration,
  keyRing,
} from '../repositories/integrations';
import {
  getProject,
  getProjectByKey,
  insertProject,
  listProjects,
  listSources,
  projectToInput,
  toProjectDto,
  updateProject,
} from '../repositories/projects';
import { encryptSecret } from '../security/crypto';
import { requireAdmin, type AppContext, type AppVars } from '../security/session';
import { GithubApiError, GithubClient } from '../services/github/client';
import { checkWorkflowState, getGithubClient, recordGithubAuthError, rerunWorkflow, syncGithubProjects } from '../services/github/service';
import { recentDeliveries } from '../services/github/webhook';
import { heartbeatSecretInfo, issueHeartbeatSecret, revokeHeartbeatSecret } from '../services/heartbeat/service';
import { toIncidentDto, type IncidentRow } from '../services/incidents/engine';
import { buildAuthorizeUrl } from '../services/kakao/client';
import { createOAuthState, disconnectKakao, kakaoAppConfig, kakaoStatus } from '../services/kakao/service';
import { cancelMaintenance, decideMaintenance, listJobs, startMaintenance } from '../services/maintenance/service';
import { primaryReason, summarize } from '../services/monitoring/classifier';
import { evaluateAll } from '../services/monitoring/evaluate';
import { listPublications } from '../services/publications/service';
import { generateReport, getDailyReport, listDailyReports, runDailyReport, sendTestMessage } from '../services/reporting/daily';
import { addManualUsage, usageSummary } from '../services/usage/service';
import { idParam, ok, parseJsonBody } from './helpers';
import { OAUTH_STATE_COOKIE } from './public';

export function adminRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
  app.use('/api/*', requireAdmin(deps.now));

  // ====================== Overview ======================
  app.get('/api/overview', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    // 운영 모드는 cron(10분)이 판정·incident를 기록한다. 로컬 샘플 모드는 cron이 없으므로 조회 시 기록한다.
    const { evaluations } = await evaluateAll(db, now, { persist: c.env.APP_MODE === 'demo' });
    const counts = summarize(evaluations.map((e) => ({ isActive: e.project.is_active === 1, status: e.classification.status })));
    const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
    const stats = await first<{ runs: number; failures: number }>(
      db,
      `SELECT COUNT(*) AS runs, COALESCE(SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END),0) AS failures FROM runs WHERE started_at >= ?`,
      dayAgo,
    );
    const openIncidents = await all<IncidentRow>(db, `SELECT * FROM incidents WHERE status IN ('open','acknowledged') ORDER BY last_seen_at DESC LIMIT 10`);
    const integrations = (await listIntegrations(db)).map(publicIntegration);
    const tz = c.env.APP_TIMEZONE || 'Asia/Seoul';
    const today = await getDailyReport(db, localDateString(now, tz));
    const kakao = await kakaoStatus(c.env, db);
    return ok(c, {
      mode: c.env.APP_MODE,
      generatedAt: now.toISOString(),
      kpi: { activeProjects: counts.total, normal: counts.NORMAL, failed: counts.FAILED, attention: counts.ATTENTION, unknown: counts.UNKNOWN, runs24h: stats?.runs ?? 0, failures24h: stats?.failures ?? 0 },
      projects: evaluations.map((e) => ({
        id: e.project.id,
        name: e.project.name,
        category: e.project.category,
        priority: e.project.priority,
        isActive: e.project.is_active === 1,
        status: e.classification.status,
        reason: primaryReason(e.classification)?.message ?? null,
        lastRunAt: e.classification.lastRun?.startedAt ?? null,
        lastRunStatus: e.classification.lastRun?.status ?? null,
        lastSuccessAt: e.classification.lastSuccessAt,
        nextExpectedAt: e.classification.nextExpectedAt,
      })),
      openIncidents: openIncidents.map(toIncidentDto),
      integrations,
      githubWebhookSecretConfigured: Boolean(c.env.GITHUB_WEBHOOK_SECRET),
      kakao,
      todayReport: today ? { reportDate: today.reportDate, status: today.status, sentAt: today.sentAt, error: today.safeErrorMessage } : null,
    });
  });

  /** 차트용 통계: 최근 N일(한국 날짜) 실행 결과 집계 + 프로젝트별 일자 스트립 */
  app.get('/api/overview/stats', async (c) => {
    const now = deps.now();
    const tz = c.env.APP_TIMEZONE || 'Asia/Seoul';
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 14) || 14, 7), 30);
    const today = localDateString(now, tz);
    const dates = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
    const since = new Date(now.getTime() - (days + 1) * 86400_000).toISOString();
    const rows = await all<{ project_id: number; status: string; started_at: string; duration_seconds: number | null }>(
      c.env.DB,
      `SELECT r.project_id, r.status, r.started_at, r.duration_seconds FROM runs r JOIN projects p ON p.id = r.project_id
       WHERE p.deleted_at IS NULL AND p.is_active = 1 AND r.started_at >= ?`,
      since,
    );
    const daily = new Map(dates.map((d) => [d, { date: d, success: 0, failure: 0, other: 0 }]));
    const cells = new Map<number, Map<string, { success: number; failure: number; other: number }>>();
    for (const r of rows) {
      const d = localDateString(new Date(r.started_at), tz);
      const bucket = daily.get(d);
      if (!bucket) continue;
      const key = r.status === 'success' ? 'success' : r.status === 'failure' ? 'failure' : 'other';
      bucket[key] += 1;
      const pm = cells.get(r.project_id) ?? new Map();
      const cell = pm.get(d) ?? { success: 0, failure: 0, other: 0 };
      cell[key] += 1;
      pm.set(d, cell);
      cells.set(r.project_id, pm);
    }
    const projects = (await listProjects(c.env.DB, false)).map((p) => ({
      id: p.id,
      name: p.name,
      cells: dates.map((d) => {
        const v = cells.get(p.id)?.get(d);
        return { date: d, success: v?.success ?? 0, failure: v?.failure ?? 0, other: v?.other ?? 0 };
      }),
    }));
    return ok(c, { dates, daily: dates.map((d) => daily.get(d)!), projects });
  });

  app.get('/api/overview/timeline', async (c) => {
    const rows = await all(
      c.env.DB,
      `SELECT r.id, r.project_id AS projectId, p.name AS projectName, r.source_type AS sourceType, r.workflow_name AS workflowName,
         r.status, r.stage, r.started_at AS startedAt, r.completed_at AS completedAt, r.external_url AS externalUrl
       FROM runs r JOIN projects p ON p.id = r.project_id ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 30`,
    );
    return ok(c, rows);
  });

  // ====================== Projects ======================
  app.get('/api/projects/presets', async (c) => {
    const existing = new Set((await listProjects(c.env.DB)).map((p) => p.project_key));
    return ok(c, PROJECT_PRESETS.map((p) => ({ ...p, alreadyRegistered: existing.has(p.input.projectKey) })));
  });

  app.get('/api/projects', async (c) => {
    const db = c.env.DB;
    const [projects, sources] = await Promise.all([listProjects(db), listSources(db)]);
    return ok(c, projects.map((p) => toProjectDto(p, sources.filter((s) => s.project_id === p.id))));
  });

  app.post('/api/projects', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    const input = await parseJsonBody(c, projectInputSchema);
    if (await getProjectByKey(db, input.projectKey)) throw conflict('이미 사용 중인 project key입니다.');
    const deleted = await first(db, `SELECT id FROM projects WHERE project_key = ?`, input.projectKey);
    if (deleted) throw conflict('삭제된 프로젝트가 같은 key를 쓰고 있습니다. 다른 key를 쓰세요.');
    const id = await insertProject(db, input, now);
    await audit(db, now, c.get('actor'), 'project.create', 'project', id, { projectKey: input.projectKey, name: input.name });
    const p = await getProject(db, id);
    return ok(c, toProjectDto(p!, await listSources(db, id)), 201);
  });

  app.get('/api/projects/:id', async (c) => {
    const db = c.env.DB;
    const id = idParam(c);
    const p = await getProject(db, id);
    if (!p) throw notFound();
    const runs = await all(
      db,
      `SELECT id, source_type AS sourceType, workflow_name AS workflowName, status, stage, started_at AS startedAt, completed_at AS completedAt,
         duration_seconds AS durationSeconds, external_url AS externalUrl, error_code AS errorCode, safe_error_message AS safeErrorMessage
       FROM runs WHERE project_id = ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT 30`,
      id,
    );
    const incidents = await all<IncidentRow>(db, `SELECT * FROM incidents WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 20`, id);
    const hb = await heartbeatSecretInfo(db, id);
    return ok(c, {
      project: toProjectDto(p, await listSources(db, id)),
      runs,
      incidents: incidents.map(toIncidentDto),
      heartbeat: hb ? { hint: hb.secret_hint, createdAt: hb.created_at } : null,
    });
  });

  app.patch('/api/projects/:id', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    const id = idParam(c);
    const p = await getProject(db, id);
    if (!p) throw notFound();
    let raw: Record<string, unknown>;
    try {
      raw = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw badRequest('JSON 본문이 필요합니다.');
    }
    const parsed = projectPatchSchema.safeParse(raw);
    if (!parsed.success) throw badRequest('입력값이 올바르지 않습니다.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    // 본문에 실제로 온 필드만 반영한다(기본값으로 덮어쓰지 않음)
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k in raw));
    const merged = { ...projectToInput(p, await listSources(db, id)), ...patch };
    const issues = validateProjectShape(merged);
    if (issues.length) throw badRequest('입력값이 올바르지 않습니다.', issues);
    await updateProject(db, id, merged, now);
    await audit(db, now, c.get('actor'), 'project.update', 'project', id, { fields: Object.keys(patch) });
    return ok(c, toProjectDto((await getProject(db, id))!, await listSources(db, id)));
  });

  app.delete('/api/projects/:id', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    const id = idParam(c);
    const p = await getProject(db, id);
    if (!p) throw notFound();
    // Soft delete: 실행 이력은 남기고 감시·secret만 끈다
    await db.batch([
      db.prepare(`UPDATE projects SET deleted_at=?, is_active=0, updated_at=? WHERE id=?`).bind(now.toISOString(), now.toISOString(), id),
      db.prepare(`UPDATE project_secrets SET revoked_at=? WHERE project_id=? AND revoked_at IS NULL`).bind(now.toISOString(), id),
      db.prepare(`UPDATE incidents SET status='resolved', resolved_at=? WHERE project_id=? AND status IN ('open','acknowledged')`).bind(now.toISOString(), id),
    ]);
    await audit(db, now, c.get('actor'), 'project.soft_delete', 'project', id, { projectKey: p.project_key });
    return ok(c, { deleted: true });
  });

  app.post('/api/projects/:id/test-connection', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    const id = idParam(c);
    const p = await getProject(db, id);
    if (!p) throw notFound();
    if (!p.repo_owner || !p.repo_name) return ok(c, { ok: false, message: 'GitHub 저장소가 연결되지 않은 프로젝트입니다.' });
    const gh = await getGithubClient(c.env, db, deps);
    if (!gh) return ok(c, { ok: false, message: c.env.APP_MODE === 'demo' ? '샘플 모드에서는 외부 호출을 하지 않습니다.' : 'GitHub 토큰이 연결되지 않았습니다.' });
    const src = (await listSources(db, id)).find((s) => s.source_type === 'github_actions' && s.is_enabled === 1);
    const workflowFile = src && src.external_identifier !== '*' ? src.external_identifier : null;
    try {
      const state = await checkWorkflowState(gh.client, p, workflowFile);
      const sync = await syncGithubProjects(c.env, db, deps, { maxProjects: 1, projectId: id });
      await audit(db, now, c.get('actor'), 'project.test_connection', 'project', id, { ok: true });
      const warnings: string[] = [];
      if (state.repo.archived) warnings.push('저장소가 보관(archived) 상태입니다.');
      if (workflowFile && !state.target) warnings.push(`워크플로 파일 ${workflowFile}을(를) 찾을 수 없습니다(삭제/이름 변경).`);
      if (state.target && state.target.state !== 'active') warnings.push(`워크플로가 비활성 상태입니다(${state.target.state}).`);
      return ok(c, { ok: warnings.length === 0, ...state, synced: sync.synced, warnings });
    } catch (err) {
      if (err instanceof GithubApiError) {
        await recordGithubAuthError(db, gh.integrationId, err, now);
        return ok(c, { ok: false, errorCode: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/projects/:id/sync', async (c) => {
    const id = idParam(c);
    return ok(c, await syncGithubProjects(c.env, c.env.DB, deps, { maxProjects: 1, projectId: id }));
  });

  app.post('/api/projects/:id/heartbeat-secret/rotate', async (c) => {
    const id = idParam(c);
    if (!(await getProject(c.env.DB, id))) throw notFound();
    if (!c.env.HQ_ENCRYPTION_KEY) throw new AppError(503, 'NOT_CONFIGURED', 'HQ_ENCRYPTION_KEY가 설정되지 않았습니다.');
    const { secret, hint } = await issueHeartbeatSecret(c.env, c.env.DB, id, deps.now(), c.get('actor'));
    // 원문은 이 응답에서 한 번만 보여 준다
    return ok(c, { secret, hint, notice: '이 값은 다시 볼 수 없습니다. 자동화 프로그램의 비밀 저장소에 바로 등록하세요.' });
  });

  app.post('/api/projects/:id/heartbeat-secret/revoke', async (c) => {
    const id = idParam(c);
    await revokeHeartbeatSecret(c.env.DB, id, deps.now(), c.get('actor'));
    return ok(c, { revoked: true });
  });

  // ====================== Runs ======================
  app.get('/api/runs', async (c) => {
    const q = c.req.query();
    const limit = Math.min(Number(q.limit ?? 100) || 100, 300);
    const rows = await all(
      c.env.DB,
      `SELECT r.id, r.project_id AS projectId, p.name AS projectName, p.category, r.source_type AS sourceType, r.workflow_name AS workflowName,
         r.trigger_type AS triggerType, r.status, r.stage, r.started_at AS startedAt, r.completed_at AS completedAt,
         r.duration_seconds AS durationSeconds, r.branch, r.commit_sha AS commitSha, r.external_url AS externalUrl,
         r.error_code AS errorCode, r.safe_error_message AS safeErrorMessage, r.run_attempt AS runAttempt,
         (SELECT status FROM rerun_requests rr WHERE rr.run_id = r.id ORDER BY rr.id DESC LIMIT 1) AS rerunStatus
       FROM runs r JOIN projects p ON p.id = r.project_id
       WHERE (? IS NULL OR r.project_id = ?) AND (? IS NULL OR r.status = ?) AND (? IS NULL OR p.category = ?)
         AND (? IS NULL OR r.started_at >= ?) AND (? IS NULL OR r.started_at <= ?)
       ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT ?`,
      q.projectId ? Number(q.projectId) : null,
      q.projectId ? Number(q.projectId) : null,
      q.status ?? null,
      q.status ?? null,
      q.category ?? null,
      q.category ?? null,
      q.from ?? null,
      q.from ?? null,
      q.to ?? null,
      q.to ?? null,
      limit,
    );
    return ok(c, rows);
  });

  app.get('/api/runs/:id', async (c) => {
    const id = idParam(c);
    const row = await first(
      c.env.DB,
      `SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
      id,
    );
    if (!row) throw notFound();
    const events = await all(c.env.DB, `SELECT event_type, status, stage, message, created_at FROM run_events WHERE run_id = ? ORDER BY id`, id);
    const reruns = await all(
      c.env.DB,
      `SELECT status, response_code, safe_error_message, github_run_url, actor, created_at FROM rerun_requests WHERE run_id = ? ORDER BY id DESC`,
      id,
    );
    return ok(c, { run: row, events, reruns });
  });

  app.post('/api/runs/:id/rerun', async (c) => {
    const id = idParam(c);
    const input = await parseJsonBody(c, rerunSchema);
    const result = await rerunWorkflow(c.env, c.env.DB, deps, id, input, c.get('actor'));
    return ok(c, result, result.duplicate ? 200 : 202);
  });

  // ====================== GitHub ======================
  app.get('/api/integrations/github/status', async (c) => {
    const row = await getIntegration(c.env.DB, 'github');
    return ok(c, {
      integration: row ? publicIntegration(row) : null,
      webhookSecretConfigured: Boolean(c.env.GITHUB_WEBHOOK_SECRET),
      webhookUrl: c.env.PUBLIC_BASE_URL ? `${c.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/webhooks/github` : null,
      recentDeliveries: await recentDeliveries(c.env.DB, 20),
    });
  });

  app.put('/api/integrations/github', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    if (c.env.APP_MODE === 'demo') throw new AppError(409, 'DEMO_MODE', '샘플 모드에서는 실제 토큰을 저장하지 않습니다.');
    if (!c.env.HQ_ENCRYPTION_KEY) throw new AppError(503, 'NOT_CONFIGURED', 'HQ_ENCRYPTION_KEY가 설정되지 않았습니다.');
    const { token } = await parseJsonBody(c, githubTokenSchema);
    const client = new GithubClient(token, deps.fetch);
    try {
      const user = await client.getAuthenticatedUser();
      const rl = await client.rateLimit();
      await upsertSingletonIntegration(
        c.env,
        db,
        'github',
        {
          displayName: 'GitHub',
          status: 'connected',
          credentials: { token },
          metadata: { login: user.login, tokenType: token.startsWith('github_pat_') ? 'fine-grained' : 'classic', rateLimit: rl.limit, tokenHint: `${token.slice(0, 11)}…` },
          verifiedAt: now.toISOString(),
          errorCode: null,
          errorMessage: null,
        },
        now,
      );
      await audit(db, now, c.get('actor'), 'integration.github.connect', 'integration', 'github', { login: user.login });
      return ok(c, { connected: true, login: user.login, rateLimit: rl });
    } catch (err) {
      if (err instanceof GithubApiError) throw new AppError(400, err.code, err.message);
      throw err;
    }
  });

  app.delete('/api/integrations/github', async (c) => {
    const now = deps.now();
    await upsertSingletonIntegration(c.env, c.env.DB, 'github', { displayName: 'GitHub', status: 'not_connected', credentials: null, metadata: {} }, now);
    await audit(c.env.DB, now, c.get('actor'), 'integration.github.disconnect', 'integration', 'github');
    return ok(c, { disconnected: true });
  });

  app.post('/api/integrations/github/test', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    const gh = await getGithubClient(c.env, db, deps);
    if (!gh) return ok(c, { ok: false, message: 'GitHub가 연결되지 않았습니다.' });
    try {
      const user = await gh.client.getAuthenticatedUser();
      const rl = await gh.client.rateLimit();
      await run(db, `UPDATE integrations SET status='connected', last_verified_at=?, last_error_code=NULL, last_error_message_safe=? WHERE id=?`, now.toISOString(), null, gh.integrationId);
      return ok(c, { ok: true, login: user.login, rateLimit: rl });
    } catch (err) {
      if (err instanceof GithubApiError) {
        await recordGithubAuthError(db, gh.integrationId, err, now);
        return ok(c, { ok: false, errorCode: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ====================== Incidents ======================
  app.get('/api/incidents', async (c) => {
    const status = c.req.query('status');
    const rows = await all<IncidentRow & { project_name: string | null }>(
      c.env.DB,
      `SELECT i.*, p.name AS project_name FROM incidents i LEFT JOIN projects p ON p.id = i.project_id
       WHERE (? IS NULL OR i.status = ?) ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, i.last_seen_at DESC LIMIT 200`,
      status ?? null,
      status ?? null,
    );
    return ok(c, rows.map((r) => ({ ...toIncidentDto(r), projectName: r.project_name })));
  });

  app.get('/api/incidents/:id', async (c) => {
    const id = idParam(c);
    const row = await first<IncidentRow>(c.env.DB, `SELECT * FROM incidents WHERE id = ?`, id);
    if (!row) throw notFound();
    const jobs = await all(c.env.DB, `SELECT id, mode, status, routine_session_url, pull_request_url, created_at FROM maintenance_jobs WHERE incident_id = ? ORDER BY id DESC`, id);
    return ok(c, { incident: toIncidentDto(row), maintenanceJobs: jobs });
  });

  const incidentTransition = (to: 'acknowledged' | 'resolved') => async (c: AppContext) => {
    const db = c.env.DB;
    const now = deps.now();
    const id = idParam(c);
    const { note } = await parseJsonBody(c, incidentActionSchema);
    const res = await run(
      db,
      `UPDATE incidents SET status=?, resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END WHERE id=? AND status IN ('open','acknowledged')`,
      to,
      to,
      now.toISOString(),
      id,
    );
    if (res.meta.changes === 0) throw conflict('이미 처리된 장애이거나 존재하지 않습니다.');
    await audit(db, now, c.get('actor'), `incident.${to}`, 'incident', id, { note: note ?? '' });
    return ok(c, { id, status: to });
  };
  app.post('/api/incidents/:id/acknowledge', incidentTransition('acknowledged'));
  app.post('/api/incidents/:id/resolve', incidentTransition('resolved'));

  app.post('/api/incidents/:id/analyze', async (c) => {
    const id = idParam(c);
    const inc = await first<IncidentRow>(c.env.DB, `SELECT * FROM incidents WHERE id = ?`, id);
    if (!inc) throw notFound();
    if (!inc.project_id) throw badRequest('프로젝트에 속하지 않은 전역 장애는 분석 대상을 고를 수 없습니다.');
    return ok(c, await startMaintenance(c.env, c.env.DB, deps, inc.project_id, { mode: 'AUDIT', incidentId: id }, c.get('actor')), 202);
  });

  // ====================== Maintenance ======================
  app.get('/api/maintenance/jobs', async (c) => {
    const projectId = c.req.query('projectId');
    return ok(c, await listJobs(c.env.DB, projectId ? Number(projectId) : undefined));
  });

  app.post('/api/projects/:id/maintenance/run', async (c) => {
    const id = idParam(c);
    const input = await parseJsonBody(c, maintenanceRunSchema);
    return ok(c, await startMaintenance(c.env, c.env.DB, deps, id, input, c.get('actor')), 202);
  });

  app.post('/api/maintenance/jobs/:id/cancel', async (c) => {
    await cancelMaintenance(c.env.DB, deps.now(), idParam(c), c.get('actor'));
    return ok(c, { cancelled: true });
  });

  app.post('/api/maintenance/jobs/:id/decision', async (c) => {
    const input = await parseJsonBody(c, maintenanceDecisionSchema);
    await decideMaintenance(c.env.DB, deps.now(), idParam(c), input, c.get('actor'));
    return ok(c, { decision: input.decision });
  });

  // ====================== Claude Routines ======================
  app.get('/api/integrations/claude', async (c) => {
    return ok(c, (await listIntegrations(c.env.DB, 'claude_routine')).map(publicIntegration));
  });

  app.post('/api/integrations/claude', async (c) => {
    const db = c.env.DB;
    const now = deps.now();
    if (c.env.APP_MODE === 'demo') throw new AppError(409, 'DEMO_MODE', '샘플 모드에서는 실제 토큰을 저장하지 않습니다.');
    if (!c.env.HQ_ENCRYPTION_KEY) throw new AppError(503, 'NOT_CONFIGURED', 'HQ_ENCRYPTION_KEY가 설정되지 않았습니다.');
    const input = await parseJsonBody(c, routineInputSchema);
    const encrypted = await encryptSecret(keyRing(c.env), JSON.stringify({ fireUrl: input.fireUrl, token: input.token }), 'integration:claude_routine');
    const iso = now.toISOString();
    const res = await run(
      db,
      `INSERT INTO integrations (provider, display_name, status, encrypted_credentials, metadata_json, created_at, updated_at)
       VALUES ('claude_routine', ?, 'connected', ?, ?, ?, ?)`,
      input.displayName,
      encrypted,
      JSON.stringify({ purpose: input.purpose, routineId: input.fireUrl.match(/trig_[A-Za-z0-9]+/)?.[0] ?? null, tokenHint: `${input.token.slice(0, 14)}…` }),
      iso,
      iso,
    );
    await audit(db, now, c.get('actor'), 'integration.claude.add', 'integration', res.meta.last_row_id, { purpose: input.purpose });
    // 등록만으로 호출하지 않는다(호출 = 세션 생성 = 사용량 소모). 연결 확인은 첫 유지보수 실행 때 이뤄진다.
    return ok(c, { id: res.meta.last_row_id }, 201);
  });

  app.delete('/api/integrations/claude/:id', async (c) => {
    const db = c.env.DB;
    const id = idParam(c);
    const row = await getIntegrationById(db, id);
    if (!row || row.provider !== 'claude_routine') throw notFound();
    await run(db, `DELETE FROM integrations WHERE id = ?`, id);
    await audit(db, deps.now(), c.get('actor'), 'integration.claude.remove', 'integration', id);
    return ok(c, { deleted: true });
  });

  // ====================== Publications ======================
  app.get('/api/publications', async (c) => {
    const platform = c.req.query('platform');
    const projectId = c.req.query('projectId');
    return ok(c, await listPublications(c.env.DB, { platform: platform || undefined, projectId: projectId ? Number(projectId) : undefined }));
  });

  // ====================== Kakao ======================
  app.get('/api/integrations/kakao/status', async (c) => ok(c, await kakaoStatus(c.env, c.env.DB)));

  app.get('/api/integrations/kakao/connect', async (c) => {
    const cfg = kakaoAppConfig(c.env);
    if (!cfg || c.env.APP_MODE === 'demo') return c.redirect('/notifications?kakao=not_configured', 302);
    const state = await createOAuthState(c.env.DB, deps.now());
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax', // 카카오에서 돌아오는 top-level GET에 실려야 한다
      path: '/api/integrations/kakao',
      maxAge: 600,
    });
    return c.redirect(buildAuthorizeUrl(cfg, state), 302);
  });

  app.post('/api/integrations/kakao/disconnect', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { revokeRemote?: boolean };
    const res = await disconnectKakao(c.env, c.env.DB, deps, Boolean(body.revokeRemote));
    await audit(c.env.DB, deps.now(), c.get('actor'), 'kakao.disconnect', 'integration', 'kakao', { remoteRevoked: res.remoteRevoked });
    return ok(c, res);
  });

  app.post('/api/integrations/kakao/test-message', async (c) => {
    const result = await sendTestMessage(c.env, c.env.DB, deps);
    await audit(c.env.DB, deps.now(), c.get('actor'), 'kakao.test_message', 'integration', 'kakao', { status: result.status });
    return ok(c, result);
  });

  // ====================== Reports / Notifications ======================
  app.get('/api/reports/daily', async (c) => {
    const date = c.req.query('date');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('날짜 형식은 YYYY-MM-DD');
    return ok(c, { report: await getDailyReport(c.env.DB, date), history: await listDailyReports(c.env.DB) });
  });

  app.get('/api/reports/preview', async (c) => {
    const now = deps.now();
    const { report, messages } = await generateReport(c.env, c.env.DB, deps, localDateString(now, c.env.APP_TIMEZONE || 'Asia/Seoul'));
    return ok(c, { report, messages, lengths: messages.map((m) => [...m].length) });
  });

  app.post('/api/reports/daily/send', async (c) => {
    const result = await runDailyReport(c.env, c.env.DB, deps, { trigger: 'manual' });
    await audit(c.env.DB, deps.now(), c.get('actor'), 'report.daily.manual_send', 'daily_report', result.reportDate, { action: result.action });
    return ok(c, result);
  });

  app.get('/api/notifications/history', async (c) => {
    const rows = await all(
      c.env.DB,
      `SELECT id, channel, notification_type AS type, status, payload_summary AS summary, sent_at AS sentAt,
         provider_response_code AS responseCode, safe_error_message AS error, created_at AS createdAt
       FROM notification_deliveries ORDER BY id DESC LIMIT 100`,
    );
    return ok(c, { history: rows, settings: await getNotificationSettings(c.env.DB) });
  });

  app.patch('/api/notifications/settings', async (c) => {
    const now = deps.now();
    const input = await parseJsonBody(c, notificationSettingsSchema);
    const current = await getNotificationSettings(c.env.DB);
    const next: NotificationSettings = { ...current, ...input };
    await putSetting(c.env.DB, 'notifications', next, now);
    await audit(c.env.DB, now, c.get('actor'), 'notifications.settings', 'settings', 'notifications', input);
    return ok(c, next);
  });

  // ====================== Usage ======================
  app.get('/api/usage/summary', async (c) => {
    const now = deps.now();
    const to = c.req.query('to') ?? now.toISOString().slice(0, 10);
    const from = c.req.query('from') ?? new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('날짜 형식은 YYYY-MM-DD');
    return ok(c, await usageSummary(c.env.DB, from, to));
  });

  app.post('/api/usage/manual-record', async (c) => {
    const now = deps.now();
    const input = await parseJsonBody(c, manualUsageSchema);
    const id = await addManualUsage(c.env.DB, now, input);
    await audit(c.env.DB, now, c.get('actor'), 'usage.manual_record', 'usage_record', id, { provider: input.provider, metric: input.metricName });
    return ok(c, { id }, 201);
  });

  // ====================== Settings / System ======================
  app.get('/api/settings/system', async (c) => {
    const env = c.env;
    const integrations = (await listIntegrations(env.DB)).map(publicIntegration);
    const projects = await listProjects(env.DB);
    const github = integrations.find((i) => i.provider === 'github');
    const kakao = integrations.find((i) => i.provider === 'kakao');
    const routines = integrations.filter((i) => i.provider === 'claude_routine');
    const hb = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_secrets WHERE revoked_at IS NULL`);
    const pubs = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM publications`);
    const settings = await getNotificationSettings(env.DB);
    const kakaoMsg = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM notification_deliveries WHERE notification_type='test' AND status='sent'`);
    type Step = { key: string; label: string; state: '완료' | '필요' | '선택'; detail?: string };
    const steps: Step[] = [
      { key: 'admin', label: '관리자 비밀번호 및 서비스 도메인', state: env.ADMIN_PASSWORD_HASH && env.PUBLIC_BASE_URL ? '완료' : '필요', detail: env.PUBLIC_BASE_URL || 'PUBLIC_BASE_URL 미설정' },
      { key: 'encryption', label: '암호화 키(HQ_ENCRYPTION_KEY)', state: env.HQ_ENCRYPTION_KEY ? '완료' : '필요' },
      { key: 'github', label: 'GitHub 연결', state: github?.status === 'connected' ? '완료' : '필요', detail: github?.status },
      { key: 'projects', label: '모니터링할 저장소 등록', state: projects.length > 0 ? '완료' : '필요', detail: `${projects.length}개` },
      { key: 'sync', label: 'workflow run 수집 테스트', state: projects.some((p) => p.last_synced_at && !p.last_sync_error_code) ? '완료' : '필요' },
      { key: 'schedule', label: '프로젝트별 기대 실행 일정', state: projects.length > 0 ? '완료' : '필요' },
      { key: 'webhook', label: 'GitHub webhook(또는 polling fallback)', state: env.GITHUB_WEBHOOK_SECRET ? '완료' : '선택', detail: env.GITHUB_WEBHOOK_SECRET ? undefined : '미설정 시 10분 polling으로 동작' },
      { key: 'heartbeat', label: '일반 자동화 Heartbeat 연결', state: (hb?.n ?? 0) > 0 ? '완료' : '선택' },
      { key: 'publications', label: 'YouTube/Instagram 게시 이벤트', state: (pubs?.n ?? 0) > 0 ? '완료' : '선택' },
      { key: 'kakao_app', label: 'Kakao Developers 앱 설정', state: env.KAKAO_REST_API_KEY ? '완료' : '필요' },
      { key: 'kakao_oauth', label: '카카오 OAuth 연결', state: kakao?.status === 'connected' ? '완료' : '필요', detail: kakao?.status },
      { key: 'kakao_test', label: '카카오 테스트 메시지', state: (kakaoMsg?.n ?? 0) > 0 ? '완료' : '필요' },
      { key: 'daily', label: `${DAILY_REPORT_TIME_LABEL} 정기 보고서 활성화`, state: settings.dailyReportEnabled && kakao?.status === 'connected' ? '완료' : '필요' },
      { key: 'claude', label: 'Claude Code Routine 연결', state: routines.length > 0 ? '완료' : '선택' },
    ];
    return ok(c, {
      mode: env.APP_MODE,
      timezone: env.APP_TIMEZONE || 'Asia/Seoul',
      publicBaseUrl: env.PUBLIC_BASE_URL || null,
      secrets: {
        adminPassword: Boolean(env.ADMIN_PASSWORD_HASH),
        encryptionKey: Boolean(env.HQ_ENCRYPTION_KEY),
        encryptionKeyPrevious: Boolean(env.HQ_ENCRYPTION_KEY_PREVIOUS),
        githubWebhookSecret: Boolean(env.GITHUB_WEBHOOK_SECRET),
        kakaoRestApiKey: Boolean(env.KAKAO_REST_API_KEY),
        kakaoClientSecret: Boolean(env.KAKAO_CLIENT_SECRET),
      },
      cron: env.SCHEDULER_ALARM
        ? {
            expression: '*/10 * * * *',
            note: `Durable Object 알람이 10분마다 깨움(GitHub Actions ${env.SCHEDULER_OIDC_REPOSITORY ?? ''} scheduler.yml은 백업). ${DAILY_REPORT_WINDOW_LABEL} KST 사이 미발송 보고서를 따라잡아 발송.`,
          }
        : { expression: '*/10 * * * *', note: `Cloudflare Cron은 UTC 기준. ${DAILY_REPORT_WINDOW_LABEL} KST 사이 미발송 보고서를 발송(지연 복구).` },
      onboarding: steps,
    });
  });

  app.get('/api/settings/export', async (c) => {
    const db = c.env.DB;
    const [projects, sources] = await Promise.all([listProjects(db), listSources(db)]);
    const now = deps.now();
    await audit(db, now, c.get('actor'), 'settings.export', 'settings', null);
    return c.json(
      {
        exportedAt: now.toISOString(),
        note: '비밀 값(토큰·secret)은 포함되지 않습니다.',
        projects: projects.map((p) => projectToInput(p, sources.filter((s) => s.project_id === p.id))),
        notificationSettings: await getNotificationSettings(db),
      },
      200,
      { 'Content-Disposition': `attachment; filename="automatehq-export-${now.toISOString().slice(0, 10)}.json"` },
    );
  });

  app.get('/api/audit-logs', async (c) => {
    const rows = await listAudit(c.env.DB, 200);
    return ok(c, (rows as Record<string, unknown>[]).map((r) => ({ ...r, safe_metadata_json: parseJson(r.safe_metadata_json, {}) })));
  });

  return app;
}
