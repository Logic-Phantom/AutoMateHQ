import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { Copy, KeyRound, PlugZap, Trash2 } from 'lucide-react';
import { MAINTENANCE_MODE_LABEL, MAINTENANCE_MODES, RUN_STATUS_LABEL, SEVERITY_LABEL, type MaintenanceMode, type RunStatus } from '@shared/constants';
import type { ProjectInput } from '@shared/schemas';
import { del, errorMessage, get, patch, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { IncidentDto, ProjectDto, RunRow } from '@/types/api';
import { Badge, Button, EmptyState, ErrorBox, ExternalLink, Loading, Modal, Notice, PageHeader, Panel, runTone, StatusBadge, Table, Td } from '@/components/ui';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { RunDurationChart } from '@/components/RunDurationChart';

interface Detail {
  project: ProjectDto;
  runs: RunRow[];
  incidents: IncidentDto[];
  heartbeat: { hint: string; createdAt: string } | null;
}

interface TestResult {
  ok: boolean;
  message?: string;
  warnings?: string[];
  repo?: { fullName: string; private: boolean; archived: boolean };
  target?: { name: string; state: string } | null;
  synced?: number;
  errorCode?: string;
}

export function ProjectDetailPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: ['project', id], queryFn: () => get<Detail>(`/api/projects/${id}`) });
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [mode, setMode] = useState<MaintenanceMode>('AUDIT');
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['project', id] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const test = useMutation({ mutationFn: () => post<TestResult>(`/api/projects/${id}/test-connection`), onSuccess: invalidate });
  const rotate = useMutation({
    mutationFn: () => post<{ secret: string }>(`/api/projects/${id}/heartbeat-secret/rotate`),
    onSuccess: (r) => {
      setSecret(r.secret);
      setConfirmRotate(false);
      invalidate();
    },
  });
  const revoke = useMutation({ mutationFn: () => post(`/api/projects/${id}/heartbeat-secret/revoke`), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => del(`/api/projects/${id}`), onSuccess: () => navigate('/projects') });
  const maintain = useMutation({
    mutationFn: () => post<{ status: string; message?: string; sessionUrl?: string | null }>(`/api/projects/${id}/maintenance/run`, { mode }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance'] }),
  });

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorBox message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />;
  const { project: p, runs, incidents, heartbeat } = detail.data!;
  const origin = window.location.origin;

  return (
    <>
      <PageHeader
        title={p.name}
        description={
          <>
            {p.projectKey} {p.repositoryUrl && <> · <ExternalLink href={p.repositoryUrl}>{p.repoOwner}/{p.repoName}</ExternalLink></>}
          </>
        }
        actions={
          <>
            {p.isActive ? <StatusBadge status={p.status} /> : <Badge>비활성</Badge>}
            <Button onClick={() => setEditing(true)}>수정</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="프로젝트 삭제">
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        }
      />
      {p.statusReason && <Notice tone={p.status === 'FAILED' ? 'fail' : p.status === 'ATTENTION' ? 'warn' : 'neutral'}>{p.statusReason}</Notice>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="GitHub 연결 테스트" actions={<Button onClick={() => test.mutate()} loading={test.isPending}><PlugZap className="size-4" aria-hidden /> 테스트</Button>}>
          {!p.repoOwner ? (
            <p className="text-sm text-ink-mute">저장소가 연결되지 않은 프로젝트입니다.</p>
          ) : test.data ? (
            <div className="space-y-2 text-sm">
              <Badge tone={test.data.ok ? 'ok' : 'warn'}>{test.data.ok ? '연결 정상' : '확인 필요'}</Badge>
              {test.data.message && <p className="text-ink-soft">{test.data.message}</p>}
              {test.data.repo && <p className="text-ink-soft">{test.data.repo.fullName} · {test.data.repo.private ? '비공개' : '공개'} · 실행 기록 {test.data.synced ?? 0}개 프로젝트 동기화</p>}
              {test.data.target && <p className="text-ink-soft">워크플로 {test.data.target.name}: {test.data.target.state}</p>}
              {test.data.warnings?.map((w) => <p key={w} className="text-warn-ink">{w}</p>)}
            </div>
          ) : test.error ? (
            <ErrorBox message={errorMessage(test.error)} />
          ) : (
            <p className="text-sm text-ink-mute">저장소 접근·워크플로 상태(비활성/삭제)·최근 실행 수집을 확인합니다.</p>
          )}
        </Panel>

        <Panel title="Heartbeat 키">
          <div className="space-y-3 text-sm">
            {heartbeat ? (
              <p className="text-ink-soft">활성 키: <code>{heartbeat.hint}…</code> (발급 {fmtDateTime(heartbeat.createdAt)})</p>
            ) : (
              <p className="text-ink-mute">발급된 키가 없습니다. GitHub Actions가 아닌 자동화는 Heartbeat로 연결하세요.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => (heartbeat ? setConfirmRotate(true) : rotate.mutate())} loading={rotate.isPending}>
                <KeyRound className="size-4" aria-hidden /> {heartbeat ? '재발급' : '발급'}
              </Button>
              {heartbeat && <Button variant="ghost" onClick={() => revoke.mutate()} loading={revoke.isPending}>폐기</Button>}
            </div>
            <p className="text-xs text-ink-mute">
              엔드포인트: <code>{origin}/api/v1/heartbeat/start|complete|fail</code> · 서명 방법은 docs/HEARTBEAT_INTEGRATION.md
            </p>
            {rotate.error && <ErrorBox message={errorMessage(rotate.error)} />}
          </div>
        </Panel>

        <Panel title="AI 유지보수 실행">
          <div className="space-y-3 text-sm">
            <p className="text-ink-soft">
              허용 범위: {p.maintenanceEnabled ? `${p.maintenanceMode} (${MAINTENANCE_MODE_LABEL[p.maintenanceMode]})` : '꺼짐 — 읽기 전용 점검(AUDIT)만 가능'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="실행 모드" value={mode} onChange={(e) => setMode(e.target.value as MaintenanceMode)} className="rounded-md border border-line px-2 py-1.5 text-sm">
                {MAINTENANCE_MODES.map((m) => <option key={m} value={m}>{m} — {MAINTENANCE_MODE_LABEL[m]}</option>)}
              </select>
              <Button variant="primary" onClick={() => maintain.mutate()} loading={maintain.isPending}>실행</Button>
            </div>
            {maintain.data && (
              <Notice tone={maintain.data.status === 'started' ? 'brand' : maintain.data.status === 'blocked' || maintain.data.status === 'failed' ? 'warn' : 'neutral'}>
                {maintain.data.status === 'started' ? 'Routine 세션이 시작되었습니다(완료 아님).' : maintain.data.message}{' '}
                {maintain.data.sessionUrl && <ExternalLink href={maintain.data.sessionUrl}>세션 열기</ExternalLink>}{' '}
                <Link to="/maintenance" className="text-brand-ink hover:underline">작업 보기</Link>
              </Notice>
            )}
            {maintain.error && <ErrorBox message={errorMessage(maintain.error)} />}
          </div>
        </Panel>

        <Panel title="장애 이력">
          {incidents.length === 0 ? (
            <p className="text-sm text-ink-mute">장애 기록이 없습니다.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {incidents.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                  <span>{i.title}</span>
                  <span className="flex shrink-0 gap-1">
                    <Badge tone={i.status === 'resolved' ? 'ok' : 'warn'}>{i.status}</Badge>
                    <Badge>{SEVERITY_LABEL[i.severity]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="실행 소요 시간 추이" className="mt-4">
        <RunDurationChart runs={runs} />
      </Panel>

      <Panel title="최근 실행" className="mt-4">
        {runs.length === 0 ? (
          <EmptyState title="실행 기록이 없습니다.">위의 연결 테스트로 바로 동기화하거나, 감시 방식·워크플로 파일 설정을 확인하세요.</EmptyState>
        ) : (
          <Table head={['시작', '소스', '워크플로/단계', '상태', '오류', '원본']}>
            {runs.map((r) => (
              <tr key={r.id}>
                <Td className="tabular whitespace-nowrap">{fmtDateTime(r.startedAt)}</Td>
                <Td>{r.sourceType === 'github_actions' ? 'GitHub' : r.sourceType === 'github_commits' ? '커밋' : 'Heartbeat'}</Td>
                <Td className="text-ink-soft">{r.workflowName ?? '-'}{r.stage ? ` · ${r.stage}` : ''}</Td>
                <Td><Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status as RunStatus] ?? r.status}</Badge></Td>
                <Td className="text-xs text-ink-soft">{r.safeErrorMessage ?? r.errorCode ?? '-'}</Td>
                <Td><ExternalLink href={r.externalUrl}>열기</ExternalLink></Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Modal open={editing} title="프로젝트 수정" onClose={() => setEditing(false)}>
        {editing && (
          <ProjectForm
            isEdit
            initial={{ ...(p as unknown as ProjectInput), expectedDays: p.expectedDays }}
            onCancel={() => setEditing(false)}
            onSubmit={async (v) => {
              const { projectKey: _k, ...rest } = v;
              await patch(`/api/projects/${id}`, rest);
              setEditing(false);
              invalidate();
            }}
          />
        )}
      </Modal>

      <Modal open={secret !== null} title="Heartbeat secret 발급됨" onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>저장했습니다</Button>}>
        <Notice tone="warn">이 값은 지금 한 번만 표시됩니다. 자동화 프로그램의 비밀 저장소(예: GitHub Actions secret <code>HQ_HEARTBEAT_SECRET</code>)에 바로 등록하세요.</Notice>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-neutral-soft px-2 py-1.5 text-xs">{secret}</code>
          <Button aria-label="복사" onClick={() => void navigator.clipboard?.writeText(secret ?? '')}><Copy className="size-4" /></Button>
        </div>
      </Modal>

      <Modal
        open={confirmRotate}
        title="Heartbeat 키 재발급"
        onClose={() => setConfirmRotate(false)}
        footer={<><Button onClick={() => setConfirmRotate(false)}>취소</Button><Button variant="danger" loading={rotate.isPending} onClick={() => rotate.mutate()}>재발급</Button></>}
      >
        재발급하면 기존 키는 즉시 폐기되어 해당 키로 서명한 요청이 거부됩니다.
      </Modal>

      <Modal
        open={confirmDelete}
        title="프로젝트 삭제"
        onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>취소</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>삭제</Button></>}
      >
        감시·알림·Heartbeat 키가 중지됩니다. 실행 이력은 지우지 않고 보관합니다(soft delete).
        {remove.error && <ErrorBox message={errorMessage(remove.error)} />}
      </Modal>
    </>
  );
}
