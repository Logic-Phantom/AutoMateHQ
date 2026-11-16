import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RUN_STATUS_LABEL, type RunStatus } from '@shared/constants';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import type { RunRow } from '@/types/api';
import { CHART, ChartTooltip, Legend } from './charts';
import { EmptyState } from './ui';

/** 실행 소요 시간 추이(단일 시리즈 선 + 실패 회차 마커). 선 2px, 마커 8px + 2px 표면 링. */
export function RunDurationChart({ runs }: { runs: RunRow[] }) {
  const data = runs
    .filter((r) => r.startedAt && typeof r.durationSeconds === 'number')
    .slice()
    .reverse()
    .map((r) => ({ t: r.startedAt!, minutes: Math.round(((r.durationSeconds ?? 0) / 60) * 10) / 10, status: r.status, seconds: r.durationSeconds ?? 0 }));
  if (data.length < 2) return <EmptyState title="소요 시간을 그릴 완료된 실행이 부족합니다.">완료된 실행이 2회 이상 쌓이면 추이가 표시됩니다.</EmptyState>;
  return (
    <div>
      <div className="h-48" role="img" aria-label={`최근 실행 ${data.length}회의 소요 시간(분) 추이`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis dataKey="t" tickFormatter={(v: string) => fmtDateTime(v).slice(0, 6)} tickLine={false} axisLine={{ stroke: CHART.axis }} tick={{ fill: CHART.inkMute, fontSize: 11 }} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} tick={{ fill: CHART.inkMute, fontSize: 11 }} width={40} unit="분" />
            <Tooltip
              cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                return (
                  <ChartTooltip
                    active={active && Boolean(p)}
                    label={p ? fmtDateTime(p.t) : undefined}
                    rows={p ? [{ name: RUN_STATUS_LABEL[p.status as RunStatus] ?? p.status, value: fmtDuration(p.seconds), color: p.status === 'failure' ? CHART.critical : CHART.series1 }] : []}
                  />
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="minutes"
              name="소요 시간"
              stroke={CHART.series1}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; index?: number; payload?: { status: string } }) =>
                props.payload?.status === 'failure' ? (
                  <circle key={props.index} cx={props.cx} cy={props.cy} r={4} fill={CHART.critical} stroke={CHART.surface} strokeWidth={2} />
                ) : (
                  <g key={props.index} />
                )
              }
              activeDot={{ r: 4, fill: CHART.series1, stroke: CHART.surface, strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2">
        <Legend items={[{ label: '소요 시간(분)', color: CHART.series1 }, { label: '실패한 회차', color: CHART.critical }]} />
      </div>
    </div>
  );
}
