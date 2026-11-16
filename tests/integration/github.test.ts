import { describe, expect, it } from 'vitest';
import { classifyGithubError } from '../../worker/src/services/github/client';
import { hmacSha256Hex } from '../../worker/src/security/crypto';
import { body, createHarness, json, mockFetch } from '../helpers/harness';

const SECRET = 'gh-webhook-test-secret';

function workflowRunPayload(id: number, conclusion: string | null, status = 'completed', startedAt = '2026-11-15T22:01:00Z') {
  return {
    action: status === 'completed' ? 'completed' : 'in_progress',
    repository: { name: 'StrangeRecords', owner: { login: 'Logic-Phantom' } },
    workflow_run: {
      id,
      name: 'daily-shorts',
      path: '.github/workflows/daily-shorts.yml',
      event: 'schedule',
      status,
      conclusion,
      head_branch: 'main',
      head_sha: 'abc123',
      html_url: `https://github.com/Logic-Phantom/StrangeRecords/actions/runs/${id}`,
      run_attempt: 1,
      run_started_at: startedAt,
      created_at: '2026-11-15T22:00:30Z',
      updated_at: '2026-11-15T22:09:00Z',
      workflow_id: 1,
    },
  };
}

async function setupProject(h: Awaited<ReturnType<typeof createHarness>>) {
  await h.login();
  const res = await h.request('POST', '/api/projects', {
    projectKey: 'strange-records',
    name: '기묘한 기록',
    repoOwner: 'Logic-Phantom',
    repoName: 'StrangeRecords',
    workflowFile: 'daily-shorts.yml',
  });
  expect(res.status).toBe(201);
  return (await body(res)).data.id as number;
}

async function sendWebhook(h: Awaited<ReturnType<typeof createHarness>>, payload: unknown, delivery: string, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + (await hmacSha256Hex(secret, raw));
  return h.app.request(
    'https://hq.example.test/api/webhooks/github',
    {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'workflow_run', 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': sig, 'Content-Type': 'application/json' },
      body: raw,
    },
    h.env,
  );
}

describe('GitHub Webhook', () => {
  it('올바른 HMAC 서명은 통과하고 run을 기록한다', async () => {
    const h = await createHarness();
    await setupProject(h);
    const res = await sendWebhook(h, workflowRunPayload(101, 'success'), 'd-1');
    expect(res.status).toBe(200);
    expect((await body(res)).data.result).toBe('processed');
    expect(h.db.get<{ status: string }>(`SELECT status FROM runs WHERE external_run_id='101'`).status).toBe('success');
  });

  it('잘못된 서명은 거부한다', async () => {
    const h = await createHarness();
    await setupProject(h);
    const res = await sendWebhook(h, workflowRunPayload(102, 'success'), 'd-2', 'wrong-secret');
    expect(res.status).toBe(401);
    expect(h.db.count('runs')).toBe(0);
    expect(h.db.count('webhook_deliveries', `processing_status='rejected'`)).toBe(1);
  });

  it('같은 delivery ID는 한 번만 처리한다', async () => {
    const h = await createHarness();
    await setupProject(h);
    await sendWebhook(h, workflowRunPayload(103, 'failure'), 'd-3');
    const dup = await sendWebhook(h, workflowRunPayload(103, 'success'), 'd-3');
    expect((await body(dup)).data.result).toBe('duplicate');
    expect(h.db.get<{ status: string }>(`SELECT status FROM runs WHERE external_run_id='103'`).status).toBe('failure');
  });

  it('workflow_run completed 성공/실패를 정확히 반영하고 실패는 incident를 연다', async () => {
    const h = await createHarness({ now: new Date('2026-11-15T22:30:00Z') });
    const projectId = await setupProject(h);
    await sendWebhook(h, workflowRunPayload(104, 'failure'), 'd-4');
    const overview = await body(await h.request('GET', '/api/overview'));
    expect(overview.data.projects.find((p: { id: number }) => p.id === projectId).status).not.toBe('NORMAL');
    // 판정 + incident 반영은 스케줄러/평가에서 이뤄진다
    const { evaluateAll } = await import('../../worker/src/services/monitoring/evaluate');
    await evaluateAll(h.db, h.clock.now);
    expect(h.db.count('incidents', `category='RUN_FAILED' AND status='open'`)).toBe(1);
    await sendWebhook(h, workflowRunPayload(105, 'success', 'completed', '2026-11-15T22:20:00Z'), 'd-5');
    await evaluateAll(h.db, h.clock.now);
    expect(h.db.count('incidents', `category='RUN_FAILED' AND status='resolved'`)).toBe(1);
  });

  it('허용하지 않은 이벤트는 무시한다', async () => {
    const h = await createHarness();
    const raw = '{}';
    const res = await h.app.request(
      'https://hq.example.test/api/webhooks/github',
      {
        method: 'POST',
        headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-x', 'X-Hub-Signature-256': 'sha256=' + (await hmacSha256Hex(SECRET, raw)) },
        body: raw,
      },
      h.env,
    );
    expect((await body(res)).data.result).toBe('ignored');
  });
});

