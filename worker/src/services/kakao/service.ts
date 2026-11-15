import type { AppDeps, Env } from '../../env';
import { all, run, type Db } from '../../lib/db';
import { acquireLock, releaseLock } from '../../repositories/common';
import { getIntegration, readCredentials, upsertSingletonIntegration } from '../../repositories/integrations';
import { randomToken, sha256Hex } from '../../security/crypto';
import { redact } from '../../security/redact';
import { raiseIncident, resolveByFingerprint } from '../incidents/engine';
import { KakaoApiError, KakaoClient, KakaoReauthRequired, type KakaoAppConfig, type KakaoTokenResponse } from './client';

export interface KakaoTokens {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string | null;
}

export const KAKAO_CALLBACK_PATH = '/api/integrations/kakao/callback';

export function kakaoAppConfig(env: Env): KakaoAppConfig | null {
  // secret 등록 시 붙은 공백·개행(\r\n)이 있으면 카카오가 KOE101로 거부하므로 정리한다.
  const restApiKey = env.KAKAO_REST_API_KEY?.trim();
  if (!restApiKey || !env.PUBLIC_BASE_URL) return null;
  return {
    restApiKey,
    clientSecret: env.KAKAO_CLIENT_SECRET?.trim() || undefined,
    redirectUri: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${KAKAO_CALLBACK_PATH}`,
  };
}

/** 토큰 응답 → 저장 형태. 새 refresh token이 응답에 있을 때만 교체한다. */
export function mergeTokenResponse(prev: KakaoTokens | null, body: KakaoTokenResponse, now: Date): KakaoTokens {
  const refreshToken = body.refresh_token ?? prev?.refreshToken;
  if (!refreshToken) throw new KakaoReauthRequired('NO_REFRESH_TOKEN');
  return {
    accessToken: body.access_token,
    // 만료 5분 전을 만료로 간주해 미리 갱신한다
    accessExpiresAt: new Date(now.getTime() + Math.max(0, body.expires_in - 300) * 1000).toISOString(),
    refreshToken,
    refreshExpiresAt: body.refresh_token
      ? body.refresh_token_expires_in
        ? new Date(now.getTime() + body.refresh_token_expires_in * 1000).toISOString()
        : null
      : (prev?.refreshExpiresAt ?? null),
  };
}

// ---------------- OAuth ----------------
export async function createOAuthState(db: Db, now: Date): Promise<string> {
  const state = randomToken(24);
  await run(
    db,
    `INSERT INTO oauth_states (state_hash, provider, created_at, expires_at) VALUES (?, 'kakao', ?, ?)`,
    await sha256Hex(state),
    now.toISOString(),
    new Date(now.getTime() + 10 * 60_000).toISOString(),
  );
  return state;
}

/** state는 1회용. 쿠키 값과 DB 해시가 모두 맞아야 한다. */
export async function consumeOAuthState(db: Db, state: string | null, cookieState: string | null, now: Date): Promise<boolean> {
  if (!state || !cookieState || state !== cookieState) return false;
  const res = await run(
    db,
    `DELETE FROM oauth_states WHERE state_hash = ? AND provider = 'kakao' AND expires_at > ?`,
    await sha256Hex(state),
    now.toISOString(),
  );
  return res.meta.changes === 1;
}

export async function completeOAuth(env: Env, db: Db, deps: AppDeps, code: string): Promise<void> {
  const cfg = kakaoAppConfig(env);
  if (!cfg) throw new KakaoApiError(null, 'NOT_CONFIGURED');
  const now = deps.now();
  const client = new KakaoClient(cfg, deps.fetch);
  const body = await client.exchangeCode(code);
  if (!body.scope?.split(/[ ,]/).includes('talk_message')) {
    await upsertSingletonIntegration(
      env,
      db,
      'kakao',
      {
        displayName: '카카오톡 나에게 보내기',
        status: 'error',
        credentials: null,
        errorCode: 'SCOPE_MISSING',
        errorMessage: 'talk_message 동의가 없습니다. 동의 항목 설정을 확인하고 다시 연결하세요.',
      },
      now,
    );
    return;
  }
  const tokens = mergeTokenResponse(null, body, now);
  await upsertSingletonIntegration(
    env,
    db,
    'kakao',
    {
      displayName: '카카오톡 나에게 보내기',
      status: 'connected',
      credentials: tokens,
      metadata: { connectedAt: now.toISOString(), refreshExpiresAt: tokens.refreshExpiresAt, lastRefreshAt: now.toISOString() },
      verifiedAt: now.toISOString(),
      errorCode: null,
      errorMessage: null,
    },
    now,
  );
  await resolveByFingerprint(db, 'integration:kakao:REAUTH', now);
}

// ---------------- 발송 ----------------
export type DeliveryStatus = 'SENT' | 'PARTIAL' | 'FAILED' | 'REAUTH_REQUIRED' | 'NOT_CONFIGURED' | 'DEMO_SKIPPED';
export interface DeliveryResult {
  status: DeliveryStatus;
  sent: number;
  detail: string;
  responseCode: string | null;
}

/**
 * 유효한 access token을 돌려준다. 만료됐거나 force면 refresh 한다.
 * 갱신 중복을 막기 위해 lease 잠금을 쓴다.
 */
export async function getAccessToken(env: Env, db: Db, deps: AppDeps, force = false): Promise<string> {
  const cfg = kakaoAppConfig(env);
  const row = await getIntegration(db, 'kakao');
  if (!cfg || !row) throw new KakaoApiError(null, 'NOT_CONFIGURED');
  if (row.status === 'reauth_required') throw new KakaoReauthRequired('REAUTH_PENDING');
  const tokens = await readCredentials<KakaoTokens>(env, row);
  if (!tokens) throw new KakaoApiError(null, 'NOT_CONFIGURED');
  const now = deps.now();
  if (!force && new Date(tokens.accessExpiresAt).getTime() > now.getTime()) return tokens.accessToken;

  const holder = randomToken(8);
  if (!(await acquireLock(db, 'kakao-token-refresh', holder, now, 60))) throw new KakaoApiError(null, 'REFRESH_IN_PROGRESS');
  try {
    const client = new KakaoClient(cfg, deps.fetch);
    let body: KakaoTokenResponse;
    try {
      body = await client.refresh(tokens.refreshToken);
    } catch (err) {
      if (err instanceof KakaoReauthRequired) await markReauth(env, db, err.code, now);
      throw err;
    }
    const merged = mergeTokenResponse(tokens, body, now);
    await upsertSingletonIntegration(
      env,
      db,
      'kakao',
      {
        displayName: row.display_name,
        status: 'connected',
        credentials: merged,
        metadata: {
          ...JSON.parse(row.metadata_json || '{}'),
          lastRefreshAt: now.toISOString(),
          refreshExpiresAt: merged.refreshExpiresAt,
          refreshRotatedAt: body.refresh_token ? now.toISOString() : (JSON.parse(row.metadata_json || '{}').refreshRotatedAt ?? null),
        },
        verifiedAt: now.toISOString(),
        errorCode: null,
        errorMessage: null,
      },
      now,
    );
    return merged.accessToken;
  } finally {
    await releaseLock(db, 'kakao-token-refresh', holder);
  }
}

async function markReauth(env: Env, db: Db, code: string, now: Date) {
  await upsertSingletonIntegration(
    env,
    db,
    'kakao',
    {
      displayName: '카카오톡 나에게 보내기',
      status: 'reauth_required',
      errorCode: code,
      errorMessage: '리프레시 토큰이 만료되었거나 동의가 철회되었습니다. 알림 설정에서 카카오를 다시 연결하세요.',
    },
    now,
  );
  await raiseIncident(
    db,
    {
      projectId: null,
      fingerprint: 'integration:kakao:REAUTH',
      severity: 'high',
      category: 'INTEGRATION_AUTH',
      title: '카카오 재연결 필요 — 07:00 보고서를 보낼 수 없습니다',
      description: `오류 코드: ${code}`,
    },
    now,
  );
}

export async function sendKakaoMessages(env: Env, db: Db, deps: AppDeps, messages: string[], linkUrl: string): Promise<DeliveryResult> {
  if (env.APP_MODE === 'demo') {
    return { status: 'DEMO_SKIPPED', sent: 0, detail: '샘플 모드에서는 카카오로 보내지 않습니다.', responseCode: null };
  }
  const cfg = kakaoAppConfig(env);
  if (!cfg) return { status: 'NOT_CONFIGURED', sent: 0, detail: 'KAKAO_REST_API_KEY 또는 PUBLIC_BASE_URL 미설정', responseCode: null };
  const client = new KakaoClient(cfg, deps.fetch);
  let access: string;
  try {
    access = await getAccessToken(env, db, deps);
  } catch (err) {
    return deliveryError(err, 0);
  }
  let sent = 0;
  let refreshed = false;
  for (const text of messages) {
    let res = await client.sendMemo(access, text, linkUrl);
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      try {
        access = await getAccessToken(env, db, deps, true);
      } catch (err) {
        return deliveryError(err, sent);
      }
      res = await client.sendMemo(access, text, linkUrl);
    }
    if (res.status !== 200 || res.code !== '0') {
      if (res.status === 403) {
        // talk_message 동의 철회 등
        await markReauth(env, db, `SEND_${res.code}`, deps.now());
        return { status: 'REAUTH_REQUIRED', sent, detail: `발송 권한 없음(HTTP 403 ${res.code})`, responseCode: `${res.status}:${res.code}` };
      }
      return {
        status: sent ? 'PARTIAL' : 'FAILED',
        sent,
        detail: `발송 실패: HTTP ${res.status} ${res.code}`,
        responseCode: `${res.status}:${res.code}`,
      };
    }
    sent++;
  }
  return { status: 'SENT', sent, detail: '', responseCode: '200:0' };
}

function deliveryError(err: unknown, sent: number): DeliveryResult {
  if (err instanceof KakaoReauthRequired) return { status: 'REAUTH_REQUIRED', sent, detail: err.message, responseCode: err.code };
  if (err instanceof KakaoApiError) {
    if (err.code === 'NOT_CONFIGURED') return { status: 'NOT_CONFIGURED', sent, detail: '카카오가 연결되지 않았습니다.', responseCode: null };
    return { status: sent ? 'PARTIAL' : 'FAILED', sent, detail: err.message, responseCode: err.code };
  }
  return { status: sent ? 'PARTIAL' : 'FAILED', sent, detail: redact(String((err as Error)?.message ?? err)), responseCode: null };
}

export async function recordNotification(
  db: Db,
  now: Date,
  input: { type: string; dedupeKey: string | null; result: DeliveryResult; summary: string },
) {
  await run(
    db,
    `INSERT INTO notification_deliveries (channel, notification_type, dedupe_key, status, payload_summary, sent_at,
       provider_response_code, safe_error_message, created_at) VALUES ('kakao',?,?,?,?,?,?,?,?)`,
    input.type,
    input.dedupeKey,
    input.result.status === 'SENT' ? 'sent' : input.result.status === 'DEMO_SKIPPED' ? 'skipped' : 'failed',
    input.summary.slice(0, 200),
    input.result.status === 'SENT' || input.result.status === 'PARTIAL' ? now.toISOString() : null,
    input.result.responseCode,
    input.result.detail ? redact(input.result.detail, 200) : null,
    now.toISOString(),
  );
}

export async function kakaoStatus(env: Env, db: Db) {
  const row = await getIntegration(db, 'kakao');
  const last = await all<{ notification_type: string; status: string; sent_at: string | null; created_at: string; safe_error_message: string | null }>(
    db,
    `SELECT notification_type, status, sent_at, created_at, safe_error_message FROM notification_deliveries
     WHERE channel='kakao' ORDER BY id DESC LIMIT 1`,
  );
  const meta = row ? (JSON.parse(row.metadata_json || '{}') as Record<string, string | null>) : {};
  return {
    configured: Boolean(kakaoAppConfig(env)),
    clientSecretConfigured: Boolean(env.KAKAO_CLIENT_SECRET),
    redirectUri: kakaoAppConfig(env)?.redirectUri ?? null,
    status: row?.status ?? 'not_connected',
    lastVerifiedAt: row?.last_verified_at ?? null,
    lastRefreshAt: meta.lastRefreshAt ?? null,
    refreshExpiresAt: meta.refreshExpiresAt ?? null,
    lastErrorCode: row?.last_error_code ?? null,
    lastErrorMessage: row?.last_error_message_safe ?? null,
    lastDelivery: last[0] ?? null,
  };
}

export async function disconnectKakao(env: Env, db: Db, deps: AppDeps, revokeRemote: boolean): Promise<{ remoteRevoked: boolean }> {
  const now = deps.now();
  let remoteRevoked = false;
  if (revokeRemote && env.APP_MODE !== 'demo') {
    const cfg = kakaoAppConfig(env);
    const row = await getIntegration(db, 'kakao');
    const tokens = row ? await readCredentials<KakaoTokens>(env, row).catch(() => null) : null;
    if (cfg && tokens) remoteRevoked = await new KakaoClient(cfg, deps.fetch).logout(tokens.accessToken);
  }
  await upsertSingletonIntegration(
    env,
    db,
    'kakao',
    { displayName: '카카오톡 나에게 보내기', status: 'not_connected', credentials: null, errorCode: null, errorMessage: null, metadata: {} },
    now,
  );
  return { remoteRevoked };
}
