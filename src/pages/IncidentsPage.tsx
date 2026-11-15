import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SEVERITY_LABEL } from '@shared/constants';
import { errorMessage, get, post } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import type { IncidentDto } from '@/types/api';
import { Badge, Button, EmptyState, ErrorBox, Loading, Notice, PageHeader, Panel, Table, Td, cx } from '@/components/ui';

const FILTERS = [
  { value: '', label: '전체' },
  { value: 'open', label: '열린 장애' },
  { value: 'acknowledged', label: '확인 중' },
  { value: 'resolved', label: '해결됨' },
];

export function IncidentsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const incidents = useQuery({ queryKey: ['incidents', status], queryFn: () => get<IncidentDto[]>(`/api/incidents${status ? `?status=${status}` : ''}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['incidents'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const act = useMutation({ mutationFn: ({ id, action }: { id: number; action: 'acknowledge' | 'resolve' }) => post(`/api/incidents/${id}/${action}`, {}), onSuccess: refresh });
  const analyze = useMutation({
    mutationFn: (id: number) => post<{ status: string; message?: string; sessionUrl?: string | null }>(`/api/incidents/${id}/analyze`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['maintenance'] }),
  });

  return (
    <>
      <PageHeader title="장애 관리" description="같은 원인(fingerprint)은 하나로 묶고, 반복 횟수와 최근 발생 시각을 갱신합니다." />
      <div role="tablist" aria-label="상태 필터" className="mb-3 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={status === f.value}
            onClick={() => setStatus(f.value)}
            className={cx('rounded-md px-3 py-1.5 text-sm', status === f.value ? 'bg-ink text-white' : 'text-ink-soft hover:bg-neutral-soft')}
          >
            {f.label}
          </button>
        ))}
      </div>
      {analyze.data && (
        <div className="mb-3">
          <Notice tone={analyze.data.status === 'started' ? 'brand' : 'neutral'}>
            {analyze.data.status === 'started' ? 'Claude Routine 분석 세션이 시작되었습니다(완료 아님).' : analyze.data.message} AI 유지보수 화면에서 진행을 확인하세요.
          </Notice>
        </div>
      )}
      {(act.error || analyze.error) && <ErrorBox message={errorMessage(act.error ?? analyze.error)} />}
      <Panel>
        {incidents.isLoading ? (
          <Loading />
        ) : incidents.error ? (
          <ErrorBox message={errorMessage(incidents.error)} />
        ) : !incidents.data?.length ? (
          <EmptyState title="해당하는 장애가 없습니다." />
        ) : (
          <Table head={['심각도', '장애', '프로젝트', '최초/최근', '반복', '상태', '조치']}>
            {incidents.data.map((i) => (
              <tr key={i.id}>
                <Td><Badge tone={i.severity === 'critical' || i.severity === 'high' ? 'fail' : i.severity === 'medium' ? 'warn' : 'neutral'}>{SEVERITY_LABEL[i.severity]}</Badge></Td>
                <Td className="max-w-md">
                  <p className="font-medium">{i.title}</p>
                  <p className="text-xs text-ink-mute">{i.category}{i.relatedRunId ? ` · 관련 실행 #${i.relatedRunId}` : ''}</p>
                </Td>
                <Td>{i.projectName ?? <span className="text-ink-mute">전역</span>}</Td>
                <Td className="tabular whitespace-nowrap text-xs text-ink-soft">
                  {fmtDateTime(i.firstSeenAt)}
                  <br />
                  {fmtRelative(i.lastSeenAt)}
                </Td>
                <Td className="tabular">{i.occurrenceCount}</Td>
                <Td><Badge tone={i.status === 'resolved' ? 'ok' : i.status === 'acknowledged' ? 'brand' : 'warn'}>{{ open: '열림', acknowledged: '확인 중', resolved: '해결됨', suppressed: '숨김' }[i.status] ?? i.status}</Badge></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {i.status === 'open' && <Button onClick={() => act.mutate({ id: i.id, action: 'acknowledge' })}>확인</Button>}
                    {i.status !== 'resolved' && <Button onClick={() => act.mutate({ id: i.id, action: 'resolve' })}>해결</Button>}
                    {i.projectId && i.status !== 'resolved' && <Button variant="ghost" onClick={() => analyze.mutate(i.id)} loading={analyze.isPending && analyze.variables === i.id}>분석 요청</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
