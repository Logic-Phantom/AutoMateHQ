import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { loginSchema, maintenanceCallbackSchema } from '../../../shared/schemas';
import type { AppDeps, Env } from '../env';
import { first } from '../lib/db';
import { AppError, tooMany } from '../lib/http';
import { audit, rateLimit } from '../repositories/common';
import { verifyPassword } from '../security/crypto';
import {
  clientKey,
  cookieOptions,
  createSession,
  destroySession,
  isLocalRequest,
  loadSession,
  SESSION_COOKIE,
  SESSION_TTL_HOURS,
  type AppContext,
  type AppVars,
} from '../security/session';
import { handleGithubWebhook } from '../services/github/webhook';
import { handleHeartbeat, type HeartbeatType } from '../services/heartbeat/service';
import { completeOAuth, consumeOAuthState } from '../services/kakao/service';
import { KakaoApiError, KakaoReauthRequired } from '../services/kakao/client';
import { handleMaintenanceCallback } from '../services/maintenance/service';
import { runScheduledTick } from '../scheduler';
import { OidcError, verifyGithubOidc } from '../security/oidc';
import { parseJsonBody, ok } from './helpers';

export const OAUTH_STATE_COOKIE = 'hq_oauth_state';

/** 로그인 없이 접근하는 경로: 인증, 헬스체크, 서명 검증되는 수신 엔드포인트, OAuth 콜백 */
export function publicRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

  // ---------- Health ----------
  app.get('/api/health', (c) => ok(c, { status: 'ok', mode: c.env.APP_MODE, time: deps.now().toISOString() }));
  app.get('/api/health/ready', async (c) => {
    let db: boolean;
    try {
      await first(c.env.DB, `SELECT COUNT(*) AS n FROM projects`);
      db = true;
    } catch {
      db = false;
    }
    const ready = db && Boolean(c.env.HQ_ENCRYPTION_KEY) && (Boolean(c.env.ADMIN_PASSWORD_HASH) || c.env.APP_MODE === 'demo');
    return c.json({ ok: ready, data: { db, encryptionKey: Boolean(c.env.HQ_ENCRYPTION_KEY), adminPassword: Boolean(c.env.ADMIN_PASSWORD_HASH) } }, ready ? 200 : 503);
  });

  // ---------- Auth ----------
  app.post('/api/auth/login', async (c) => {
    const now = deps.now();
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin && !(c.env.ALLOWED_ORIGINS ?? '').split(',').includes(origin)) {
      throw new AppError(403, 'FORBIDDEN', '허용되지 않은 Origin입니다.');
    }
    const key = await clientKey(c);
    if (!(await rateLimit(c.env.DB, `login:${key}`, 5, 15 * 60, now))) throw tooMany('로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.');
    const { password } = await parseJsonBody(c, loginSchema);
    let valid = await verifyPassword(password, c.env.ADMIN_PASSWORD_HASH);
    if (!c.env.ADMIN_PASSWORD_HASH) {
      // 샘플 모드 + 로컬 접속에서만 개발용 비밀번호 'demo'를 허용한다. 운영 모드에서는 비밀번호 설정이 필수.
      if (c.env.APP_MODE === 'demo' && isLocalRequest(c.req.url)) valid = password === 'demo';
      else throw new AppError(503, 'NOT_CONFIGURED', '관리자 비밀번호(ADMIN_PASSWORD_HASH)가 설정되지 않았습니다. docs/SETUP.md를 참고하세요.');
    }
    if (!valid) {
      await audit(c.env.DB, now, 'anonymous', 'auth.login_failed', 'session', null, {});
      throw new AppError(401, 'INVALID_CREDENTIALS', '비밀번호가 올바르지 않습니다.');
    }
    const session = await createSession(c.env.DB, now, key);
    setCookie(c, SESSION_COOKIE, session.token, cookieOptions(c.req.url, SESSION_TTL_HOURS * 3600));
    await audit(c.env.DB, now, 'admin', 'auth.login', 'session', null, {});
    return ok(c, { csrfToken: session.csrfToken, expiresAt: session.expiresAt, mode: c.env.APP_MODE });
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = await loadSession(c.env.DB, token, deps.now());
    if (session && c.req.header('x-csrf-token') !== session.csrfToken) throw new AppError(403, 'FORBIDDEN', 'CSRF 토큰이 올바르지 않습니다.');
    await destroySession(c.env.DB, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return ok(c, { loggedOut: true });
  });

  app.get('/api/auth/session', async (c) => {
    const session = await loadSession(c.env.DB, getCookie(c, SESSION_COOKIE), deps.now());
    return ok(c, {
      authenticated: Boolean(session),
      csrfToken: session?.csrfToken ?? null,
      expiresAt: session?.expiresAt ?? null,
      mode: c.env.APP_MODE,
      passwordConfigured: Boolean(c.env.ADMIN_PASSWORD_HASH) || (c.env.APP_MODE === 'demo' && isLocalRequest(c.req.url)),
    });
  });

  // ---------- GitHub Webhook ----------
  app.post('/api/webhooks/github', async (c) => {
    const now = deps.now();
    if (!(await rateLimit(c.env.DB, `ghwh:${await clientKey(c)}`, 300, 60, now))) throw tooMany();
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > 2_000_000) throw new AppError(413, 'TOO_LARGE', '본문이 너무 큽니다.');
    const outcome = await handleGithubWebhook(c.env, c.env.DB, deps, raw, c.req.raw.headers);
    return c.json({ ok: outcome.httpStatus === 200, data: { result: outcome.result } }, outcome.httpStatus);
  });

  // ---------- Heartbeat ----------
  const heartbeat = (type: HeartbeatType) => async (c: AppContext) => {
    const raw = await c.req.text();
    if (raw.length > 64_000) throw new AppError(413, 'TOO_LARGE', '본문이 너무 큽니다.');
    const result = await handleHeartbeat(c.env, c.env.DB, deps, type, raw, c.req.raw.headers, await clientKey(c));
    return c.json({ ok: true, data: { eventId: result.eventId, duplicate: result.duplicate } }, result.duplicate ? 200 : 202);
  };
  app.post('/api/v1/heartbeat/start', heartbeat('start'));
  app.post('/api/v1/heartbeat/complete', heartbeat('complete'));
  app.post('/api/v1/heartbeat/fail', heartbeat('fail'));
  app.post('/api/v1/events', heartbeat('event'));
  // 게시 이벤트는 heartbeat와 같은 서명 계약을 쓴다(본문에 publication 필드)
  app.post('/api/publications/events', heartbeat('event'));

  // ---------- 외부 스케줄러 트리거(GitHub Actions OIDC) ----------
  // Cloudflare Cron 한도(무료 계정 5개)가 다 찬 경우의 대체 경로. 비밀 값 없이 OIDC 서명으로만 인증한다.
  app.post('/api/v1/scheduler/tick', async (c) => {
    const now = deps.now();
    const repo = c.env.SCHEDULER_OIDC_REPOSITORY;
    if (!repo) throw new AppError(404, 'NOT_FOUND', '없는 API 경로입니다.');
    if (!(await rateLimit(c.env.DB, `tick:${await clientKey(c)}`, 6, 60, now))) throw tooMany();
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    try {
      await verifyGithubOidc(bearer, deps.fetch, now, { repository: repo, workflowFile: 'scheduler.yml' });
    } catch (err) {
      await audit(c.env.DB, now, 'anonymous', 'scheduler.tick_rejected', 'scheduler', null, { reason: err instanceof OidcError ? err.message : 'error' });
      throw new AppError(401, 'UNAUTHORIZED', '스케줄러 인증 실패');
    }
    const summary = await runScheduledTick(c.env, deps, now.getTime());
    return ok(c, summary);
  });

  // ---------- Maintenance callback (Routine → HQ) ----------
  app.post('/api/v1/maintenance/callback', async (c) => {
    const now = deps.now();
    if (!(await rateLimit(c.env.DB, `mcb:${await clientKey(c)}`, 30, 60, now))) throw tooMany();
    const body = await parseJsonBody(c, maintenanceCallbackSchema);
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
    const verdict = await handleMaintenanceCallback(c.env.DB, now, bearer, body);
    return ok(c, { status: verdict.status, flags: verdict.flags });
  });

  // ---------- Kakao OAuth callback ----------
  // 카카오에서 돌아오는 cross-site 이동이라 SameSite=Strict 세션 쿠키가 오지 않는다.
  // 대신 로그인한 관리자가 만든 1회용 state(쿠키 + DB 해시)로 요청을 묶는다.
  app.get('/api/integrations/kakao/callback', async (c) => {
    const now = deps.now();
    const state = c.req.query('state') ?? null;
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE) ?? null;
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/api/integrations/kakao' });
    const back = (q: string) => c.redirect(`/notifications?kakao=${q}`, 302);
    if (!(await consumeOAuthState(c.env.DB, state, cookieState, now))) {
      await audit(c.env.DB, now, 'anonymous', 'kakao.oauth_state_invalid', 'integration', 'kakao');
      return back('state_invalid');
    }
    const error = c.req.query('error');
    if (error) return back(error === 'access_denied' ? 'denied' : 'error');
    const code = c.req.query('code');
    if (!code) return back('error');
    try {
      await completeOAuth(c.env, c.env.DB, deps, code);
      await audit(c.env.DB, now, 'admin', 'kakao.connect', 'integration', 'kakao');
      return back('connected');
    } catch (err) {
      const reason = err instanceof KakaoReauthRequired ? err.code : err instanceof KakaoApiError ? err.code : 'error';
      await audit(c.env.DB, now, 'admin', 'kakao.connect_failed', 'integration', 'kakao', { reason });
      return back('error');
    }
  });

  return app;
}
