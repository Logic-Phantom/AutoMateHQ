import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CATEGORY_LABEL, INTEGRATION_STATUS_LABEL, RUN_STATUS_LABEL, SEVERITY_LABEL, type ProjectCategory, type RunStatus } from '@shared/constants';
import { get, errorMessage } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import type { OverviewDto, RunRow } from '@/types/api';
import { CHART, ChartTooltip, Legend, RunStrip, SegmentedBar, Sparkline, STATUS_COLOR, STRIP_LEGEND, type StripCell } from '@/components/charts';
import { Badge, Button, EmptyState, ErrorBox, ExternalLink, integrationTone, Loading, PageHeader, Panel, runTone, STATUS_META, StatusBadge, cx } from '@/components/ui';

interface StatsDto {
  dates: string[];
  daily: { date: string; success: number; failure: number; other: number }[];
  projects: { id: number; name: string; cells: StripCell[] }[];
}

const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function StatTile({ label, value, sub, trend, trendLabel, trendColor }: { label: string; value: number; sub?: string; trend?: number[]; trendLabel?: string; trendColor?: string }) {
  return (
    <div className="flex items-end justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
      <div>
        <p className="text-[13px] font-medium text-ink-mute">{label}</p>
        <p className="mt-1 text-[28px] leading-none font-semibold text-ink">{value.toLocaleString('ko-KR')}</p>
        {sub && <p className="mt-1.5 text-xs text-ink-mute">{sub}</p>}
      </div>
      {trend && <Sparkline values={trend} label={trendLabel ?? label} color={trendColor} />}
    </div>
  );
}

