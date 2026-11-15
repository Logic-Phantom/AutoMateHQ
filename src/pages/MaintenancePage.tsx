import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { MAINTENANCE_JOB_STATUS_LABEL, type MaintenanceJobStatus } from '@shared/constants';
import { errorMessage, get, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { IntegrationDto, MaintenanceJobDto } from '@/types/api';
import { Badge, Button, EmptyState, ErrorBox, ExternalLink, Loading, Notice, PageHeader, Panel, type Tone } from '@/components/ui';

function statusTone(s: string): Tone {
  if (s === 'completed' || s === 'rule_based_done') return 'ok';
  if (s === 'failed' || s === 'blocked') return 'fail';
  if (s === 'needs_review' || s === 'not_configured') return 'warn';
  if (s === 'started' || s === 'running') return 'brand';
  return 'neutral';
}

export function MaintenancePage() {
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ['maintenance'], queryFn: () => get<MaintenanceJobDto[]>('/api/maintenance/jobs'), refetchInterval: 30_000 });
  const routines = useQuery({ queryKey: ['routines'], queryFn: () => get<IntegrationDto[]>('/api/integrations/claude') });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approved' | 'rejected' }) => post(`/api/maintenance/jobs/${id}/decision`, { decision }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance'] }),
  });
  const cancel = useMutation({ mutationFn: (id: number) => post(`/api/maintenance/jobs/${id}/cancel`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance'] }) });
  const connected = (routines.data ?? []).filter((r) => r.status === 'connected');

  return (
    <>
      <PageHeader title="AI 유지보수" description="Claude Code Routine 기반 점검·제안·Draft PR. 기본값은 읽기 전용(AUDIT)이며 HQ는 merge·기본 브랜치 push를 하지 않습니다." />
      {connected.length === 0 ? (
        <Notice tone="warn">
          Claude Code 연결 필요 — 등록된 Routine이 없어 규칙 기반 점검만 동작합니다. <Link to="/settings" className="underline">연동 설정</Link>에서 Routine Fire URL과 토큰을 등록하세요.
        </Notice>
      ) : (
        <Notice tone="ok">연결된 Routine {connected.length}개: {connected.map((r) => `${r.displayName}(${String(r.metadata.purpose)})`).join(', ')}</Notice>
      )}
      {(decide.error || cancel.error) && <div className="mt-3"><ErrorBox message={errorMessage(decide.error ?? cancel.error)} /></div>}
      <div className="mt-4 space-y-3">
        {jobs.isLoading ? (
          <Loading />
        ) : jobs.error ? (
          <ErrorBox message={errorMessage(jobs.error)} />
        ) : !jobs.data?.length ? (
          <EmptyState title="유지보수 작업이 없습니다.">프로젝트 상세 화면이나 장애 관리에서 점검을 실행할 수 있습니다.</EmptyState>
        ) : (
          jobs.data.map((j) => (
            <Panel
              key={j.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  #{j.id} {j.projectName}
                  <Badge tone="neutral">{j.mode}</Badge>
                  <Badge tone={statusTone(j.status)}>{MAINTENANCE_JOB_STATUS_LABEL[j.status as MaintenanceJobStatus] ?? j.status}</Badge>
                  <Badge tone={j.analysisKind === 'claude_routine' ? 'brand' : 'neutral'}>{j.analysisKind === 'claude_routine' ? 'AI 분석(Claude Routine)' : '규칙 기반 점검'}</Badge>
                </span>
              }
              actions={<span className="tabular text-xs text-ink-mute">{fmtDateTime(j.createdAt)}</span>}
            >
              <div className="space-y-3 text-sm">
                {j.summary && <p className="whitespace-pre-wrap text-ink-soft">{j.summary}</p>}
                {j.findings.length > 0 && (
                  <ul className="space-y-1">
                    {j.findings.map((f, i) => (
                      <li key={i} className="flex gap-2">
                        <Badge tone={f.severity === 'high' || f.severity === 'critical' ? 'fail' : f.severity === 'medium' ? 'warn' : 'neutral'}>{f.severity}</Badge>
                        <span>{f.title}{f.detail ? <span className="text-ink-mute"> — {f.detail}</span> : null}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft">
                  <span>세션: <ExternalLink href={j.routineSessionUrl}>열기</ExternalLink></span>
                  <span>브랜치: {j.branchName ?? '-'}</span>
                  <span>PR: <ExternalLink href={j.pullRequestUrl}>열기</ExternalLink></span>
                  <span>테스트: {j.testsPassed === null ? '미확인' : j.testsPassed ? '통과' : '실패'}</span>
                  <span>승인: {{ pending: '대기', approved: '승인', rejected: '반려', not_required: '불필요' }[j.approvalState] ?? j.approvalState}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {j.approvalState === 'pending' && ['completed', 'needs_review'].includes(j.status) && (
                    <>
                      <Button onClick={() => decide.mutate({ id: j.id, decision: 'approved' })}>승인(머지는 GitHub에서 직접)</Button>
                      <Button variant="ghost" onClick={() => decide.mutate({ id: j.id, decision: 'rejected' })}>반려</Button>
                    </>
                  )}
                  {['started', 'running'].includes(j.status) && <Button variant="ghost" onClick={() => cancel.mutate(j.id)}>추적 취소</Button>}
                  {['started', 'running'].includes(j.status) && <span className="text-xs text-ink-mute">Routine은 비동기입니다. 결과 회신 전까지 완료로 표시하지 않습니다.</span>}
                </div>
              </div>
            </Panel>
          ))
        )}
      </div>
    </>
  );
}
