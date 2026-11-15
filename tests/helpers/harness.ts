import { createApp } from '../../worker/src/app';
import type { AppDeps, Env, FetchFn } from '../../worker/src/env';
import { bytesToBase64, hashPassword } from '../../worker/src/security/crypto';
import { TestD1 } from './d1';

export const TEST_PASSWORD = 'correct horse battery staple';
export const BASE = 'https://hq.example.test';

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** 외부 HTTP 호출을 가로채는 fetch. 처리기가 없으면 실패시켜 의도치 않은 외부 호출을 막는다. */
export function mockFetch(handler: (call: MockCall) => Response | Promise<Response>) {
  const calls: MockCall[] = [];
  const fn: FetchFn = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url: input, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    return handler(call);
  };
  return { fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let cachedHash: string | null = null;

export async function createHarness(opts: { now?: Date; fetch?: FetchFn; env?: Partial<Env> } = {}) {
  const db = new TestD1();
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  const clock = { now: opts.now ?? new Date('2026-11-16T00:00:00Z') };
  const env: Env = {
    DB: db,
    APP_MODE: 'live',
    APP_TIMEZONE: 'Asia/Seoul',
    PUBLIC_BASE_URL: BASE,
    ALLOWED_ORIGINS: '',
    ADMIN_PASSWORD_HASH: cachedHash,
    HQ_ENCRYPTION_KEY: bytesToBase64(key),
    GITHUB_WEBHOOK_SECRET: 'gh-webhook-test-secret',
    KAKAO_REST_API_KEY: 'test-rest-key',
    KAKAO_CLIENT_SECRET: 'test-client-secret',
    ...opts.env,
  };
  const fetchMock = mockFetch(() => {
    throw new Error('예상하지 못한 외부 호출');
  });
  const deps: AppDeps = { fetch: opts.fetch ?? fetchMock.fn, now: () => clock.now };
  const app = createApp(deps);

  let cookie = '';
  let csrf = '';
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      },
      env,
    );
    return res;
  };
  const login = async () => {
    const res = await request('POST', '/api/auth/login', { password: TEST_PASSWORD });
    const setCookie = res.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0] ?? '';
    const data = (await res.json()) as { data: { csrfToken: string } };
    csrf = data.data.csrfToken;
    return res;
  };
  return { db, env, deps, app, clock, request, login, setCsrf: (v: string) => (csrf = v) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 테스트에서 응답 본문을 자유롭게 검사한다
export async function body<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
