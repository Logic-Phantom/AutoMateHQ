import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { VALUE_SOURCE_LABEL, type ValueSource } from '@shared/constants';
import { CHART, ChartTooltip } from '@/components/charts';
import { errorMessage, get, post } from '@/lib/api';
import { fmtDuration, fmtNumber } from '@/lib/format';
import { Badge, Button, EmptyState, ErrorBox, Field, inputCls, Loading, Modal, PageHeader, Panel, Table, Td, type Tone } from '@/components/ui';

interface Summary {
  period: { from: string; to: string };
  githubActions: { projectId: number; projectName: string; runs: number; failures: number; wallSeconds: number; valueSource: ValueSource }[];
  heartbeat: { projectId: number; projectName: string; runs: number; failures: number; wallSeconds: number; valueSource: ValueSource }[];
  records: { id: number; projectName: string | null; provider: string; metricName: string; metricValue: number | null; unit: string; amount: number | null; currency: string | null; valueSource: ValueSource; periodStart: string; periodEnd: string }[];
  totalsByCurrency: Record<string, { amount: number; sources: string[] }>;
  unavailable: { provider: string; item: string; reason: string }[];
}

const SOURCE_TONE: Record<ValueSource, Tone> = { ACTUAL: 'ok', ESTIMATED: 'warn', MANUAL: 'brand', UNAVAILABLE: 'neutral' };
const SourceBadge = ({ s }: { s: ValueSource }) => <Badge tone={SOURCE_TONE[s]}>{VALUE_SOURCE_LABEL[s]}</Badge>;

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

