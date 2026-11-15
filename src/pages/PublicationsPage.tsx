import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PUBLICATION_STAGE_LABEL, type PublicationStage } from '@shared/constants';
import { errorMessage, get } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge, EmptyState, ErrorBox, ExternalLink, Loading, Notice, PageHeader, Panel, Table, Td, cx, type Tone } from '@/components/ui';

interface Publication {
  id: number;
  projectName: string;
  platform: string;
  contentKey: string;
  title: string | null;
  status: string;
  generatedAt: string | null;
  uploadStartedAt: string | null;
  publishedAt: string | null;
  platformUrl: string | null;
  verificationStatus: string;
  failedStage: string | null;
  errorCode: string | null;
  safeErrorMessage: string | null;
  retried: boolean;
  metrics: Record<string, number>;
  updatedAt: string;
}

const stageTone = (s: string): Tone => (s === 'published' ? 'ok' : s === 'failed' ? 'fail' : s === 'verification_pending' ? 'warn' : 'brand');
const VERIFY_LABEL: Record<string, { label: string; tone: Tone }> = {
  official_api_verified: { label: '공식 API 검증', tone: 'ok' },
  heartbeat_reported: { label: '게시 완료 보고됨(파이프라인)', tone: 'brand' },
  unverified: { label: '미검증', tone: 'neutral' },
};

export function PublicationsPage() {
  const [platform, setPlatform] = useState('');
  const pubs = useQuery({ queryKey: ['publications', platform], queryFn: () => get<Publication[]>(`/api/publications${platform ? `?platform=${platform}` : ''}`) });

  return (
    <>
      <PageHeader title="콘텐츠 게시 현황" description="파이프라인 성공과 실제 게시 완료를 구분해 기록합니다." />
      <Notice tone="neutral">
        게시 확인은 공식 API(YouTube Data API·Instagram Graph API)만 사용합니다. 공식 API가 연결되지 않은 경우 파이프라인 Heartbeat 보고 기준으로 “게시 완료 보고됨”으로 표시하며, 플랫폼 검증과 구분합니다. 조회수·도달은 보고된 값만 표시하고 추정하지 않습니다.
      </Notice>
      <div role="tablist" aria-label="플랫폼" className="my-3 flex gap-1">
        {[['', '전체'], ['youtube', 'YouTube'], ['instagram', 'Instagram'], ['other', '기타']].map(([v, l]) => (
          <button key={v} role="tab" aria-selected={platform === v} onClick={() => setPlatform(v!)} className={cx('rounded-md px-3 py-1.5 text-sm', platform === v ? 'bg-ink text-white' : 'text-ink-soft hover:bg-neutral-soft')}>
            {l}
          </button>
        ))}
      </div>
      <Panel>
        {pubs.isLoading ? (
          <Loading />
        ) : pubs.error ? (
          <ErrorBox message={errorMessage(pubs.error)} />
        ) : !pubs.data?.length ? (
          <EmptyState title="게시 기록이 없습니다.">Heartbeat 본문의 publication 필드 또는 /api/publications/events 로 단계별 상태를 보내세요.</EmptyState>
        ) : (
          <Table head={['콘텐츠', '플랫폼', '단계', '확인 출처', '생성/업로드/게시', '지표(보고값)', '링크']}>
            {pubs.data.map((p) => (
              <tr key={p.id}>
                <Td>
                  <p className="font-medium">{p.title ?? p.contentKey}</p>
                  <p className="text-xs text-ink-mute">{p.projectName}</p>
                </Td>
                <Td>{p.platform}</Td>
                <Td>
                  <Badge tone={stageTone(p.status)}>{PUBLICATION_STAGE_LABEL[p.status as PublicationStage] ?? p.status}</Badge>
                  {p.status === 'failed' && <p className="mt-1 text-xs text-fail-ink">{p.failedStage ? `${p.failedStage} 단계 · ` : ''}{p.errorCode ?? ''} {p.safeErrorMessage ?? ''}</p>}
                  {p.retried && <p className="text-xs text-ink-mute">재시도됨</p>}
                </Td>
                <Td><Badge tone={VERIFY_LABEL[p.verificationStatus]?.tone ?? 'neutral'}>{VERIFY_LABEL[p.verificationStatus]?.label ?? p.verificationStatus}</Badge></Td>
                <Td className="tabular text-xs text-ink-soft">
                  {fmtDateTime(p.generatedAt)} / {fmtDateTime(p.uploadStartedAt)} / {fmtDateTime(p.publishedAt)}
                </Td>
                <Td className="tabular text-xs text-ink-soft">
                  {Object.keys(p.metrics).length ? Object.entries(p.metrics).map(([k, v]) => `${k}: ${v}`).join(', ') : '미연동'}
                </Td>
                <Td><ExternalLink href={p.platformUrl}>게시물</ExternalLink></Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
