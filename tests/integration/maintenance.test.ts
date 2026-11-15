import { describe, expect, it } from 'vitest';
import { checkMaintenancePolicy, judgeCallback, buildRoutinePrompt } from '../../worker/src/services/maintenance/policy';
import { body, createHarness, json, mockFetch } from '../helpers/harness';

const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOP/fire';
const ROUTINE_TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40);

async function project(h: Awaited<ReturnType<typeof createHarness>>, over: Record<string, unknown> = {}) {
  await h.login();
  const res = await h.request('POST', '/api/projects', {
    projectKey: 'my-app',
    name: '개인 앱',
    repoOwner: 'Logic-Phantom',
    repoName: 'lunchagree',
    expectedCadence: 'irregular',
    expectedTimeLocal: null,
    ...over,
  });
  return (await body(res)).data.id as number;
}

describe('유지보수 정책', () => {
  const base = { maintenanceEnabled: false, maintenanceMode: 'AUDIT' as const, defaultBranch: 'main', isActive: true };
  it('AUDIT는 항상 허용, DRAFT_PR은 명시적으로 켠 프로젝트만 허용', () => {
    expect(checkMaintenancePolicy(base, 'AUDIT').allowed).toBe(true);
    expect(checkMaintenancePolicy(base, 'DRAFT_PR').allowed).toBe(false);
    expect(checkMaintenancePolicy({ ...base, maintenanceEnabled: true, maintenanceMode: 'PROPOSE' }, 'DRAFT_PR').allowed).toBe(false);
    expect(checkMaintenancePolicy({ ...base, maintenanceEnabled: true, maintenanceMode: 'DRAFT_PR' }, 'DRAFT_PR').allowed).toBe(true);
  });

  it('테스트 실패/미확인 PR은 성공(completed)으로 표시하지 않는다', () => {
    expect(judgeCallback('DRAFT_PR', 'main', { status: 'completed', testsPassed: false, pullRequestUrl: 'https://github.com/a/b/pull/1' }).status).toBe('needs_review');
    expect(judgeCallback('DRAFT_PR', 'main', { status: 'completed', testsPassed: null, pullRequestUrl: 'https://github.com/a/b/pull/1' }).status).toBe('needs_review');
    expect(judgeCallback('DRAFT_PR', 'main', { status: 'completed', testsPassed: true, pullRequestUrl: 'https://github.com/a/b/pull/1', branchName: 'hq/maint-1' }).status).toBe('completed');
  });

  it('기본 브랜치 변경 보고·AUDIT 모드의 PR 보고는 검토 필요로 표시한다', () => {
    expect(judgeCallback('DRAFT_PR', 'main', { status: 'completed', testsPassed: true, branchName: 'main' }).status).toBe('needs_review');
    expect(judgeCallback('AUDIT', 'main', { status: 'completed', pullRequestUrl: 'https://github.com/a/b/pull/2' }).status).toBe('needs_review');
  });

  it('AUDIT 프롬프트는 읽기 전용이며 브랜치/PR 생성 지시가 없다', () => {
    const p = buildRoutinePrompt({ mode: 'AUDIT', jobId: 1, project: { name: 'x', projectKey: 'x', repo: 'a/b', defaultBranch: 'main' }, recentFailures: [] });
    expect(p).toContain('읽기 전용');
    expect(p).not.toContain('Draft PR을 만든다');
    expect(p).toContain('기본 브랜치에 직접 push');
  });
});

