import { describe, expect, it } from 'vitest';
import { KAKAO_TEXT_LIMIT } from '../../shared/constants';
import { upsertSingletonIntegration, readCredentials, getIntegration } from '../../worker/src/repositories/integrations';
import { mergeTokenResponse, type KakaoTokens } from '../../worker/src/services/kakao/service';
import { runDailyReport } from '../../worker/src/services/reporting/daily';
import { buildDailyReport, renderKakaoMessages } from '../../worker/src/services/reporting/report';
import { body, createHarness, json, mockFetch, type MockCall } from '../helpers/harness';

const ACCESS = 'kakao-access-token-AAAAAAAAAAAA';
const REFRESH = 'kakao-refresh-token-BBBBBBBBBBBB';

function kakaoServer(opts: { refreshStatus?: number; refreshBody?: Record<string, unknown>; sendStatus?: number } = {}) {
  return mockFetch((call: MockCall) => {
    if (call.url === 'https://kauth.kakao.com/oauth/token') {
      if (opts.refreshStatus && opts.refreshStatus !== 200) return json({ error: 'invalid_grant', error_code: 'KOE322' }, opts.refreshStatus);
      if (call.body.includes('grant_type=authorization_code'))
        return json({ access_token: ACCESS, token_type: 'bearer', expires_in: 21599, refresh_token: REFRESH, refresh_token_expires_in: 5183999, scope: 'talk_message' });
      return json(opts.refreshBody ?? { access_token: 'kakao-access-token-NEW-1234', token_type: 'bearer', expires_in: 21599 });
    }
    if (call.url === 'https://kapi.kakao.com/v2/api/talk/memo/default/send') {
      return opts.sendStatus && opts.sendStatus !== 200 ? json({ code: -401, msg: 'expired' }, opts.sendStatus) : json({ result_code: 0 });
    }
    return json({}, 404);
  });
}

async function connected(h: Awaited<ReturnType<typeof createHarness>>, tokens: Partial<KakaoTokens> = {}) {
  await upsertSingletonIntegration(
    h.env,
    h.db,
    'kakao',
    {
      displayName: '카카오톡 나에게 보내기',
      status: 'connected',
      credentials: {
        accessToken: ACCESS,
        accessExpiresAt: new Date(h.clock.now.getTime() + 3600_000).toISOString(),
        refreshToken: REFRESH,
        refreshExpiresAt: null,
        ...tokens,
      } satisfies KakaoTokens,
    },
    h.clock.now,
  );
}

