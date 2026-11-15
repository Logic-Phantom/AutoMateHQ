import type { FetchFn } from '../env';
import { base64ToBytes } from './crypto';

/**
 * GitHub Actions OIDC 토큰 검증(RS256).
 * Cloudflare 무료 계정의 Cron 5개 한도를 다른 Worker가 이미 쓰고 있을 때,
 * GitHub Actions 예약 워크플로가 HQ 스케줄러를 깨우는 용도로 쓴다. 공유 비밀 값이 필요 없다.
 * 문서: https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
 */
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
export const SCHEDULER_AUDIENCE = 'automatehq-scheduler';

export interface OidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  repository: string;
  ref: string;
  event_name: string;
  job_workflow_ref?: string;
  workflow_ref?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let jwksCache: { at: number; keys: Jwk[] } | null = null;

export function resetJwksCache() {
  jwksCache = null;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(b64);
}

async function getKeys(fetchFn: FetchFn, now: number, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && now - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetchFn(GITHUB_OIDC_JWKS, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS 조회 실패(${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: now, keys: body.keys ?? [] };
  return jwksCache.keys;
}

export class OidcError extends Error {}

/** 서명·발급자·대상·만료·저장소·브랜치·이벤트·워크플로 파일을 모두 확인한다. */
export async function verifyGithubOidc(
  token: string,
  fetchFn: FetchFn,
  now: Date,
  expected: { repository: string; workflowFile: string; ref?: string; events?: string[] },
): Promise<OidcClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('토큰 형식 오류');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: OidcClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    throw new OidcError('토큰 해석 실패');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new OidcError('지원하지 않는 서명 방식');

  let keys = await getKeys(fetchFn, now.getTime());
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(fetchFn, now.getTime(), true); // 키 회전 대응
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA') throw new OidcError('서명 키를 찾을 수 없음');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new OidcError('서명 불일치');

  const nowSec = Math.floor(now.getTime() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== GITHUB_OIDC_ISSUER) throw new OidcError('발급자 불일치');
  if (!aud.includes(SCHEDULER_AUDIENCE)) throw new OidcError('대상(audience) 불일치');
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - 30) throw new OidcError('만료된 토큰');
  if (claims.nbf && claims.nbf > nowSec + 60) throw new OidcError('아직 유효하지 않은 토큰');
  if (claims.repository !== expected.repository) throw new OidcError('저장소 불일치');
  const ref = expected.ref ?? 'refs/heads/main';
  if (claims.ref !== ref) throw new OidcError('브랜치 불일치');
  if (!(expected.events ?? ['schedule', 'workflow_dispatch']).includes(claims.event_name)) throw new OidcError('허용되지 않은 이벤트');
  const wf = claims.workflow_ref ?? claims.job_workflow_ref ?? '';
  if (wf !== `${expected.repository}/.github/workflows/${expected.workflowFile}@${ref}`) throw new OidcError('워크플로 불일치');
  return claims;
}
