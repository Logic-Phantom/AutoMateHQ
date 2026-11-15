import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { errorMessage, get } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { DailyReportDto, ReportItem } from '@/types/api';
import { Badge, EmptyState, ErrorBox, ExternalLink, Loading, Notice, PageHeader, Panel, StatusBadge } from '@/components/ui';

interface ReportResponse {
  report: { reportDate: string; status: string; attemptCount: number; generatedAt: string; sentAt: string | null; safeErrorMessage: string | null; renderedMessage: string; report: DailyReportDto } | null;
  history: { report_date_local: string; status: string; sent_at: string | null; attempt_count: number; safe_error_message: string | null }[];
}

function Section({ title, items }: { title: string; items: ReportItem[] }) {
  if (!items.length) return null;
  return (
    <Panel title={`${title} ${items.length}`}>
      <ul className="divide-y divide-line text-sm">
        {items.map((i) => (
          <li key={i.projectId} className="flex items-start justify-between gap-3 py-2">
            <div>
              <Link to={`/projects/${i.projectId}`} className="font-medium hover:underline">{i.name}</Link>
              <p className="text-ink-soft">{i.reason}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs">
              <span className="tabular text-ink-mute">{fmtDateTime(i.lastRunAt)}</span>
              <ExternalLink href={i.lastRunUrl}>실행 이력</ExternalLink>
              <StatusBadge status={i.status} />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function ReportPage() {
  const { date } = useParams();
  const q = useQuery({ queryKey: ['report', date], queryFn: () => get<ReportResponse>(`/api/reports/daily?date=${date}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox message={errorMessage(q.error)} />;
  const r = q.data!.report;
  return (
    <>
      <PageHeader title={`운영 보고서 ${date}`} description="카카오톡으로 보낸 요약의 전체 내용입니다." />
      {!r ? (
        <EmptyState title="이 날짜의 보고서가 없습니다.">알림 화면에서 미리보기를 하거나 07:00 이후 다시 확인하세요.</EmptyState>
      ) : (
        <div className="space-y-4">
          {r.report.isSample && <Notice tone="warn">샘플 데이터로 생성된 보고서입니다.</Notice>}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'fail' : 'neutral'}>{r.status === 'sent' ? '카카오 발송 완료' : r.status === 'failed' ? '카카오 발송 실패' : r.status}</Badge>
            <span className="tabular text-ink-soft">생성 {fmtDateTime(r.generatedAt)} · 실제 발송 {fmtDateTime(r.sentAt)} · 시도 {r.attemptCount}회</span>
            {r.safeErrorMessage && <span className="text-xs text-fail-ink">{r.safeErrorMessage}</span>}
          </div>
          <div className="tabular grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              ['전체', r.report.counts.total, ''],
              ['정상', r.report.counts.NORMAL, 'text-ok-ink'],
              ['실패', r.report.counts.FAILED, 'text-fail-ink'],
              ['확인 필요', r.report.counts.ATTENTION, 'text-warn-ink'],
              ['확인 불가', r.report.counts.UNKNOWN, 'text-neutral-ink'],
            ].map(([l, v, c]) => (
              <div key={String(l)} className="rounded-lg border border-line bg-surface px-4 py-3">
                <p className="text-xs text-ink-mute">{l}</p>
                <p className={`text-2xl font-semibold ${c}`}>{v}</p>
              </div>
            ))}
          </div>
          <Panel title={r.report.analysisKind === 'ai' ? '🧠 AI 분석 (Claude Routine)' : '🧭 자동 점검 요약 (규칙 기반)'}>
            <p className="text-sm whitespace-pre-wrap">{r.report.analysis}</p>
            {r.report.globalIssues.length > 0 && <p className="mt-2 text-xs text-warn-ink">전역 이슈: {r.report.globalIssues.join(' / ')}</p>}
          </Panel>
          <Section title="🔴 실패" items={r.report.failed} />
          <Section title="🟡 확인 필요" items={r.report.attention} />
          <Section title="⚪ 확인 불가" items={r.report.unknown} />
          <Section title="🟢 정상" items={r.report.normal} />
          <Panel title="카카오로 보낸 메시지">
            <pre className="text-xs whitespace-pre-wrap text-ink-soft">{r.renderedMessage}</pre>
          </Panel>
        </div>
      )}
      {q.data!.history.length > 0 && (
        <Panel title="최근 보고서" className="mt-4">
          <ul className="tabular flex flex-wrap gap-2 text-xs">
            {q.data!.history.map((h) => (
              <li key={h.report_date_local}>
                <Link to={`/reports/${h.report_date_local}`} className="rounded-md border border-line px-2 py-1 hover:bg-neutral-soft">
                  {h.report_date_local} · {h.status}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