describe('카카오 OAuth', () => {
  it('state가 일치하지 않으면 토큰 교환을 하지 않는다', async () => {
    const k = kakaoServer();
    const h = await createHarness({ fetch: k.fn });
    await h.login();
    const res = await h.request('GET', '/api/integrations/kakao/callback?code=abc&state=forged', undefined, { Cookie: 'hq_oauth_state=other' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('state_invalid');
    expect(k.calls.length).toBe(0);
  });

  it('connect → callback 정상 흐름: state 1회용, 토큰은 암호화 저장', async () => {
    const k = kakaoServer();
    const h = await createHarness({ fetch: k.fn });
    await h.login();
    const connect = await h.request('GET', '/api/integrations/kakao/connect');
    expect(connect.status).toBe(302);
    const location = new URL(connect.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://kauth.kakao.com/oauth/authorize');
    expect(location.searchParams.get('scope')).toBe('talk_message');
    const state = location.searchParams.get('state')!;
    const cb = await h.app.request(
      `https://hq.example.test/api/integrations/kakao/callback?code=the-code&state=${state}`,
      { headers: { Cookie: `hq_oauth_state=${state}` } },
      h.env,
    );
    expect(cb.headers.get('location')).toContain('kakao=connected');
    const tokenCall = k.calls.find((c) => c.url.includes('oauth/token'))!;
    expect(tokenCall.body).toContain('client_secret=test-client-secret'); // Client Secret 활성 시 포함
    const row = h.db.get<{ encrypted_credentials: string }>(`SELECT encrypted_credentials FROM integrations WHERE provider='kakao'`);
    expect(row.encrypted_credentials).not.toContain(REFRESH);
    // 같은 state 재사용 불가
    const replay = await h.app.request(
      `https://hq.example.test/api/integrations/kakao/callback?code=the-code&state=${state}`,
      { headers: { Cookie: `hq_oauth_state=${state}` } },
      h.env,
    );
    expect(replay.headers.get('location')).toContain('state_invalid');
  });
});

describe('카카오 토큰 갱신', () => {
  it('새 refresh token이 응답에 있을 때만 교체한다', () => {
    const now = new Date('2026-11-16T00:00:00Z');
    const prev: KakaoTokens = { accessToken: 'a', accessExpiresAt: '', refreshToken: 'old', refreshExpiresAt: '2026-12-01T00:00:00Z' };
    const kept = mergeTokenResponse(prev, { access_token: 'a2', token_type: 'bearer', expires_in: 21599 }, now);
    expect(kept.refreshToken).toBe('old');
    const rotated = mergeTokenResponse(prev, { access_token: 'a3', token_type: 'bearer', expires_in: 21599, refresh_token: 'new', refresh_token_expires_in: 5184000 }, now);
    expect(rotated.refreshToken).toBe('new');
    expect(rotated.refreshExpiresAt).toBe(new Date(now.getTime() + 5184000_000).toISOString());
  });

  it('access token이 만료되면 refresh 후 발송하고, 새 refresh token을 안전하게 저장한다', async () => {
    const k = kakaoServer({ refreshBody: { access_token: 'kakao-access-token-NEW-1234', token_type: 'bearer', expires_in: 21599, refresh_token: 'rotated-refresh-CCCCCCCC', refresh_token_expires_in: 5184000 } });
    const h = await createHarness({ fetch: k.fn });
    await h.login();
    await connected(h, { accessExpiresAt: new Date(h.clock.now.getTime() - 1000).toISOString() });
    const res = await body(await h.request('POST', '/api/integrations/kakao/test-message'));
    expect(res.data.status).toBe('SENT');
    expect(k.calls[0]!.body).toContain('grant_type=refresh_token');
    const send = k.calls.find((c) => c.url.includes('memo'))!;
    expect(send.headers.authorization).toBe('Bearer kakao-access-token-NEW-1234');
    const creds = await readCredentials<KakaoTokens>(h.env, await getIntegration(h.db, 'kakao'));
    expect(creds!.refreshToken).toBe('rotated-refresh-CCCCCCCC');
  });

  it('refresh token이 만료되면 재연결 필요로 표시한다', async () => {
    const k = kakaoServer({ refreshStatus: 400 });
    const h = await createHarness({ fetch: k.fn });
    await h.login();
    await connected(h, { accessExpiresAt: new Date(h.clock.now.getTime() - 1000).toISOString() });
    const res = await body(await h.request('POST', '/api/integrations/kakao/test-message'));
    expect(res.data.status).toBe('REAUTH_REQUIRED');
    const status = await body(await h.request('GET', '/api/integrations/kakao/status'));
    expect(status.data.status).toBe('reauth_required');
    expect(h.db.count('incidents', `fingerprint='integration:kakao:REAUTH'`)).toBe(1);
  });

  it('토큰이 API 응답에 노출되지 않는다', async () => {
    const k = kakaoServer();
    const h = await createHarness({ fetch: k.fn });
    await h.login();
    await connected(h);
    const texts = await Promise.all(
      ['/api/integrations/kakao/status', '/api/overview', '/api/settings/system', '/api/notifications/history'].map(async (p) => (await h.request('GET', p)).text()),
    );
    for (const t of texts) {
      expect(t).not.toContain(ACCESS);
      expect(t).not.toContain(REFRESH);
    }
  });
});

describe('12:00 정기 보고서', () => {
  it('발송 성공/실패 이력을 저장하고 같은 날짜에는 중복 발송하지 않는다', async () => {
    const k = kakaoServer();
    // 2026-11-16 12:05 KST
    const h = await createHarness({ fetch: k.fn, now: new Date('2026-11-16T03:05:00Z') });
    await connected(h);
    const first = await runDailyReport(h.env, h.db, h.deps, { trigger: 'cron' });
    expect(first.action).toBe('sent');
    expect(first.reportDate).toBe('2026-11-16');
    h.clock.now = new Date('2026-11-16T03:15:00Z');
    const second = await runDailyReport(h.env, h.db, h.deps, { trigger: 'cron' });
    expect(second.action).toBe('skipped');
    const memoCalls = k.calls.filter((c) => c.url.includes('memo')).length;
    expect(memoCalls).toBeGreaterThan(0);
    expect(memoCalls).toBeLessThanOrEqual(3);
    expect(h.db.count('daily_reports', `status='sent'`)).toBe(1);
    expect(h.db.count('notification_deliveries', `notification_type='daily_report' AND status='sent'`)).toBe(1);
  });

  it('12시 이전·22시 이후에는 보내지 않고, 실패하면 이력을 남긴 뒤 다음 cron에서 재시도한다', async () => {
    const k = kakaoServer({ sendStatus: 500 });
    const h = await createHarness({ fetch: k.fn, now: new Date('2026-11-16T02:50:00Z') }); // 11:50 KST
    await connected(h);
    expect((await runDailyReport(h.env, h.db, h.deps, { trigger: 'cron' })).action).toBe('skipped');
    h.clock.now = new Date('2026-11-16T13:00:00Z'); // 22:00 KST — 따라잡기 창 밖
    expect((await runDailyReport(h.env, h.db, h.deps, { trigger: 'cron' })).action).toBe('skipped');
    h.clock.now = new Date('2026-11-16T03:00:00Z');
    expect((await runDailyReport(h.env, h.db, h.deps, { trigger: 'cron' })).action).toBe('failed');
    expect(h.db.get<{ status: string; attempt_count: number }>(`SELECT status, attempt_count FROM daily_reports`)).toEqual({ status: 'failed', attempt_count: 1 });
    expect(h.db.count('notification_deliveries', `status='failed'`)).toBe(1);
  });

  it('테스트 메시지는 정기 보고서와 별도 이력으로 저장된다', async () => {
    const k = kakaoServer();
    const h = await createHarness({ fetch: k.fn });
    await h.login();
    await connected(h);
    await h.request('POST', '/api/integrations/kakao/test-message');
    expect(h.db.count('notification_deliveries', `notification_type='test'`)).toBe(1);
    expect(h.db.count('daily_reports')).toBe(0);
  });

  it('카카오 메시지는 200자 이하 한 건으로 렌더링되고 AI 미연결 시 점검 요약으로 표기한다', () => {
    const now = new Date('2026-11-15T22:00:00Z');
    const evals = Array.from({ length: 12 }, (_, i) => ({
      project: { id: i + 1, name: `아주 긴 이름의 자동화 프로젝트 ${i + 1}번`, is_active: 1, priority: 'normal' },
      classification: {
        status: i < 4 ? 'FAILED' : i < 8 ? 'ATTENTION' : 'NORMAL',
        reasons: [{ code: 'RUN_FAILED', severity: 'high', message: '최근 실행 실패: GitHub Actions failure (인증 오류 401로 추정되지 않음)', managed: true }],
        lastRun: null,
        lastSuccessAt: null,
        nextExpectedAt: null,
        dueAt: null,
      },
    }));
    const report = buildDailyReport(evals as never, { reportDate: '2026-11-16', now, timezone: 'Asia/Seoul', globalIssues: [], isSample: false });
    const msgs = renderKakaoMessages(report, now);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] ?? '';
    expect([...m].length).toBeLessThanOrEqual(KAKAO_TEXT_LIMIT);
    expect(m).toContain('🔴 실패 4 · 🟡 확인 4 · 🟢 정상 4');
    expect(m).toMatch(/외 \d+건은 HQ에서 확인/); // 넘치는 프로젝트는 건수로 접는다
    expect(m).toContain('🧭 점검 요약');
    expect(m).not.toContain('AI 분석');
    expect(m.split('\n\n').length).toBeGreaterThanOrEqual(4); // 제목 / 건수 / 문제 / 요약 묶음 사이 빈 줄
  });

  it('카카오 메시지: 모두 정상이면 짧게, 문제 1건이면 원인과 AI 분석까지 보여 준다', () => {
    const now = new Date('2026-11-16T03:00:00Z');
    const ev = (id: number, name: string, status: string, message: string) => ({
      project: { id, name, is_active: 1, priority: 'normal' },
      classification: { status, reasons: [{ code: 'X', severity: 'high', message, managed: true }], lastRun: null, lastSuccessAt: null, nextExpectedAt: null, dueAt: null },
    });
    const normal = [1, 2, 3].map((i) => ev(i, `정상 ${i}`, 'NORMAL', '정상'));
    const ok = buildDailyReport(normal as never, { reportDate: '2026-11-16', now, timezone: 'Asia/Seoul', globalIssues: [], isSample: false });
    const okMsg = renderKakaoMessages(ok, now)[0] ?? '';
    expect(okMsg).toBe('🤖 HQ 운영 보고 · 11.16 (월) 12:00\n\n✅ 3개 모두 정상\n\n🧭 점검 요약\n모든 활성 프로젝트가 정상입니다.');

    const failed = [ev(9, '기술 블로그 (GitHub Pages)', 'FAILED', '최근 실행 실패: pages-build-deployment failure'), ...normal];
    const ai = buildDailyReport(failed as never, {
      reportDate: '2026-11-16', now, timezone: 'Asia/Seoul', globalIssues: [], isSample: false, aiAnalysis: '블로그 배포만 재실행하면 됩니다.',
    });
    const aiMsg = renderKakaoMessages(ai, now)[0] ?? '';
    expect(aiMsg).toContain('🔴 기술 블로그 (GitHub Pages)\n   └ pages-build-deployment failure');
    expect(aiMsg).not.toContain('최근 실행 실패:'); // 아이콘과 겹치는 머리말은 뺀다
    expect(aiMsg.endsWith('🧠 AI 분석\n블로그 배포만 재실행하면 됩니다.')).toBe(true);
  });
});
