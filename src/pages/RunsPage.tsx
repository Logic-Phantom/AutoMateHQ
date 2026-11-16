import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { RUN_STATUS_LABEL, RUN_STATUSES, type RunStatus } from '@shared/constants';
import { errorMessage, get, post } from '@/lib/api';
import { fmtDateTime, fmtDuration, newIdempotencyKey } from '@/lib/format';
import type { ProjectDto, RunRow } from '@/types/api';
import { Badge, Button, EmptyState, ErrorBox, ExternalLink, inputCls, Loading, Modal, Notice, PageHeader, Panel, runTone, Table, Td } from '@/components/ui';

interface RunDetail {
  run: Record<string, unknown>;
  events: { event_type: string; status: string | null; stage: string | null; message: string | null; created_at: string }[];
  reruns: { status: string; response_code: number | null; safe_error_message: string | null; github_run_url: string | null; created_at: string }[];
}

export function RunsPage() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<RunRow | null>(null);
  const [rerunTarget, setRerunTarget] = useState<RunRow | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());

  const qs = new URLSearchParams();
  if (projectId) qs.set('projectId', projectId);
  if (status) qs.set('status', status);
  if (from) qs.set('from', new Date(`${from}T00:00:00+09:00`).toISOString());
  if (to) qs.set('to', new Date(`${to}T23:59:59+09:00`).toISOString());
  const runs = useQuery({ queryKey: ['runs', qs.toString()], queryFn: () => get<RunRow[]>(`/api/runs?${qs}`) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => get<ProjectDto[]>('/api/projects') });
  const detail = useQuery({ queryKey: ['run', selected?.id], queryFn: () => get<RunDetail>(`/api/runs/${selected!.id}`), enabled: Boolean(selected) });

  const rerun = useMutation({
    mutationFn: (r: RunRow) => post<{ duplicate: boolean; status: string; url: string | null }>(`/api/runs/${r.id}/rerun`, { confirm: 'RERUN', idempotencyKey: idemKey, failedJobsOnly: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  return (
    <>
      <PageHeader title="실행 이력" description="GitHub Actions와 Heartbeat 실행 기록. 시간은 한국 시간." />
      <Panel>
        <div className="mb-3 flex flex-wrap gap-2">
          <select aria-label="프로젝트" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">모든 프로젝트</option>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="상태" value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">모든 상태</option>
            {RUN_STATUSES.map((s) => <option key={s} value={s}>{RUN_STATUS_LABEL[s]}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-ink-soft">시작일 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} w-auto`} /></label>
          <label className="flex items-center gap-1 text-xs text-ink-soft">종료일 <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputCls} w-auto`} /></label>
        </div>
        {runs.isLoading ? (
          <Loading />
        ) : runs.error ? (
          <ErrorBox message={errorMessage(runs.error)} onRetry={() => void runs.refetch()} />
        ) : !runs.data?.length ? (
          <EmptyState title="조건에 맞는 실행 기록이 없습니다." />
        ) : (
          <Table head={['시작', '프로젝트', '워크플로/단계', '상태', '소요', '오류', '링크', '']}>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <Td className="tabular whitespace-nowrap">
                  <button type="button" className="text-left hover:underline" onClick={() => setSelected(r)}>{fmtDateTime(r.startedAt)}</button>
                </Td>
                <Td>{r.projectName}</Td>
                <Td className="text-ink-soft">
                  {r.workflowName ?? '-'}{r.stage ? ` · ${r.stage}` : ''}
                  <div className="text-xs text-ink-mute">{r.sourceType === 'github_actions' ? `GitHub · ${r.triggerType ?? ''}` : r.sourceType === 'github_commits' ? 'GitHub 커밋' : 'Heartbeat'}{r.runAttempt && r.runAttempt > 1 ? ` · 시도 ${r.runAttempt}` : ''}</div>
                </Td>
                <Td>
                  <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status as RunStatus] ?? r.status}</Badge>
                  {r.rerunStatus && <div className="mt-1"><Badge tone="brand">재실행 {r.rerunStatus}</Badge></div>}
                </Td>
                <Td className="tabular whitespace-nowrap text-ink-soft">{fmtDuration(r.durationSeconds)}</Td>
                <Td className="max-w-[16rem] text-xs text-ink-soft">{r.safeErrorMessage ?? r.errorCode ?? '-'}</Td>
                <Td><ExternalLink href={r.externalUrl}>원본</ExternalLink></Td>
                <Td>
                  {r.sourceType === 'github_actions' && r.status === 'failure' && (
                    <Button
                      onClick={() => {
                        setIdemKey(newIdempotencyKey());
                        rerun.reset();
                        setRerunTarget(r);
                      }}
                    >
                      <RotateCcw className="size-4" aria-hidden /> 재실행
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Modal
        open={rerunTarget !== null}
        title="실패한 워크플로 재실행"
        onClose={() => setRerunTarget(null)}
        footer={
          rerun.isSuccess ? (
            <Button onClick={() => setRerunTarget(null)}>닫기</Button>
          ) : (
            <>
              <Button onClick={() => setRerunTarget(null)}>취소</Button>
              <Button variant="danger" loading={rerun.isPending} onClick={() => rerunTarget && rerun.mutate(rerunTarget)}>재실행 승인</Button>
            </>
          )
        }
      >
        {rerunTarget && (
          <div className="space-y-3">
            <p>
              <strong>{rerunTarget.projectName}</strong> · {rerunTarget.workflowName} ({fmtDateTime(rerunTarget.startedAt)})
            </p>
            <Notice tone="warn">
              실패한 job만 다시 실행합니다. 실행 직전에 GitHub에서 상태를 다시 확인하며, 실행 중이거나 성공한 run은 재실행하지 않습니다. 업로드/게시 작업은 중복 게시 위험이 있으니 게시 여부를 먼저 확인하세요.
            </Notice>
            {rerun.data && <Notice tone={rerun.data.duplicate ? 'neutral' : 'ok'}>{rerun.data.duplicate ? '이미 처리된 요청입니다(중복 방지).' : '재실행 요청이 수락되었습니다.'} <ExternalLink href={rerun.data.url}>GitHub에서 보기</ExternalLink></Notice>}
            {rerun.error && <ErrorBox message={errorMessage(rerun.error)} />}
          </div>
        )}
      </Modal>

      <Modal open={selected !== null} title="실행 상세" onClose={() => setSelected(null)} footer={<Button onClick={() => setSelected(null)}>닫기</Button>}>
        {detail.isLoading ? (
          <Loading />
        ) : detail.data ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
              {(['status', 'stage', 'branch', 'commit_sha', 'trigger_type', 'run_attempt', 'error_code', 'safe_error_message', 'summary'] as const).map((k) =>
                detail.data.run[k] !== null && detail.data.run[k] !== undefined ? (
                  <div key={k} className="contents">
                    <dt className="text-ink-mute">{k}</dt>
                    <dd className="break-all">{String(detail.data.run[k])}</dd>
                  </div>
                ) : null,
              )}
            </dl>
            <div>
              <h3 className="mb-1 text-xs font-semibold text-ink-soft">이벤트 타임라인</h3>
              {detail.data.events.length === 0 ? (
                <p className="text-xs text-ink-mute">이벤트 없음(폴링으로 수집된 실행)</p>
              ) : (
                <ol className="space-y-1 text-xs">
                  {detail.data.events.map((e, i) => (
                    <li key={i} className="tabular">{fmtDateTime(e.created_at)} · {e.event_type} {e.status ?? ''} {e.stage ?? ''} {e.message ?? ''}</li>
                  ))}
                </ol>
              )}
            </div>
            {detail.data.reruns.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold text-ink-soft">재실행 요청</h3>
                <ul className="space-y-1 text-xs">
                  {detail.data.reruns.map((r, i) => (
                    <li key={i}>{fmtDateTime(r.created_at)} · {r.status} {r.response_code ?? ''} {r.safe_error_message ?? ''}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
