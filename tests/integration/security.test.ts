import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../../worker/src/security/crypto';
import { redact, safeMetadata } from '../../worker/src/security/redact';
import { body, createHarness, TEST_PASSWORD } from '../helpers/harness';

describe('인증/세션', () => {
  it('미인증 API 요청을 차단한다', async () => {
    const h = await createHarness();
    for (const path of ['/api/overview', '/api/projects', '/api/runs', '/api/integrations/kakao/status', '/api/settings/system']) {
      expect((await h.request('GET', path)).status).toBe(401);
    }
  });

  it('잘못된 비밀번호는 거부하고 로그인 시도 횟수를 제한한다', async () => {
    const h = await createHarness();
    for (let i = 0; i < 5; i++) expect((await h.request('POST', '/api/auth/login', { password: 'wrong' })).status).toBe(401);
    expect((await h.request('POST', '/api/auth/login', { password: TEST_PASSWORD })).status).toBe(429);
  });

  it('세션 쿠키는 HttpOnly·Secure·SameSite=Strict', async () => {
    const h = await createHarness();
    const res = await h.login();
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('CSRF 토큰이 없거나 틀리면 상태 변경 요청을 거부한다', async () => {
    const h = await createHarness();
    await h.login();
    h.setCsrf('forged');
    expect((await h.request('POST', '/api/projects', { projectKey: 'abc', name: 'x', monitoringMode: 'manual' })).status).toBe(403);
  });

  it('다른 Origin에서 온 상태 변경 요청을 거부한다', async () => {
    const h = await createHarness();
    await h.login();
    const res = await h.request('POST', '/api/projects', { projectKey: 'abc', name: 'x', monitoringMode: 'manual' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('보안 헤더를 붙인다', async () => {
    const h = await createHarness();
    const res = await h.request('GET', '/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('비밀번호가 설정되지 않은 운영 모드는 로그인할 수 없다', async () => {
    const h = await createHarness({ env: { ADMIN_PASSWORD_HASH: undefined } });
    expect((await h.request('POST', '/api/auth/login', { password: 'demo' })).status).toBe(503);
  });
});

describe('입력 검증·감사 로그', () => {
  it('schema에 맞지 않는 입력은 400과 필드 오류를 돌려준다', async () => {
    const h = await createHarness();
    await h.login();
    const res = await h.request('POST', '/api/projects', { projectKey: 'Bad Key!', name: '' });
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error.details.length).toBeGreaterThan(0);
  });

  it('프로젝트 생성·수정·삭제는 감사 로그에 남고 삭제는 soft delete', async () => {
    const h = await createHarness();
    await h.login();
    const created = await body(await h.request('POST', '/api/projects', { projectKey: 'audit-me', name: '감사', monitoringMode: 'manual', expectedCadence: 'irregular', expectedTimeLocal: null }));
    const id = created.data.id;
    await h.request('PATCH', `/api/projects/${id}`, { name: '감사2' });
    expect(h.db.get<{ name: string; expected_cadence: string }>(`SELECT name, expected_cadence FROM projects WHERE id=${id}`)).toEqual({ name: '감사2', expected_cadence: 'irregular' });
    await h.request('DELETE', `/api/projects/${id}`);
    expect(h.db.count('projects', 'deleted_at IS NOT NULL')).toBe(1);
    expect(h.db.count('audit_logs', `action IN ('project.create','project.update','project.soft_delete')`)).toBe(3);
  });

  it('GitHub 토큰은 프런트엔드 응답에 나가지 않는다', async () => {
    const token = 'github_pat_' + 'Z'.repeat(50);
    const { mockFetch, json } = await import('../helpers/harness');
    const gh = mockFetch((c) => (c.url.endsWith('/user') ? json({ login: 'me' }) : json({ resources: { core: { limit: 5000, remaining: 5000, reset: 0 } } })));
    const h = await createHarness({ fetch: gh.fn });
    await h.login();
    await h.request('PUT', '/api/integrations/github', { token });
    for (const p of ['/api/integrations/github/status', '/api/overview', '/api/settings/system', '/api/audit-logs']) {
      expect(await (await h.request('GET', p)).text()).not.toContain(token);
    }
    expect(JSON.stringify(h.db.raw.prepare('SELECT * FROM integrations').all())).not.toContain(token);
  });
});

describe('암호화·마스킹 유틸리티', () => {
  it('AES-GCM 왕복 및 이전 키로 복호화(키 교체)', async () => {
    const k1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const k2 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const enc = await encryptSecret({ current: k1 }, 'secret-value');
    expect(await decryptSecret({ current: k2, previous: k1 }, enc)).toBe('secret-value');
    await expect(decryptSecret({ current: k2 }, enc)).rejects.toThrow();
  });

  it('PBKDF2 비밀번호 검증', async () => {
    const h = await hashPassword('pw-1234');
    expect(await verifyPassword('pw-1234', h)).toBe(true);
    expect(await verifyPassword('pw-12345', h)).toBe(false);
  });

  it('토큰 패턴을 마스킹한다', () => {
    const s = redact('Authorization: Bearer abcdefghijklmnop refresh_token=xyz123 ghp_' + 'a'.repeat(36) + ' sk-ant-oat01-' + 'b'.repeat(20));
    expect(s).not.toContain('abcdefghijklmnop');
    expect(s).not.toContain('xyz123');
    expect(s).not.toContain('ghp_aaaa');
    expect(s).not.toContain('sk-ant-oat01-bbbb');
    expect(safeMetadata({ token: 'x', note: 'ok' })).toEqual({ note: 'ok' });
  });
});