describe('유지보수 실행', () => {
  it('Routine이 없으면 연동 미설정으로 표시하고 규칙 기반 점검만 기록한다', async () => {
    const h = await createHarness();
    const id = await project(h);
    const res = await body(await h.request('POST', `/api/projects/${id}/maintenance/run`, { mode: 'AUDIT' }));
    expect(res.data.routineConfigured).toBe(false);
    expect(res.data.status).toBe('rule_based_done');
    expect(res.data.message).toContain('Claude Code 연결 필요');
  });

  it('DRAFT_PR을 허용하지 않은 프로젝트는 수정 작업을 실행하지 않는다', async () => {
    const fire = mockFetch(() => json({ type: 'routine_fire', claude_code_session_id: 's', claude_code_session_url: 'https://claude.ai/code/s' }));
    const h = await createHarness({ fetch: fire.fn });
    const id = await project(h);
    await h.request('POST', '/api/integrations/claude', { displayName: 'PR', purpose: 'draft_pr', fireUrl: FIRE_URL, token: ROUTINE_TOKEN });
    const res = await body(await h.request('POST', `/api/projects/${id}/maintenance/run`, { mode: 'DRAFT_PR' }));
    expect(res.data.status).toBe('blocked');
    expect(fire.calls.length).toBe(0);
  });

  it('Routine 호출은 공식 계약(헤더·text 본문)으로 보내고, 비동기 결과는 시작됨으로만 기록한다', async () => {
    const fire = mockFetch(() => json({ type: 'routine_fire', claude_code_session_id: 'session_01', claude_code_session_url: 'https://claude.ai/code/session_01' }));
    const h = await createHarness({ fetch: fire.fn });
    const id = await project(h);
    const add = await h.request('POST', '/api/integrations/claude', { displayName: '점검', purpose: 'audit', fireUrl: FIRE_URL, token: ROUTINE_TOKEN });
    expect(add.status).toBe(201);
    const res = await body(await h.request('POST', `/api/projects/${id}/maintenance/run`, { mode: 'AUDIT' }));
    expect(res.data.status).toBe('started');
    const call = fire.calls[0]!;
    expect(call.url).toBe(FIRE_URL);
    expect(call.headers.authorization).toBe(`Bearer ${ROUTINE_TOKEN}`);
    expect(call.headers['anthropic-version']).toBeTruthy();
    expect(JSON.parse(call.body).text).toContain('mode: AUDIT');
    const job = h.db.get<{ status: string; completed_at: string | null; routine_session_url: string }>(`SELECT status, completed_at, routine_session_url FROM maintenance_jobs`);
    expect(job.status).toBe('started');
    expect(job.completed_at).toBeNull();
    expect(job.routine_session_url).toBe('https://claude.ai/code/session_01');
  });

  it('허용 목록 밖의 Routine URL은 저장하지 않는다(SSRF 방지)', async () => {
    const h = await createHarness();
    await project(h);
    const res = await h.request('POST', '/api/integrations/claude', { displayName: 'x', purpose: 'audit', fireUrl: 'https://evil.example.com/fire', token: ROUTINE_TOKEN });
    expect(res.status).toBe(400);
  });

  it('결과 회신은 작업별 토큰으로만 받고, 테스트 미통과 PR은 needs_review가 된다', async () => {
    const fire = mockFetch(() => json({ type: 'routine_fire', claude_code_session_id: 'session_02', claude_code_session_url: 'https://claude.ai/code/session_02' }));
    const h = await createHarness({ fetch: fire.fn });
    const id = await project(h, { maintenanceEnabled: true, maintenanceMode: 'DRAFT_PR' });
    await h.request('POST', '/api/integrations/claude', { displayName: 'PR', purpose: 'draft_pr', fireUrl: FIRE_URL, token: ROUTINE_TOKEN });
    const started = await body(await h.request('POST', `/api/projects/${id}/maintenance/run`, { mode: 'DRAFT_PR' }));
    const text = JSON.parse(fire.calls[0]!.body).text as string;
    const token = text.match(/Authorization: Bearer (\S+)/)![1]!;
    const payload = { jobId: started.data.jobId, status: 'completed', testsPassed: false, branchName: 'hq/maint-1-fix', pullRequestUrl: 'https://github.com/Logic-Phantom/lunchagree/pull/7' };
    const bad = await h.app.request('https://hq.example.test/api/v1/maintenance/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: JSON.stringify(payload) }, h.env);
    expect(bad.status).toBe(401);
    const good = await h.app.request('https://hq.example.test/api/v1/maintenance/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }, h.env);
    expect((await body(good)).data.status).toBe('needs_review');
    expect(h.db.get<{ status: string; approval_state: string }>(`SELECT status, approval_state FROM maintenance_jobs`)).toEqual({ status: 'needs_review', approval_state: 'pending' });
  });
});
