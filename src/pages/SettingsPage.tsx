import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INTEGRATION_STATUS_LABEL } from '@shared/constants';
import { del, errorMessage, get, post, put } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { IntegrationDto } from '@/types/api';
import { Badge, Button, ErrorBox, Field, inputCls, integrationTone, Loading, Modal, Notice, PageHeader, Panel, type Tone } from '@/components/ui';

interface SystemDto {
  mode: string;
  timezone: string;
  publicBaseUrl: string | null;
  secrets: Record<string, boolean>;
  cron: { expression: string; note: string };
  onboarding: { key: string; label: string; state: '완료' | '필요' | '선택'; detail?: string }[];
}

interface GithubStatus {
  integration: IntegrationDto | null;
  webhookSecretConfigured: boolean;
  webhookUrl: string | null;
  recentDeliveries: { delivery_id: string; event_type: string; processing_status: string; received_at: string; safe_error_message: string | null }[];
}

const STEP_TONE: Record<string, Tone> = { 완료: 'ok', 필요: 'warn', 선택: 'neutral' };
const SECRET_LABEL: Record<string, string> = {
  adminPassword: 'ADMIN_PASSWORD_HASH',
  encryptionKey: 'HQ_ENCRYPTION_KEY',
  encryptionKeyPrevious: 'HQ_ENCRYPTION_KEY_PREVIOUS(교체 중에만)',
  githubWebhookSecret: 'GITHUB_WEBHOOK_SECRET',
  kakaoRestApiKey: 'KAKAO_REST_API_KEY',
  kakaoClientSecret: 'KAKAO_CLIENT_SECRET',
};

