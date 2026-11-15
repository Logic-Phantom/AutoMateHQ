import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * 차트 공용 조각(dataviz 기준).
 * - 상태색(정상/실패/확인 필요/확인 불가)은 예약 색이며 항상 라벨·범례와 함께 쓴다.
 * - 텍스트는 시리즈 색을 입지 않는다(잉크 토큰만).
 * - 막대 끝 4px 라운드, 선 2px, 마커 8px + 2px 표면 링, 그리드는 1px 실선 헤어라인.
 */
export const CHART = {
  surface: '#fdfdfc',
  grid: '#e3e2dc',
  axis: '#c9c8c0',
  ink: '#1c1b19',
  inkSoft: '#52514e',
  inkMute: '#706e68',
  series1: '#2a78d6',
  series1Wash: 'rgba(42,120,214,0.10)',
  good: '#0ca30c',
  critical: '#d03b3b',
  warning: '#fab219',
  neutral: '#c9c8c0',
};

export const STATUS_COLOR: Record<string, string> = {
  NORMAL: CHART.good,
  FAILED: CHART.critical,
  ATTENTION: CHART.warning,
  UNKNOWN: CHART.neutral,
};

/** 범례 한 줄: 색 표시는 마크(점) 옆에, 텍스트는 잉크색 */
export function Legend({ items }: { items: { label: string; color: string; value?: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
          {i.value !== undefined && <span className="tabular font-medium text-ink">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/** 하나의 전체를 나눈 막대(얇은 형). 값이 0인 부분은 그리지 않는다. */
export function SegmentedBar({ parts, label, height = 8 }: { parts: { key: string; label: string; value: number; color: string }[]; label: string; height?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`} className="flex w-full gap-[2px]" style={{ height }}>
      {total === 0 ? (
        <div className="h-full w-full rounded-full bg-sunken" />
      ) : (
        visible.map((p, i) => (
          <div
            key={p.key}
            title={`${p.label} ${p.value}개 (${Math.round((p.value / total) * 100)}%)`}
            className={cx('h-full', i === 0 && 'rounded-l-full', i === visible.length - 1 && 'rounded-r-full')}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))
      )}
    </div>
  );
}

/** 작은 추세선(스파크라인). 단일 시리즈, 마지막 점만 강조. */
export function Sparkline({ values, color = CHART.series1, width = 96, height = 28, label }: { values: number[]; color?: string; width?: number; height?: number; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = (width - 6) / (values.length - 1);
  const pts = values.map((v, i) => [3 + i * step, height - 3 - (v / max) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg role="img" aria-label={`${label}: ${values.join(', ')}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={`${d} L${last[0]},${height - 3} L3,${height - 3} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={4} fill={color} stroke={CHART.surface} strokeWidth={2} />
    </svg>
  );
}

export interface StripCell {
  date: string;
  success: number;
  failure: number;
  other: number;
}

/** 프로젝트별 일자 스트립: 날짜마다 한 칸, 그날 결과를 상태색으로. 색만으로 구분하지 않도록 툴팁·범례를 함께 둔다. */
export function RunStrip({ cells, name }: { cells: StripCell[]; name: string }) {
  return (
    <div role="img" aria-label={`${name} 최근 ${cells.length}일 실행 결과`} className="flex gap-[2px]">
      {cells.map((c) => {
        const total = c.success + c.failure + c.other;
        const color = total === 0 ? CHART.grid : c.failure > 0 && c.success === 0 ? CHART.critical : c.failure > 0 ? CHART.warning : c.success > 0 ? CHART.good : CHART.neutral;
        const text =
          total === 0 ? '실행 없음' : `성공 ${c.success} · 실패 ${c.failure}${c.other ? ` · 기타 ${c.other}` : ''}${c.failure > 0 && c.success > 0 ? ' (실패 후 복구)' : ''}`;
        return <span key={c.date} title={`${c.date.slice(5).replace('-', '/')} ${text}`} className="h-5 w-[7px] rounded-[2px]" style={{ background: color }} />;
      })}
    </div>
  );
}

export const STRIP_LEGEND = [
  { label: '성공', color: CHART.good },
  { label: '실패 후 복구', color: CHART.warning },
  { label: '실패', color: CHART.critical },
  { label: '실행 없음', color: CHART.grid },
];

/** recharts 툴팁 내용 */
export function ChartTooltip({
  active,
  label,
  rows,
}: {
  active?: boolean;
  label?: ReactNode;
  rows: { name: string; value: ReactNode; color: string }[];
}) {
  if (!active) return null;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-[0_4px_16px_rgba(28,27,25,0.10)]">
      {label !== undefined && <p className="mb-1 font-medium text-ink">{label}</p>}
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-4 text-ink-soft">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: r.color }} />
              {r.name}
            </span>
            <span className="tabular font-medium text-ink">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
