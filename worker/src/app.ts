import { Hono } from 'hono';
import { ZodError } from 'zod';
import { defaultDeps, type AppDeps, type Env } from './env';
import { AppError, errorBody } from './lib/http';
import { CryptoConfigError } from './security/crypto';
import { redact } from './security/redact';
import type { AppVars } from './security/session';
import { adminRoutes } from './routes/admin';
import { publicRoutes } from './routes/public';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

export function createApp(deps: AppDeps = defaultDeps) {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(k) || k === 'Cache-Control') c.res.headers.set(k, v);
    }
  });

  // CORS: 같은 origin만 쓰므로 교차 출처 사전 요청은 허용 목록에 있을 때만 응답한다.
  app.options('/api/*', (c) => c.body(null, 204));

  app.route('/', publicRoutes(deps));
  app.route('/', adminRoutes(deps));

  app.notFound((c) => c.json({ ok: false, error: { code: 'NOT_FOUND', message: '없는 API 경로입니다.' } }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err), err.status as 400);
    if (err instanceof ZodError) {
      return c.json(
        errorBody(new AppError(400, 'BAD_REQUEST', '입력값이 올바르지 않습니다.', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))),
        400,
      );
    }
    if (err instanceof CryptoConfigError) {
      console.error('crypto_config_error', redact(err.message));
      return c.json(errorBody(new AppError(503, 'CRYPTO_CONFIG', err.message)), 503);
    }
    // 내부 오류 상세(스택·비밀 값 가능성)는 응답에 싣지 않는다
    console.error('unhandled_error', redact(err?.message ?? String(err)));
    return c.json(errorBody(new AppError(500, 'INTERNAL', '서버 오류가 발생했습니다.')), 500);
  });

  return app;
}
