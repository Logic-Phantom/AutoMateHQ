import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env';
import { first, run, type Db } from '../lib/db';
import { forbidden, unauthorized } from '../lib/http';
import { randomToken, sha256Hex, timingSafeEqual } from './crypto';

export const SESSION_COOKIE = 'hq_session';
export const SESSION_TTL_HOURS = 12;

export interface SessionInfo {
  csrfToken: string;
  expiresAt: string;
}

export type AppVars = { session: SessionInfo | null; actor: string };
export type AppContext = Context<{ Bindings: Env; Variables: AppVars }>;

export function isLocalRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function cookieOptions(url: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // 로컬 http 개발 환경에서만 Secure를 끈다
    secure: !isLocalRequest(url) || new URL(url).protocol === 'https:',
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function createSession(db: Db, now: Date, ipHash: string | null) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000).toISOString();
  await run(
    db,
    `INSERT INTO admin_sessions (token_hash, csrf_token, created_at, expires_at, last_seen_at, ip_hash) VALUES (?,?,?,?,?,?)`,
    await sha256Hex(token),
    csrfToken,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
    ipHash,
  );
  return { token, csrfToken, expiresAt };
}

export async function loadSession(db: Db, token: string | undefined, now: Date): Promise<SessionInfo | null> {
  if (!token) return null;
  const row = await first<{ csrf_token: string; expires_at: string }>(
    db,
    `SELECT csrf_token, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?`,
    await sha256Hex(token),
    now.toISOString(),
  );
  return row ? { csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await run(db, `DELETE FROM admin_sessions WHERE token_hash = ?`, await sha256Hex(token));
}

/** 허용 Origin 목록: ALLOWED_ORIGINS 또는 PUBLIC_BASE_URL. 둘 다 없으면 요청 자신의 origin(same-origin)만. */
export function allowedOrigins(env: Env, requestUrl: string): string[] {
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.PUBLIC_BASE_URL) list.push(new URL(env.PUBLIC_BASE_URL).origin);
  list.push(new URL(requestUrl).origin);
  return [...new Set(list)];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 관리자 인증 + CSRF 미들웨어.
 * - 세션 쿠키(HttpOnly·Secure·SameSite=Strict) 필수
 * - 상태 변경 요청은 Origin 검사 + X-CSRF-Token(세션별) 일치 필수
 */
export function requireAdmin(nowFn: () => Date): MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> {
  return async (c, next) => {
    const session = await loadSession(c.env.DB, getCookie(c, SESSION_COOKIE), nowFn());
    if (!session) throw unauthorized();
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && !allowedOrigins(c.env, c.req.url).includes(origin)) throw forbidden('허용되지 않은 Origin입니다.');
      const csrf = c.req.header('x-csrf-token') ?? '';
      if (!timingSafeEqual(csrf, session.csrfToken)) throw forbidden('CSRF 토큰이 올바르지 않습니다.');
    }
    c.set('session', session);
    c.set('actor', 'admin');
    await next();
  };
}

export async function clientKey(c: AppContext): Promise<string> {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  return (await sha256Hex(`ip:${ip}`)).slice(0, 24);
}
