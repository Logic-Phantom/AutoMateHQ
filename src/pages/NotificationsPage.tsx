import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { DAILY_REPORT_TIME_LABEL, DAILY_REPORT_WINDOW_LABEL, INTEGRATION_STATUS_LABEL } from '@shared/constants';
import { errorMessage, get, patch, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { KakaoStatusDto } from '@/types/api';
import { Badge, Button, EmptyState, ErrorBox, integrationTone, Loading, Modal, Notice, PageHeader, Panel, Table, Td } from '@/components/ui';

interface History {
  history: { id: number; type: string; status: string; summary: string; sentAt: string | null; responseCode: string | null; error: string | null; createdAt: string }[];
  settings: { dailyReportEnabled: boolean; instantAlertsEnabled: boolean; alertCooldownMinutes: number };
}

const CALLBACK_MESSAGES: Record<string, { tone: 'ok' | 'fail' | 'warn'; text: string }> = {
  connected: { tone: 'ok', text: '카카오 계정이 연결되었습니다. 테스트 메시지를 보내 확인하세요.' },
  denied: { tone: 'warn', text: '카카오 동의가 취소되었습니다.' },
  state_invalid: { tone: 'fail', text: 'OAuth state 검증에 실패했습니다(만료 또는 위조 의심). 다시 연결하세요.' },
  not_configured: { tone: 'warn', text: '카카오 앱 키(KAKAO_REST_API_KEY) 또는 PUBLIC_BASE_URL이 설정되지 않았습니다(샘플 모드에서는 연결하지 않음).' },
  error: { tone: 'fail', text: '카카오 연결 중 오류가 발생했습니다. Redirect URI·Client Secret·동의 항목을 확인하세요.' },
};

const TYPE_LABEL: Record<string, string> = { daily_report: '정기 보고서', test: '테스트', incident_alert: '장애 알림' };

export function NotificationsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [callback, setCallback] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => {
    const k = params.get('kakao');
    if (k) {
      setCallback(k);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const status = useQuery({ queryKey: ['kakao'], queryFn: () => get<KakaoStatusDto>('/api/integrations/kakao/status') });
  const history = useQuery({ queryKey: ['notifications'], queryFn: () => get<History>('/api/notifications/history') });
  const preview = useQuery({ queryKey: ['report-preview'], queryFn: () => get<{ messages: string[]; lengths: number[] }>('/api/reports/preview'), enabled: false });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['kakao'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const test = useMutation({ mutationFn: () => post<{ status: string; detail: string }>('/api/integrations/kakao/test-message'), onSuccess: refresh });
  const sendNow = useMutation({ mutationFn: () => post<{ action: string; reason?: string; delivery?: { detail: string } }>('/api/reports/daily/send'), onSuccess: refresh });
  const disconnect = useMutation({
    mutationFn: (revokeRemote: boolean) => post('/api/integrations/kakao/disconnect', { revokeRemote }),
    onSuccess: () => {
      setConfirmDisconnect(false);
      refresh();
    },
  });
  const settings = useMutation({ mutationFn: (v: Partial<History['settings']>) => patch('/api/notifications/settings', v), onSuccess: refresh });

  const s = status.data;
  const cb = callback ? CALLBACK_MESSAGES[callback] : null;

  return (
    <>
      <PageHeader title="알림 설정" description={`매일 ${DAILY_REPORT_TIME_LABEL}(한국 시간) 운영 보고서를 카카오톡 ‘나와의 채팅’으로 보냅니다.`} />
      {cb && <div className="mb-3"><Notice tone={cb.tone}>{cb.text}</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="카카오톡 연결">
          {status.isLoading ? (
            <Loading />
          ) : status.error ? (
            <ErrorBox message={errorMessage(status.error)} />
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={integrationTone(s!.status)}>{INTEGRATION_STATUS_LABEL[s!.status as keyof typeof INTEGRATION_STATUS_LABEL] ?? s!.status}</Badge>
                {!s!.configured && <Badge tone="warn">앱 키 미설정</Badge>}
              </div>
              <dl className="tabular grid grid-cols-[9rem_1fr] gap-y-1 text-ink-soft">
                <dt>마지막 토큰 확인</dt><dd>{fmtDateTime(s!.lastVerifiedAt)}</dd>
                <dt>마지막 토큰 갱신</dt><dd>{fmtDateTime(s!.lastRefreshAt)}</dd>
                <dt>리프레시 토큰 만료</dt><dd>{s!.refreshExpiresAt ? fmtDateTime(s!.refreshExpiresAt) : '확인 불가(만료 1개월 전 갱신 시 표시)'}</dd>
                <dt>마지막 발송</dt><dd>{s!.lastDelivery ? `${fmtDateTime(s!.lastDelivery.sent_at ?? s!.lastDelivery.created_at)} · ${TYPE_LABEL[s!.lastDelivery.notification_type] ?? s!.lastDelivery.notification_type} · ${s!.lastDelivery.status}` : '-'}</dd>
                <dt>Redirect URI</dt><dd className="break-all text-xs">{s!.redirectUri ?? 'PUBLIC_BASE_URL 미설정'}</dd>
              </dl>
              {s!.lastErrorMessage && <Notice tone="fail">{s!.lastErrorMessage}</Notice>}
              <div className="flex flex-wrap gap-2">
                <a href="/api/integrations/kakao/connect" className="inline-flex items-center rounded-md border border-transparent bg-kakao px-3 py-1.5 text-sm font-medium text-kakao-ink transition-[filter] hover:brightness-95 active:brightness-90">
                  {s!.status === 'connected' ? '카카오 다시 연결' : '카카오 로그인 연결'}
                </a>
                <Button onClick={() => test.mutate()} loading={test.isPending} disabled={s!.status !== 'connected'}>테스트 메시지 보내기</Button>
                {s!.status !== 'not_connected' && <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>연결 해제</Button>}
              </div>
              {test.data && <Notice tone={test.data.status === 'SENT' ? 'ok' : 'fail'}>{test.data.status === 'SENT' ? '발송 요청 성공(카카오 응답 result_code 0). 읽음 여부는 알 수 없습니다.' : `발송 실패: ${test.data.detail}`}</Notice>}
              {test.error && <ErrorBox message={errorMessage(test.error)} />}
              <p className="text-xs text-ink-mute">친구에게 보내기는 지원하지 않습니다. 설정 방법: docs/KAKAO_SETUP.md</p>
            </div>
          )}
        </Panel>

        <Panel title="알림 정책">
          {history.data ? (
            <div className="space-y-3 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={history.data.settings.dailyReportEnabled} onChange={(e) => settings.mutate({ dailyReportEnabled: e.target.checked })} />
                {DAILY_REPORT_TIME_LABEL} 정기 보고서
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={history.data.settings.instantAlertsEnabled} onChange={(e) => settings.mutate({ instantAlertsEnabled: e.target.checked })} />
                장애 즉시 알림(새 고심각도 장애·악화·복구만)
              </label>
              <label className="flex items-center gap-2">
                같은 장애 알림 쿨다운
                <select
                  value={history.data.settings.alertCooldownMinutes}
                  onChange={(e) => settings.mutate({ alertCooldownMinutes: Number(e.target.value) })}
                  className="rounded-md border border-line px-2 py-1"
                >
                  {[30, 60, 180, 360, 720, 1440].map((m) => <option key={m} value={m}>{m >= 60 ? `${m / 60}시간` : `${m}분`}</option>)}
                </select>
              </label>
              <p className="text-xs text-ink-mute">
                스케줄러는 10분 간격(UTC 기준, 지연될 수 있음)으로 실행되며, {DAILY_REPORT_WINDOW_LABEL} KST 사이에 아직 보내지 않은 날의 보고서를 보냅니다. 같은 날짜는 한 번만 보내고 실패 시 최대 3회 재시도합니다.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void preview.refetch()} loading={preview.isFetching}>보고서 미리보기</Button>
                <Button onClick={() => sendNow.mutate()} loading={sendNow.isPending}>오늘 보고서 지금 보내기</Button>
                <Link to={`/reports/${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}`} className="self-center text-xs text-brand-ink hover:underline">오늘 보고서 페이지</Link>
              </div>
              {sendNow.data && <Notice tone={sendNow.data.action === 'sent' ? 'ok' : 'neutral'}>{sendNow.data.action === 'sent' ? '발송했습니다.' : sendNow.data.reason ?? sendNow.data.delivery?.detail ?? sendNow.data.action}</Notice>}
              {preview.data && (
                <div className="space-y-2">
                  {preview.data.messages.map((m, i) => (
                    <div key={i} className="rounded-md bg-kakao-bubble p-3 text-xs whitespace-pre-wrap text-kakao-ink">
                      {m}
                      <div className="tabular mt-1 text-right text-xs text-kakao-ink/60">{preview.data!.lengths[i]}/200자</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Loading />
          )}
        </Panel>
      </div>

      <Panel title="발송 이력" className="mt-4">
        {!history.data?.history.length ? (
          <EmptyState title="발송 이력이 없습니다.">카카오를 연결한 뒤 테스트 메시지를 보내거나 정기 보고서가 발송되면 여기에 기록됩니다.</EmptyState>
        ) : (
          <Table head={['시각', '유형', '상태', '내용', '응답', '오류']}>
            {history.data.history.map((h) => (
              <tr key={h.id}>
                <Td className="tabular whitespace-nowrap">{fmtDateTime(h.sentAt ?? h.createdAt)}</Td>
                <Td>{TYPE_LABEL[h.type] ?? h.type}</Td>
                <Td><Badge tone={h.status === 'sent' ? 'ok' : h.status === 'failed' ? 'fail' : 'neutral'}>{h.status === 'sent' ? '발송' : h.status === 'failed' ? '실패' : '건너뜀'}</Badge></Td>
                <Td className="max-w-sm truncate text-xs text-ink-soft" >{h.summary}</Td>
                <Td className="text-xs">{h.responseCode ?? '-'}</Td>
                <Td className="text-xs text-fail-ink">{h.error ?? ''}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Modal
        open={confirmDisconnect}
        title="카카오 연결 해제"
        onClose={() => setConfirmDisconnect(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDisconnect(false)}>취소</Button>
            <Button onClick={() => disconnect.mutate(false)} loading={disconnect.isPending}>HQ에서만 삭제</Button>
            <Button variant="danger" onClick={() => disconnect.mutate(true)} loading={disconnect.isPending}>토큰 폐기 후 삭제</Button>
          </>
        }
      >
        HQ에 저장된 카카오 토큰을 삭제하면 {DAILY_REPORT_TIME_LABEL} 정기 보고서가 발송되지 않습니다. “토큰 폐기”는 카카오 로그아웃 API로 이 토큰만 만료시키며, 같은 카카오 앱을 쓰는 다른 프로젝트의 동의(연결 끊기)는 건드리지 않습니다.
      </Modal>
    </>
  );
}