export function OverviewPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => get<OverviewDto>('/api/overview'), refetchInterval: 60_000 });
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => get<StatsDto>('/api/overview/stats?days=14'), refetchInterval: 120_000 });
  const timeline = useQuery({ queryKey: ['timeline'], queryFn: () => get<RunRow[]>('/api/overview/timeline'), refetchInterval: 60_000 });

  if (overview.isLoading) return <Loading />;
  if (overview.error) return <ErrorBox message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />;
  const d = overview.data!;
  const active = d.projects.filter((p) => p.isActive);
  const upcoming = active.filter((p) => p.nextExpectedAt).sort((a, b) => a.nextExpectedAt!.localeCompare(b.nextExpectedAt!)).slice(0, 5);
  const order: Record<string, number> = { FAILED: 0, ATTENTION: 1, UNKNOWN: 2, NORMAL: 3 };
  const daily = stats.data?.daily ?? [];
  const strips = new Map((stats.data?.projects ?? []).map((p) => [p.id, p.cells]));
  const runsTrend = daily.map((x) => x.success + x.failure + x.other);
  const failTrend = daily.map((x) => x.failure);
  const statusParts = (['NORMAL', 'FAILED', 'ATTENTION', 'UNKNOWN'] as const).map((s) => ({
    key: s,
    label: STATUS_META[s].label,
    value: { NORMAL: d.kpi.normal, FAILED: d.kpi.failed, ATTENTION: d.kpi.attention, UNKNOWN: d.kpi.unknown }[s],
    color: STATUS_COLOR[s]!,
  }));
  const total14 = runsTrend.reduce((a, b) => a + b, 0);
  const fail14 = failTrend.reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title="운영 현황"
        description={`${fmtDateTime(d.generatedAt)} 기준 · 모든 시간은 한국 시간`}
        actions={
          <Button onClick={() => void Promise.all([overview.refetch(), stats.refetch(), timeline.refetch()])} loading={overview.isFetching}>
            <RefreshCw className="size-3.5" aria-hidden /> 새로고침
          </Button>
        }
      />

      {/* 1행: 상태 분포 + 실행 통계 */}
      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
        <section className="rounded-lg border border-line bg-surface px-4 py-3.5" aria-label="프로젝트 상태 분포">
          <div className="flex items-baseline justify-between">
            <p className="text-[13px] font-medium text-ink-mute">활성 프로젝트</p>
            <Link to="/projects" className="text-xs text-brand-ink hover:underline">관리</Link>
          </div>
          <p className="mt-1 text-[28px] leading-none font-semibold">{d.kpi.activeProjects}</p>
          <div className="mt-3">
            <SegmentedBar parts={statusParts} label="프로젝트 상태 분포" height={10} />
          </div>
          <div className="mt-2.5">
            <Legend items={statusParts.map((p) => ({ label: p.label, color: p.color, value: p.value }))} />
          </div>
          {d.kpi.unknown > 0 && <p className="mt-2 text-xs text-ink-mute">확인 불가는 정상으로 세지 않습니다(연동 없음·데이터 부족).</p>}
        </section>
        <StatTile label="24시간 실행" value={d.kpi.runs24h} sub={`14일 합계 ${total14.toLocaleString('ko-KR')}회`} trend={runsTrend} trendLabel="최근 14일 일별 실행 수" />
        <StatTile label="24시간 실패" value={d.kpi.failures24h} sub={`14일 합계 ${fail14}회`} trend={failTrend} trendLabel="최근 14일 일별 실패 수" trendColor={CHART.critical} />
      </div>

      {/* 2행: 14일 추이 차트 + 사이드 */}
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel title="최근 14일 실행 결과" className="lg:col-span-2" actions={<Legend items={[{ label: '성공', color: CHART.good }, { label: '실패', color: CHART.critical }, { label: '기타(취소·건너뜀·진행)', color: CHART.neutral }]} />}>
          {stats.isLoading ? (
            <Loading />
          ) : total14 === 0 ? (
            <EmptyState title="최근 14일 실행 기록이 없습니다." />
          ) : (
            <div className="h-56" role="img" aria-label={`최근 14일 일별 실행 결과. ${daily.map((x) => `${short(x.date)} 성공 ${x.success} 실패 ${x.failure}`).join(', ')}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barCategoryGap="28%">
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="date" tickFormatter={short} tickLine={false} axisLine={{ stroke: CHART.axis }} tick={{ fill: CHART.inkMute, fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: CHART.inkMute, fontSize: 11 }} width={40} />
                  <Tooltip
                    cursor={{ fill: 'rgba(28,27,25,0.04)' }}
                    content={({ active, payload, label }) => (
                      <ChartTooltip
                        active={active}
                        label={label ? short(String(label)) : undefined}
                        rows={(payload ?? []).map((p) => ({ name: String(p.name), value: `${p.value}회`, color: String(p.color) }))}
                      />
                    )}
                  />
                  <Bar dataKey="success" name="성공" stackId="r" fill={CHART.good} maxBarSize={24} isAnimationActive={false} stroke={CHART.surface} strokeWidth={1} />
                  <Bar dataKey="failure" name="실패" stackId="r" fill={CHART.critical} maxBarSize={24} isAnimationActive={false} stroke={CHART.surface} strokeWidth={1} />
                  <Bar dataKey="other" name="기타" stackId="r" fill={CHART.neutral} maxBarSize={24} radius={[4, 4, 0, 0]} stroke={CHART.surface} strokeWidth={1} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title="오늘 07:00 카카오 보고서" actions={<Link to="/notifications" className="text-xs text-brand-ink hover:underline">설정</Link>}>
            {d.todayReport ? (
              <div className="space-y-1.5 text-sm">
                <Badge tone={d.todayReport.status === 'sent' ? 'ok' : d.todayReport.status === 'failed' ? 'fail' : 'neutral'}>
                  {d.todayReport.status === 'sent' ? '발송 완료' : d.todayReport.status === 'failed' ? '카카오 발송 실패' : d.todayReport.status === 'skipped' ? '샘플 모드(미발송)' : '처리 중'}
                </Badge>
                <p className="tabular text-ink-soft">실제 발송 {fmtDateTime(d.todayReport.sentAt)}</p>
                {d.todayReport.error && <p className="text-xs text-fail-ink">{d.todayReport.error}</p>}
                <Link to={`/reports/${d.todayReport.reportDate}`} className="inline-flex items-center gap-0.5 text-xs text-brand-ink hover:underline">보고서 보기 <ArrowUpRight className="size-3" /></Link>
              </div>
            ) : (
              <p className="text-sm text-ink-soft">아직 오늘 보고서가 없습니다. 07:00 이후 자동 발송됩니다.</p>
            )}
          </Panel>
          <Panel title="연결 상태">
            <ul className="space-y-2 text-sm">
              <ConnRow label="GitHub" status={d.integrations.find((i) => i.provider === 'github')?.status} />
              <li className="flex items-center justify-between">
                <span className="text-ink-soft">GitHub Webhook</span>
                <Badge tone={d.githubWebhookSecretConfigured ? 'ok' : 'neutral'}>{d.githubWebhookSecretConfigured ? '설정됨' : '미설정 · polling'}</Badge>
              </li>
              <ConnRow label="카카오톡" status={d.kakao.status} />
              <ConnRow
                label="Claude Routine"
                status={d.integrations.some((i) => i.provider === 'claude_routine' && i.status === 'connected') ? 'connected' : d.integrations.some((i) => i.provider === 'claude_routine') ? 'error' : 'not_connected'}
              />
            </ul>
          </Panel>
        </div>
      </div>

      {/* 3행: 프로젝트 상태 + 14일 스트립 */}
      <Panel title="프로젝트별 상태" className="mt-3" actions={<Legend items={STRIP_LEGEND} />}>
        {active.length === 0 ? (
          <EmptyState title="등록된 활성 프로젝트가 없습니다.">
            <Link to="/projects" className="text-brand-ink hover:underline">프로젝트를 등록</Link>하거나 <Link to="/settings" className="text-brand-ink hover:underline">온보딩 체크리스트</Link>를 확인하세요.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {[...active].sort((a, b) => order[a.status]! - order[b.status]!).map((p) => (
              <li key={p.id} className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,1.6fr)_auto]">
                <div className="min-w-0">
                  <Link to={`/projects/${p.id}`} className="block truncate text-sm font-medium hover:underline">{p.name}</Link>
                  <p className="truncate text-xs text-ink-mute">{CATEGORY_LABEL[p.category as ProjectCategory] ?? p.category} · 다음 {fmtDateTime(p.nextExpectedAt)}</p>
                </div>
                <StatusBadge status={p.status} />
                <p className="min-w-0 truncate text-[13px] text-ink-soft" title={p.reason ?? ''}>{p.reason ?? '-'}</p>
                <div className="flex items-center gap-3">
                  {strips.get(p.id) && <RunStrip cells={strips.get(p.id)!} name={p.name} />}
                  <span className="tabular w-14 text-right text-xs text-ink-mute">{fmtRelative(p.lastRunAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 4행: 장애·타임라인·예정 */}
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel title="미해결 장애" actions={<Link to="/incidents" className="text-xs text-brand-ink hover:underline">전체</Link>}>
          {d.openIncidents.length === 0 ? (
            <p className="text-sm text-ink-mute">미해결 장애가 없습니다.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {d.openIncidents.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-medium">{i.title}</p>
                    <p className="tabular text-xs text-ink-mute">최근 {fmtRelative(i.lastSeenAt)} · 반복 {i.occurrenceCount}회</p>
                  </div>
                  <Badge tone={i.severity === 'high' || i.severity === 'critical' ? 'fail' : 'warn'}>{SEVERITY_LABEL[i.severity]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="최근 실행" actions={<Link to="/runs" className="text-xs text-brand-ink hover:underline">전체</Link>}>
          {timeline.isLoading ? (
            <Loading />
          ) : !timeline.data?.length ? (
            <p className="text-sm text-ink-mute">실행 기록이 없습니다.</p>
          ) : (
            <ol className="relative space-y-2.5 border-l border-line pl-4 text-sm">
              {timeline.data.slice(0, 8).map((r) => (
                <li key={r.id} className="relative">
                  <span aria-hidden className={cx('absolute top-1.5 -left-[21px] size-2 rounded-full ring-2 ring-surface', r.status === 'success' ? 'bg-ok' : r.status === 'failure' ? 'bg-fail' : 'bg-neutral')} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{r.projectName}</span>
                    <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status as RunStatus] ?? r.status}</Badge>
                  </div>
                  <p className="tabular text-xs text-ink-mute">
                    {fmtDateTime(r.startedAt)} · {r.workflowName ?? r.sourceType} {r.externalUrl && <ExternalLink href={r.externalUrl}>원본</ExternalLink>}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="다음 예정 작업">
          {upcoming.length === 0 ? (
            <p className="text-sm text-ink-mute">예정된 실행이 없습니다.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {upcoming.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-2">
                  <span className="truncate">{p.name}</span>
                  <span className="tabular shrink-0 text-ink-soft">{fmtDateTime(p.nextExpectedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function ConnRow({ label, status }: { label: string; status: string | undefined }) {
  const s = status ?? 'not_connected';
  return (
    <li className="flex items-center justify-between">
      <span className="text-ink-soft">{label}</span>
      <Badge tone={integrationTone(s)}>{INTEGRATION_STATUS_LABEL[s as keyof typeof INTEGRATION_STATUS_LABEL] ?? s}</Badge>
    </li>
  );
}