export function SettingsPage() {
  const qc = useQueryClient();
  const system = useQuery({ queryKey: ['system'], queryFn: () => get<SystemDto>('/api/settings/system') });
  const github = useQuery({ queryKey: ['github'], queryFn: () => get<GithubStatus>('/api/integrations/github/status') });
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => get<IntegrationDto[]>('/api/integrations/claude') });
  const [token, setToken] = useState('');
  const [routineOpen, setRoutineOpen] = useState(false);
  const refresh = () => ['system', 'github', 'routines', 'overview'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

  const saveGithub = useMutation({
    mutationFn: () => put<{ login: string }>('/api/integrations/github', { token: token.trim() }),
    onSuccess: () => {
      setToken('');
      refresh();
    },
  });
  const testGithub = useMutation({ mutationFn: () => post<{ ok: boolean; login?: string; message?: string; rateLimit?: { remaining: number; limit: number } }>('/api/integrations/github/test'), onSuccess: refresh });
  const removeGithub = useMutation({ mutationFn: () => del('/api/integrations/github'), onSuccess: refresh });
  const addRoutine = useMutation({
    mutationFn: (v: Record<string, string>) => post('/api/integrations/claude', v),
    onSuccess: () => {
      setRoutineOpen(false);
      refresh();
    },
  });
  const removeRoutine = useMutation({ mutationFn: (id: number) => del(`/api/integrations/claude/${id}`), onSuccess: refresh });

  const gh = github.data?.integration;

  return (
    <>
      <PageHeader
        title="연동 설정"
        description="실제 외부 연결이 확인되지 않은 항목은 완료로 표시하지 않습니다."
        actions={<a href="/api/settings/export" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-neutral-soft">설정 내보내기(JSON)</a>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="온보딩 체크리스트">
          {system.isLoading ? (
            <Loading />
          ) : system.error ? (
            <ErrorBox message={errorMessage(system.error)} />
          ) : (
            <ol className="space-y-1.5 text-sm">
              {system.data!.onboarding.map((s, i) => (
                <li key={s.key} className="flex items-center justify-between gap-2">
                  <span><span className="tabular mr-1.5 text-ink-mute">{i + 1}.</span>{s.label}{s.detail && <span className="ml-1 text-xs text-ink-mute">({s.detail})</span>}</span>
                  <Badge tone={STEP_TONE[s.state]}>{s.state}</Badge>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="시스템 · Cloudflare Worker">
          {system.data && (
            <div className="space-y-3 text-sm">
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-ink-soft">
                <dt>모드</dt><dd>{system.data.mode === 'demo' ? '샘플(데모)' : '운영'}</dd>
                <dt>시간대</dt><dd>{system.data.timezone}</dd>
                <dt>서비스 주소</dt><dd className="break-all">{system.data.publicBaseUrl ?? '미설정'}</dd>
                <dt>Cron</dt><dd><code>{system.data.cron.expression}</code> (UTC)</dd>
              </dl>
              <p className="text-xs text-ink-mute">{system.data.cron.note}</p>
              <ul className="space-y-1">
                {Object.entries(system.data.secrets).map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between">
                    <code className="text-xs">{SECRET_LABEL[k] ?? k}</code>
                    <Badge tone={v ? 'ok' : k === 'encryptionKeyPrevious' ? 'neutral' : 'warn'}>{v ? '설정됨' : '미설정'}</Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-mute">비밀 값은 <code>wrangler secret put</code>으로만 설정합니다(docs/DEPLOYMENT.md).</p>
            </div>
          )}
        </Panel>

        <Panel title="GitHub (Fine-grained PAT)">
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={integrationTone(gh?.status)}>{INTEGRATION_STATUS_LABEL[(gh?.status ?? 'not_connected') as keyof typeof INTEGRATION_STATUS_LABEL]}</Badge>
              {gh?.metadata.login ? <span className="text-ink-soft">@{String(gh.metadata.login)} · {String(gh.metadata.tokenType ?? '')} · {String(gh.metadata.tokenHint ?? '')}</span> : null}
              {gh?.lastVerifiedAt && <span className="text-xs text-ink-mute">확인 {fmtDateTime(gh.lastVerifiedAt)}</span>}
            </div>
            {gh?.lastErrorMessage && <Notice tone="fail">{gh.lastErrorMessage}</Notice>}
            <form
              className="flex gap-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                saveGithub.mutate();
              }}
            >
              <input type="password" autoComplete="off" aria-label="GitHub 토큰" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} className={inputCls} />
              <Button type="submit" variant="primary" loading={saveGithub.isPending} disabled={!token}>저장</Button>
            </form>
            <p className="text-xs text-ink-mute">토큰은 서버에서 AES-GCM으로 암호화해 저장하며 다시 표시하지 않습니다. 조회 전용 권한: Metadata·Actions·Contents read. 재실행에는 Actions write가 필요합니다.</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => testGithub.mutate()} loading={testGithub.isPending} disabled={!gh || gh.status === 'not_connected'}>연결 테스트</Button>
              {gh && gh.status !== 'not_connected' && <Button variant="ghost" onClick={() => removeGithub.mutate()}>연결 해제</Button>}
            </div>
            {testGithub.data && <Notice tone={testGithub.data.ok ? 'ok' : 'fail'}>{testGithub.data.ok ? `정상 · @${testGithub.data.login} · 남은 호출 ${testGithub.data.rateLimit?.remaining}/${testGithub.data.rateLimit?.limit}` : testGithub.data.message}</Notice>}
            {(saveGithub.error || testGithub.error) && <ErrorBox message={errorMessage(saveGithub.error ?? testGithub.error)} />}
            <div className="rounded-md bg-neutral-soft p-3 text-xs">
              <p className="font-medium">Webhook</p>
              <p className="break-all text-ink-soft">URL: {github.data?.webhookUrl ?? 'PUBLIC_BASE_URL 설정 후 표시'} · 이벤트: Workflow runs · Content type: application/json</p>
              <p className="text-ink-soft">Secret: {github.data?.webhookSecretConfigured ? '설정됨' : '미설정 — 10분 polling으로만 동작'}</p>
              {github.data?.recentDeliveries.length ? (
                <ul className="mt-1 space-y-0.5">
                  {github.data.recentDeliveries.slice(0, 5).map((d) => (
                    <li key={d.delivery_id} className="tabular">{fmtDateTime(d.received_at)} · {d.event_type} · {d.processing_status}{d.safe_error_message ? ` · ${d.safe_error_message}` : ''}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </Panel>

        <Panel title="Claude Code Routines" actions={<Button onClick={() => setRoutineOpen(true)}>Routine 추가</Button>}>
          <div className="space-y-3 text-sm">
            {routines.data?.length ? (
              <ul className="divide-y divide-line">
                {routines.data.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <p className="font-medium">{r.displayName} <Badge>{String(r.metadata.purpose)}</Badge></p>
                      <p className="text-xs text-ink-mute">{String(r.metadata.routineId ?? '')} · {String(r.metadata.tokenHint ?? '')}{r.lastErrorMessage ? ` · ${r.lastErrorMessage}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={integrationTone(r.status)}>{INTEGRATION_STATUS_LABEL[r.status as keyof typeof INTEGRATION_STATUS_LABEL] ?? r.status}</Badge>
                      <Button variant="ghost" onClick={() => removeRoutine.mutate(r.id)}>삭제</Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Notice tone="warn">Claude Code 연결 필요 — Routine을 등록하지 않으면 규칙 기반 점검만 동작합니다.</Notice>
            )}
            <p className="text-xs text-ink-mute">
              Routine은 claude.ai/code/routines 에서 직접 만들고 API 트리거의 Fire URL과 토큰을 여기에 등록합니다. HQ는 Routine을 만들 수 없습니다. 호출은 비동기이며 세션 생성까지만 확인됩니다(docs/CLAUDE_ROUTINES_SETUP.md).
            </p>
          </div>
        </Panel>
      </div>

      <Modal open={routineOpen} title="Claude Code Routine 등록" onClose={() => setRoutineOpen(false)}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            addRoutine.mutate({ displayName: String(f.get('displayName')), purpose: String(f.get('purpose')), fireUrl: String(f.get('fireUrl')).trim(), token: String(f.get('token')).trim() });
          }}
        >
          <Field label="이름">{(id) => <input id={id} name="displayName" required className={inputCls} placeholder="읽기 전용 점검" />}</Field>
          <Field label="용도">
            {(id) => (
              <select id={id} name="purpose" className={inputCls}>
                <option value="audit">audit — 읽기 전용 점검/개선안</option>
                <option value="incident">incident — 장애 원인 분석</option>
                <option value="draft_pr">draft_pr — Draft PR 생성</option>
              </select>
            )}
          </Field>
          <Field label="Fire URL" hint="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire">
            {(id) => <input id={id} name="fireUrl" required className={inputCls} />}
          </Field>
          <Field label="토큰 (sk-ant-oat01-…)" hint="claude.ai에서 생성 시 한 번만 표시됩니다. HQ는 암호화 저장 후 다시 보여주지 않습니다.">
            {(id) => <input id={id} name="token" type="password" autoComplete="off" required className={inputCls} />}
          </Field>
          {addRoutine.error && <ErrorBox message={errorMessage(addRoutine.error)} />}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRoutineOpen(false)}>취소</Button>
            <Button type="submit" variant="primary" loading={addRoutine.isPending}>등록</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