describe('GitHub API 오류 분류', () => {
  it('401/403/404/rate limit을 서로 다른 오류로 분류한다', () => {
    const h = (o: Record<string, string> = {}) => new Headers(o);
    expect(classifyGithubError(401, h(), '{}').code).toBe('AUTH_INVALID');
    expect(classifyGithubError(403, h(), '{"message":"Resource not accessible"}').code).toBe('PERMISSION_DENIED');
    expect(classifyGithubError(403, h({ 'x-ratelimit-remaining': '0' }), '{}').code).toBe('RATE_LIMITED');
    expect(classifyGithubError(429, h({ 'retry-after': '30' }), '{}').code).toBe('RATE_LIMITED');
    expect(classifyGithubError(404, h(), '{}').code).toBe('NOT_FOUND');
    expect(classifyGithubError(502, h(), '').code).toBe('UPSTREAM_ERROR');
  });
});

describe('워크플로 재실행', () => {
  async function withRun(liveStatus: string, liveConclusion: string | null) {
    const gh = mockFetch((call) => {
      if (call.url.endsWith('/user')) return json({ login: 'Logic-Phantom' });
      if (call.url.endsWith('/rate_limit')) return json({ resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });
      if (call.method === 'GET' && call.url.includes('/actions/runs/201'))
        return json({ ...workflowRunPayload(201, liveConclusion, liveStatus).workflow_run });
      if (call.method === 'POST' && call.url.endsWith('/rerun-failed-jobs')) return new Response(null, { status: 201 });
      return json({ message: 'unexpected' }, 500);
    });
    const h = await createHarness({ fetch: gh.fn });
    await setupProject(h);
    await sendWebhook(h, workflowRunPayload(201, 'failure'), 'd-r1');
    await h.request('PUT', '/api/integrations/github', { token: 'github_pat_' + 'A'.repeat(40) });
    const runId = h.db.get<{ id: number }>(`SELECT id FROM runs WHERE external_run_id='201'`).id;
    return { h, gh, runId };
  }

  it('확인 문구 없이 요청하면 거부한다(사용자 승인 필수)', async () => {
    const { h, gh, runId } = await withRun('completed', 'failure');
    const res = await h.request('POST', `/api/runs/${runId}/rerun`, { idempotencyKey: 'idem-0001' });
    expect(res.status).toBe(400);
    expect(gh.calls.some((c) => c.url.includes('rerun'))).toBe(false);
  });

  it('승인된 요청은 재실행하고 같은 idempotency key는 중복 실행하지 않는다', async () => {
    const { h, gh, runId } = await withRun('completed', 'failure');
    const first = await h.request('POST', `/api/runs/${runId}/rerun`, { confirm: 'RERUN', idempotencyKey: 'idem-0002' });
    expect(first.status).toBe(202);
    const second = await h.request('POST', `/api/runs/${runId}/rerun`, { confirm: 'RERUN', idempotencyKey: 'idem-0002' });
    expect((await body(second)).data.duplicate).toBe(true);
    expect(gh.calls.filter((c) => c.url.endsWith('/rerun-failed-jobs')).length).toBe(1);
  });

  it('이미 실행 중인 run은 재실행하지 않는다', async () => {
    const { h, gh, runId } = await withRun('in_progress', null);
    const res = await h.request('POST', `/api/runs/${runId}/rerun`, { confirm: 'RERUN', idempotencyKey: 'idem-0003' });
    expect(res.status).toBe(409);
    expect(gh.calls.some((c) => c.url.endsWith('/rerun-failed-jobs'))).toBe(false);
  });
});