export function UsagePage() {
  const qc = useQueryClient();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));
  const [open, setOpen] = useState(false);
  const summary = useQuery({ queryKey: ['usage', from, to], queryFn: () => get<Summary>(`/api/usage/summary?from=${from}&to=${to}`) });
  const add = useMutation({
    mutationFn: (v: Record<string, unknown>) => post('/api/usage/manual-record', v),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : null);
    add.mutate({
      provider: String(f.get('provider')),
      metricName: String(f.get('metricName')),
      metricValue: num('metricValue'),
      unit: String(f.get('unit') ?? ''),
      amount: num('amount'),
      currency: f.get('currency') ? String(f.get('currency')).toUpperCase() : null,
      periodStart: String(f.get('periodStart')),
      periodEnd: String(f.get('periodEnd')),
      note: String(f.get('note') ?? ''),
    });
  };

  return (
    <>
      <PageHeader
        title="비용·사용량"
        description="제공자가 준 실제 값, 계산식이 있는 추정치, 수동 입력, 확인 불가를 구분합니다."
        actions={<Button variant="primary" onClick={() => setOpen(true)}>수동 기록 추가</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <label className="flex items-center gap-1 text-xs text-ink-soft">시작 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} w-auto`} /></label>
        <label className="flex items-center gap-1 text-xs text-ink-soft">종료 <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputCls} w-auto`} /></label>
      </div>
      {summary.isLoading ? (
        <Loading />
      ) : summary.error ? (
        <ErrorBox message={errorMessage(summary.error)} />
      ) : (
        <div className="space-y-4">
          <Panel title="GitHub Actions 실행 시간(벽시계 기준, 과금 분 아님)">
            {!summary.data!.githubActions.length ? (
              <EmptyState title="기간 내 GitHub Actions 실행이 없습니다." />
            ) : (
              <>
              <div className="mb-4" style={{ height: Math.max(120, summary.data!.githubActions.length * 34 + 24) }} role="img" aria-label="프로젝트별 GitHub Actions 실행 시간(분)">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={[...summary.data!.githubActions].sort((a, b) => b.wallSeconds - a.wallSeconds).map((r) => ({ name: r.projectName, minutes: Math.round(r.wallSeconds / 6) / 10, runs: r.runs }))}
                    margin={{ top: 4, right: 48, left: 8, bottom: 0 }}
                  >
                    <CartesianGrid horizontal={false} stroke={CHART.grid} />
                    <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: CHART.inkMute, fontSize: 11 }} unit="분" />
                    <YAxis type="category" dataKey="name" width={150} tickLine={false} axisLine={{ stroke: CHART.axis }} tick={{ fill: CHART.inkSoft, fontSize: 12 }} />
                    <Tooltip
                      cursor={{ fill: 'rgba(28,27,25,0.04)' }}
                      content={({ active, payload }) => {
                        const p = payload?.[0]?.payload as { name: string; minutes: number; runs: number } | undefined;
                        return <ChartTooltip active={active && Boolean(p)} label={p?.name} rows={p ? [{ name: '실행 시간', value: `${p.minutes}분`, color: CHART.series1 }, { name: '실행 횟수', value: `${p.runs}회`, color: CHART.axis }] : []} />;
                      }}
                    />
                    <Bar dataKey="minutes" fill={CHART.series1} maxBarSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false} label={{ position: 'right', fill: CHART.inkSoft, fontSize: 11, formatter: (v: unknown) => `${v}분` }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table head={['프로젝트', '실행', '실패', '실행 시간', '출처']}>
                {summary.data!.githubActions.map((r) => (
                  <tr key={r.projectId}>
                    <Td>{r.projectName}</Td>
                    <Td className="tabular">{fmtNumber(r.runs)}</Td>
                    <Td className="tabular">{fmtNumber(r.failures)}</Td>
                    <Td className="tabular">{fmtDuration(r.wallSeconds)}</Td>
                    <Td><SourceBadge s={r.valueSource} /></Td>
                  </tr>
                ))}
              </Table>
              </>
            )}
          </Panel>
          {summary.data!.heartbeat.length > 0 && (
            <Panel title="Heartbeat 자동화 실행">
              <Table head={['프로젝트', '실행', '실패', '실행 시간']}>
                {summary.data!.heartbeat.map((r) => (
                  <tr key={r.projectId}>
                    <Td>{r.projectName}</Td>
                    <Td className="tabular">{r.runs}</Td>
                    <Td className="tabular">{r.failures}</Td>
                    <Td className="tabular">{fmtDuration(r.wallSeconds)}</Td>
                  </tr>
                ))}
              </Table>
            </Panel>
          )}
          <Panel title="기록된 비용·사용량">
            {Object.keys(summary.data!.totalsByCurrency).length > 0 && (
              <div className="mb-3 flex flex-wrap gap-3 text-sm">
                {Object.entries(summary.data!.totalsByCurrency).map(([cur, t]) => (
                  <span key={cur} className="tabular rounded-md bg-neutral-soft px-2 py-1">
                    합계 {fmtNumber(Math.round(t.amount * 100) / 100)} {cur} ({t.sources.map((s) => VALUE_SOURCE_LABEL[s as ValueSource]).join('·')})
                  </span>
                ))}
              </div>
            )}
            {!summary.data!.records.length ? (
              <EmptyState title="기록이 없습니다.">Cloudflare·Anthropic 청구서 값 등을 수동으로 기록할 수 있습니다.</EmptyState>
            ) : (
              <Table head={['기간', '제공자', '항목', '값', '금액', '출처']}>
                {summary.data!.records.map((r) => (
                  <tr key={r.id}>
                    <Td className="tabular whitespace-nowrap text-xs">{r.periodStart} ~ {r.periodEnd}</Td>
                    <Td>{r.provider}{r.projectName && <div className="text-xs text-ink-mute">{r.projectName}</div>}</Td>
                    <Td>{r.metricName}</Td>
                    <Td className="tabular">{r.metricValue === null ? '-' : `${fmtNumber(r.metricValue)} ${r.unit}`}</Td>
                    <Td className="tabular">{r.amount === null ? '-' : `${fmtNumber(r.amount)} ${r.currency ?? ''}`}</Td>
                    <Td><SourceBadge s={r.valueSource} /></Td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
          <Panel title="확인 불가 항목">
            <ul className="space-y-1 text-sm">
              {summary.data!.unavailable.map((u) => (
                <li key={u.item} className="flex items-center gap-2"><SourceBadge s="UNAVAILABLE" /> {u.item} <span className="text-ink-mute">— {u.reason}</span></li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      <Modal open={open} title="수동 비용·사용량 기록" onClose={() => setOpen(false)}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="제공자">{(id) => <input id={id} name="provider" required placeholder="cloudflare / anthropic / github" className={inputCls} />}</Field>
            <Field label="항목">{(id) => <input id={id} name="metricName" required placeholder="monthly_invoice" className={inputCls} />}</Field>
            <Field label="값">{(id) => <input id={id} name="metricValue" type="number" step="any" className={inputCls} />}</Field>
            <Field label="단위">{(id) => <input id={id} name="unit" placeholder="requests / min" className={inputCls} />}</Field>
            <Field label="금액">{(id) => <input id={id} name="amount" type="number" step="any" className={inputCls} />}</Field>
            <Field label="통화(ISO)">{(id) => <input id={id} name="currency" maxLength={3} placeholder="KRW / USD" className={inputCls} />}</Field>
            <Field label="기간 시작">{(id) => <input id={id} name="periodStart" type="date" required defaultValue={from} className={inputCls} />}</Field>
            <Field label="기간 종료">{(id) => <input id={id} name="periodEnd" type="date" required defaultValue={to} className={inputCls} />}</Field>
          </div>
          <Field label="메모">{(id) => <input id={id} name="note" className={inputCls} />}</Field>
          {add.error && <ErrorBox message={errorMessage(add.error)} />}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>취소</Button>
            <Button type="submit" variant="primary" loading={add.isPending}>저장</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
