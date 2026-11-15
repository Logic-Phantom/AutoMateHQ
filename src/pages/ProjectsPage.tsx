import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Plus, Wand2 } from 'lucide-react';
import { CADENCE_LABEL, CATEGORY_LABEL, MONITORING_MODE_LABEL, type Cadence, type MonitoringMode, type ProjectCategory } from '@shared/constants';
import type { ProjectInput } from '@shared/schemas';
import type { ProjectPreset } from '@shared/presets';
import { errorMessage, get, post } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import type { ProjectDto } from '@/types/api';
import { Badge, Button, EmptyState, ErrorBox, inputCls, Loading, Modal, PageHeader, Panel, StatusBadge, Table, Td } from '@/components/ui';
import { EMPTY_PROJECT, ProjectForm } from '@/components/projects/ProjectForm';

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => get<ProjectDto[]>('/api/projects') });
  const presets = useQuery({ queryKey: ['presets'], queryFn: () => get<(ProjectPreset & { alreadyRegistered: boolean })[]>('/api/projects/presets') });
  const [creating, setCreating] = useState<ProjectInput | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');

  const create = useMutation({
    mutationFn: (v: ProjectInput) => post<ProjectDto>('/api/projects', v),
    onSuccess: () => {
      setCreating(null);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['presets'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  const filtered = useMemo(
    () =>
      (projects.data ?? []).filter(
        (p) =>
          (!q || `${p.name} ${p.projectKey} ${p.repoName ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
          (!status || (status === 'INACTIVE' ? !p.isActive : p.isActive && p.status === status)) &&
          (!category || p.category === category),
      ),
    [projects.data, q, status, category],
  );

  return (
    <>
      <PageHeader
        title="프로젝트 관리"
        description="감시할 저장소·자동화 작업을 등록하고 기대 실행 일정과 유지보수 정책을 설정합니다."
        actions={
          <>
            <Button onClick={() => setShowPresets(true)}>
              <Wand2 className="size-4" aria-hidden /> 기존 저장소에서 추가
            </Button>
            <Button variant="primary" onClick={() => setCreating({ ...EMPTY_PROJECT })}>
              <Plus className="size-4" aria-hidden /> 직접 등록
            </Button>
          </>
        }
      />
      <Panel>
        <div className="mb-3 flex flex-wrap gap-2">
          <input aria-label="검색" placeholder="이름·키·저장소 검색" value={q} onChange={(e) => setQ(e.target.value)} className={`${inputCls} max-w-xs`} />
          <select aria-label="상태 필터" value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">모든 상태</option>
            <option value="NORMAL">정상</option>
            <option value="FAILED">실패</option>
            <option value="ATTENTION">확인 필요</option>
            <option value="UNKNOWN">확인 불가</option>
            <option value="INACTIVE">비활성</option>
          </select>
          <select aria-label="분류 필터" value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputCls} w-auto`}>
            <option value="">모든 분류</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {projects.isLoading ? (
          <Loading />
        ) : projects.error ? (
          <ErrorBox message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} />
        ) : filtered.length === 0 ? (
          <EmptyState title={projects.data?.length ? '조건에 맞는 프로젝트가 없습니다.' : '아직 등록된 프로젝트가 없습니다.'}>
            {!projects.data?.length && '"기존 저장소에서 추가"로 지금까지 만든 자동화 저장소를 빠르게 등록할 수 있습니다.'}
          </EmptyState>
        ) : (
          <Table head={['프로젝트', '상태', '모니터링', '일정', '저장소', '마지막 동기화']}>
            {filtered.map((p) => (
              <tr key={p.id} className={p.isActive ? '' : 'opacity-60'}>
                <Td>
                  <Link to={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                  <div className="text-xs text-ink-mute">{p.projectKey} · {CATEGORY_LABEL[p.category as ProjectCategory]}</div>
                </Td>
                <Td>{p.isActive ? <StatusBadge status={p.status} /> : <Badge>비활성</Badge>}</Td>
                <Td className="text-ink-soft">
                  {MONITORING_MODE_LABEL[p.monitoringMode as MonitoringMode]}
                  {p.hasHeartbeat && <Badge tone="brand">Heartbeat</Badge>}
                </Td>
                <Td className="tabular whitespace-nowrap text-ink-soft">
                  {CADENCE_LABEL[p.expectedCadence as Cadence]} {p.expectedTimeLocal ?? (p.intervalHours ? `${p.intervalHours}h` : '')}
                </Td>
                <Td className="text-ink-soft">{p.repoOwner ? `${p.repoOwner}/${p.repoName}` : '-'}{p.workflowFile && <div className="text-xs text-ink-mute">{p.workflowFile}</div>}</Td>
                <Td className="tabular whitespace-nowrap text-ink-soft">
                  {fmtRelative(p.lastSyncedAt)}
                  {p.lastSyncErrorCode && <div><Badge tone="warn">수집 실패 {p.lastSyncErrorCode}</Badge></div>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Modal open={creating !== null} title="프로젝트 등록" onClose={() => setCreating(null)}>
        {creating && <ProjectForm initial={creating} onSubmit={async (v) => void (await create.mutateAsync(v))} onCancel={() => setCreating(null)} />}
      </Modal>

      <Modal open={showPresets} title="기존 저장소에서 추가" onClose={() => setShowPresets(false)} footer={<Button onClick={() => setShowPresets(false)}>닫기</Button>}>
        <p className="mb-3 text-ink-soft">지금까지 만든 자동화 저장소의 워크플로 구성을 참고한 등록 제안입니다. 선택하면 등록 양식이 채워지며, 확인 후 저장해야 반영됩니다.</p>
        {presets.isLoading ? (
          <Loading />
        ) : (
          <ul className="divide-y divide-line">
            {(presets.data ?? []).map((p) => (
              <li key={p.presetId} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <p className="font-medium">{p.input.name}</p>
                  <p className="text-xs text-ink-mute">{p.input.repoOwner}/{p.input.repoName} · {p.hint}</p>
                </div>
                {p.alreadyRegistered ? (
                  <Badge tone="ok">등록됨</Badge>
                ) : (
                  <Button
                    onClick={() => {
                      setShowPresets(false);
                      setCreating({ ...EMPTY_PROJECT, ...p.input });
                    }}
                  >
                    선택
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {create.error && <ErrorBox message={errorMessage(create.error)} />}
      </Modal>
    </>
  );
}
