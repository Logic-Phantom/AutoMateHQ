import { describe, expect, it } from 'vitest';
import { signHeartbeat } from '../../worker/src/services/heartbeat/service';
import { body, createHarness } from '../helpers/harness';

async function setup() {
  const h = await createHarness({ now: new Date('2026-11-15T22:00:00Z') });
  await h.login();
  const created = await h.request('POST', '/api/projects', {
    projectKey: 'instagram-card-publisher',
    name: 'Instagram 카드',
    category: 'instagram',
    monitoringMode: 'heartbeat',
  });
  const projectId = (await body(created)).data.id as number;
  const rotated = await body(await h.request('POST', `/api/projects/${projectId}/heartbeat-secret/rotate`));
  return { h, projectId, secret: rotated.data.secret as string };
}

async function send(
  h: Awaited<ReturnType<typeof createHarness>>,
  path: string,
  payload: Record<string, unknown>,
  secret: string,
  ts = Math.floor(h.clock.now.getTime() / 1000),
) {
  const raw = JSON.stringify(payload);
  return h.app.request(
    `https://hq.example.test${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HQ-Project': String(payload.projectKey),
        'X-HQ-Timestamp': String(ts),
        'X-HQ-Signature': await signHeartbeat(secret, ts, raw),
      },
      body: raw,
    },
    h.env,
  );
}

describe('Heartbeat', () => {
  it('발급한 secret 원문은 DB에 평문으로 남지 않는다', async () => {
    const { h, secret } = await setup();
    const row = h.db.get<{ secret_encrypted: string }>(`SELECT secret_encrypted FROM project_secrets`);
    expect(row.secret_encrypted).not.toContain(secret);
    expect(row.secret_encrypted.startsWith('v1.')).toBe(true);
  });

  it('올바른 서명·허용 timestamp는 통과하고 start → complete 상태 전이를 기록한다', async () => {
    const { h, secret } = await setup();
    const base = { projectKey: 'instagram-card-publisher', runId: 'run-1', source: 'instagram-pipeline' };
    const start = await send(h, '/api/v1/heartbeat/start', { ...base, stage: 'generating' }, secret);
    expect(start.status).toBe(202);
    expect(h.db.get<{ status: string }>(`SELECT status FROM runs WHERE external_run_id='run-1'`).status).toBe('running');
    h.clock.now = new Date('2026-11-15T22:03:15Z');
    const done = await send(
      h,
      '/api/v1/heartbeat/complete',
      {
        ...base,
        stage: 'published',
        metrics: { generatedItems: 1, publishedItems: 1 },
        publication: { platform: 'instagram', contentKey: 'card-20261116', title: '카드', status: 'published', platformUrl: 'https://www.instagram.com/p/EXAMPLE/' },
      },
      secret,
    );
    expect(done.status).toBe(202);
    const runRow = h.db.get<{ status: string; duration_seconds: number }>(`SELECT status, duration_seconds FROM runs WHERE external_run_id='run-1'`);
    expect(runRow.status).toBe('success');
    expect(runRow.duration_seconds).toBe(195);
    // 플랫폼 검증이 아니라 heartbeat 보고로 표시된다
    expect(h.db.get<{ verification_status: string }>(`SELECT verification_status FROM publications`).verification_status).toBe('heartbeat_reported');
  });

  it('늦게 도착한 start가 완료 상태를 되돌리지 않는다', async () => {
    const { h, secret } = await setup();
    const base = { projectKey: 'instagram-card-publisher', runId: 'run-late' };
    await send(h, '/api/v1/heartbeat/fail', { ...base, errorCode: 'IG_401', message: '게시 API 401' }, secret);
    h.clock.now = new Date('2026-11-15T22:00:05Z');
    await send(h, '/api/v1/heartbeat/start', base, secret);
    expect(h.db.get<{ status: string }>(`SELECT status FROM runs WHERE external_run_id='run-late'`).status).toBe('failure');
  });

  it('오래된 timestamp는 거부한다', async () => {
    const { h, secret } = await setup();
    const old = Math.floor(h.clock.now.getTime() / 1000) - 600;
    const res = await send(h, '/api/v1/heartbeat/start', { projectKey: 'instagram-card-publisher', runId: 'r' }, secret, old);
    expect(res.status).toBe(401);
  });

  it('프로젝트 secret이 다르면 거부하고 서명 불일치 incident를 남긴다', async () => {
    const { h } = await setup();
    const res = await send(h, '/api/v1/heartbeat/start', { projectKey: 'instagram-card-publisher', runId: 'r' }, 'hqhb_wrong');
    expect(res.status).toBe(401);
    expect(h.db.count('runs')).toBe(0);
    expect(h.db.count('incidents', `category='SIGNATURE_MISMATCH'`)).toBe(1);
  });

  it('같은 요청을 재전송하면 중복으로 처리하고 이벤트를 다시 쌓지 않는다', async () => {
    const { h, secret } = await setup();
    const payload = { projectKey: 'instagram-card-publisher', runId: 'dup-1' };
    await send(h, '/api/v1/heartbeat/start', payload, secret);
    const again = await send(h, '/api/v1/heartbeat/start', payload, secret);
    expect((await body(again)).data.duplicate).toBe(true);
    expect(h.db.count('run_events')).toBe(1);
  });

  it('secret 재발급 후 이전 secret은 거부된다', async () => {
    const { h, projectId, secret } = await setup();
    await h.request('POST', `/api/projects/${projectId}/heartbeat-secret/rotate`);
    const res = await send(h, '/api/v1/heartbeat/start', { projectKey: 'instagram-card-publisher', runId: 'r2' }, secret);
    expect(res.status).toBe(401);
  });
});