describe('저장소 커밋 감시(github_commits)', () => {
  const commit = (sha: string, message: string, date: string) => ({
    sha,
    html_url: `https://github.com/Logic-Phantom/DevVibe/commit/${sha}`,
    commit: { message, author: { name: 'Claude', date }, committer: { name: 'Claude', date } },
  });

  async function setup(now: Date) {
    const gh = mockFetch((call) => {
      if (call.url.endsWith('/user')) return json({ login: 'Logic-Phantom' });
      if (call.url.endsWith('/rate_limit')) return json({ resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });
      if (call.url.includes('/repos/Logic-Phantom/DevVibe/commits'))
        return json([
          commit('c3', '[자동 갱신] 포트폴리오 업데이트 (2026-11-16)\n\n- 상세', '2026-11-16T00:06:32Z'),
          commit('c2', '[임채명] 수동 수정', '2026-11-15T04:18:36Z'),
          commit('c1', '[자동 갱신] 포트폴리오 업데이트 (2026-11-15)', '2026-11-15T00:05:00Z'),
        ]);
      return json({ message: 'unexpected' }, 500);
    });
    const h = await createHarness({ fetch: gh.fn, now });
    await h.login();
    await h.request('PUT', '/api/integrations/github', { token: 'github_pat_' + 'A'.repeat(40) });
    const res = await h.request('POST', '/api/projects', {
      projectKey: 'devvibe',
      name: 'DevVibe',
      repoOwner: 'Logic-Phantom',
      repoName: 'DevVibe',
      defaultBranch: 'master',
      monitoringMode: 'github_commits',
      commitFilter: '[자동 갱신]',
      expectedCadence: 'daily',
      expectedTimeLocal: '09:00',
      gracePeriodMinutes: 120,
    });
    expect(res.status).toBe(201);
    const id = (await body(res)).data.id as number;
    return { h, gh, id };
  }

  it('필터 문구가 들어간 기본 브랜치 커밋만 성공 실행으로 기록하고 Actions 소스는 만들지 않는다', async () => {
    const { h, gh, id } = await setup(new Date('2026-11-16T01:00:00Z'));
    expect(h.db.count('project_sources', `project_id=${id} AND source_type='github_actions' AND is_enabled=1`)).toBe(0);
    const sync = await body(await h.request('POST', `/api/projects/${id}/sync`));
    expect(sync.data.synced).toBe(1);
    const call = gh.calls.find((c) => c.url.includes('/commits'))!;
    expect(call.url).toContain('sha=master');
    expect(call.url).toContain('since=');
    const runs = h.db.raw
      .prepare(`SELECT external_run_id, status, source_type, workflow_name FROM runs ORDER BY started_at DESC`)
      .all() as { external_run_id: string; status: string; source_type: string; workflow_name: string }[];
    expect(runs.map((r) => r.external_run_id)).toEqual(['c3', 'c1']);
    expect(runs.every((r) => r.status === 'success' && r.source_type === 'github_commits')).toBe(true);
    expect(runs[0]!.workflow_name).toBe('[자동 갱신] 포트폴리오 업데이트 (2026-11-16)');
    const dto = (await body(await h.request('GET', `/api/projects/${id}`))).data;
    expect((dto.project ?? dto).commitFilter).toBe('[자동 갱신]');
  });

  it('예정 시각+유예 안에 커밋이 없으면 정상으로 보지 않는다', async () => {
    // 11-14에 등록(기준선 수집 기간 이후), 11-18 12:00 KST: 11-17·11-18 09:00 회차 커밋이 없음(마지막 커밋 11-16)
    const { h, id } = await setup(new Date('2026-11-14T00:00:00Z'));
    h.clock.now = new Date('2026-11-18T03:00:00Z');
    await h.request('POST', `/api/projects/${id}/sync`);
    const { evaluateAll } = await import('../../worker/src/services/monitoring/evaluate');
    const r = await evaluateAll(h.db, h.deps.now());
    const e = r.evaluations.find((x) => x.project.id === id)!;
    expect(e.classification.status).not.toBe('NORMAL');
    expect(e.classification.reasons.some((x) => x.code === 'MISSED_RUN')).toBe(true);
  });
});
