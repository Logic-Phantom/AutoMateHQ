import { beforeEach, describe, expect, it } from 'vitest';
import { resetJwksCache, SCHEDULER_AUDIENCE } from '../../worker/src/security/oidc';
import { createHarness, json, mockFetch } from '../helpers/harness';

const REPO = 'Logic-Phantom/AutoMateHQ';
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function keypair() {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { kp, jwk: { kid: 'k1', kty: 'RSA', n: jwk.n!, e: jwk.e!, alg: 'RS256' } };
}

async function sign(kp: CryptoKeyPair, claims: Record<string, unknown>, kid = 'k1') {
  const h = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const p = enc(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

describe('GitHub Actions OIDC 스케줄러 트리거', () => {
  beforeEach(() => resetJwksCache());

  async function setup() {
    const { kp, jwk } = await keypair();
    const f = mockFetch((call) => (call.url.endsWith('/.well-known/jwks') ? json({ keys: [jwk] }) : json({}, 404)));
    const h = await createHarness({ fetch: f.fn, env: { SCHEDULER_OIDC_REPOSITORY: REPO } });
    const nowSec = Math.floor(h.clock.now.getTime() / 1000);
    const claims = {
      iss: 'https://token.actions.githubusercontent.com',
      aud: SCHEDULER_AUDIENCE,
      exp: nowSec + 300,
      iat: nowSec,
      repository: REPO,
      ref: 'refs/heads/main',
      event_name: 'schedule',
      workflow_ref: `${REPO}/.github/workflows/scheduler.yml@refs/heads/main`,
    };
    const call = (token: string) =>
      h.app.request('https://hq.example.test/api/v1/scheduler/tick', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, h.env);
    return { h, kp, claims, call };
  }

  it('올바른 저장소·브랜치·워크플로의 OIDC 토큰이면 스케줄러를 실행한다', async () => {
    const { kp, claims, call } = await setup();
    const res = await call(await sign(kp, claims));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toHaveProperty('evaluate');
  });

  it('다른 저장소·브랜치·워크플로·대상·만료 토큰은 거부한다', async () => {
    const { kp, claims, call, h } = await setup();
    const bad = [
      { ...claims, repository: 'evil/AutoMateHQ' },
      { ...claims, ref: 'refs/heads/feature' },
      { ...claims, workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main` },
      { ...claims, aud: 'something-else' },
      { ...claims, event_name: 'pull_request' },
      { ...claims, exp: Math.floor(h.clock.now.getTime() / 1000) - 3600 },
    ];
    for (const c of bad) expect((await call(await sign(kp, c))).status).toBe(401);
  });

  it('다른 키로 서명한 토큰과 형식이 틀린 토큰은 거부한다', async () => {
    const { claims, call } = await setup();
    const other = await keypair();
    expect((await call(await sign(other.kp, claims))).status).toBe(401);
    expect((await call('not-a-jwt')).status).toBe(401);
  });

  it('저장소 설정이 없으면 엔드포인트가 비활성(404)이다', async () => {
    const h = await createHarness();
    const res = await h.app.request('https://hq.example.test/api/v1/scheduler/tick', { method: 'POST' }, h.env);
    expect(res.status).toBe(404);
  });
});
