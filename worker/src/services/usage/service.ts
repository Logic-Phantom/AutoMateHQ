import { all, run, type Db } from '../../lib/db';

/**
 * 비용·사용량 원장.
 * - GitHub Actions 실행 시간: run의 시작/종료 시각 차이(벽시계 시간). GitHub 과금 분과 다를 수 있어 '실행 시간'으로만 표시한다.
 * - Claude Code 구독 사용량·Anthropic API 비용: 공식 제공 값이 없으면 UNAVAILABLE. 호출 수로 비용을 추정하지 않는다.
 * - 수동 입력은 MANUAL.
 */
export async function usageSummary(db: Db, fromDate: string, toDate: string) {
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso = `${toDate}T23:59:59.999Z`;
  const runStats = await all<{ project_id: number; name: string; source_type: string; runs: number; failures: number; seconds: number | null }>(
    db,
    `SELECT r.project_id, p.name, r.source_type, COUNT(*) AS runs, SUM(CASE WHEN r.status='failure' THEN 1 ELSE 0 END) AS failures,
       SUM(r.duration_seconds) AS seconds
     FROM runs r JOIN projects p ON p.id = r.project_id
     WHERE r.started_at BETWEEN ? AND ? GROUP BY r.project_id, r.source_type ORDER BY p.name`,
    fromIso,
    toIso,
  );
  const records = await all<{
    id: number;
    project_id: number | null;
    project_name: string | null;
    provider: string;
    metric_name: string;
    metric_value: number | null;
    unit: string;
    amount: number | null;
    currency: string | null;
    value_source: string;
    period_start: string;
    period_end: string;
    recorded_at: string;
  }>(
    db,
    `SELECT u.*, p.name AS project_name FROM usage_records u LEFT JOIN projects p ON p.id = u.project_id
     WHERE u.period_end >= ? AND u.period_start <= ? ORDER BY u.period_start DESC, u.id DESC LIMIT 500`,
    fromDate,
    toDate,
  );
  const totalsByCurrency: Record<string, { amount: number; sources: string[] }> = {};
  for (const r of records) {
    if (r.amount === null || !r.currency || r.value_source === 'UNAVAILABLE') continue;
    const t = (totalsByCurrency[r.currency] ??= { amount: 0, sources: [] });
    t.amount += r.amount;
    if (!t.sources.includes(r.value_source)) t.sources.push(r.value_source);
  }
  return {
    period: { from: fromDate, to: toDate },
    githubActions: runStats
      .filter((s) => s.source_type === 'github_actions')
      .map((s) => ({ projectId: s.project_id, projectName: s.name, runs: s.runs, failures: s.failures, wallSeconds: s.seconds ?? 0, valueSource: 'ACTUAL' as const })),
    heartbeat: runStats
      .filter((s) => s.source_type === 'heartbeat')
      .map((s) => ({ projectId: s.project_id, projectName: s.name, runs: s.runs, failures: s.failures, wallSeconds: s.seconds ?? 0, valueSource: 'ACTUAL' as const })),
    records: records.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      provider: r.provider,
      metricName: r.metric_name,
      metricValue: r.metric_value,
      unit: r.unit,
      amount: r.amount,
      currency: r.currency,
      valueSource: r.value_source,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      recordedAt: r.recorded_at,
    })),
    totalsByCurrency,
    unavailable: [
      { provider: 'anthropic', item: 'Claude Code 구독 사용량', reason: '공식 API로 제공되지 않음 — 확인 불가' },
      { provider: 'github', item: 'Actions 과금 분(billable minutes)', reason: '미연동 — 실행 시간(벽시계)만 표시' },
      { provider: 'cloudflare', item: 'Workers 요청/CPU', reason: '미연동 — Cloudflare 대시보드 값 수동 입력 가능' },
    ],
  };
}

export async function addManualUsage(
  db: Db,
  now: Date,
  input: {
    projectId: number | null;
    provider: string;
    metricName: string;
    metricValue: number | null;
    unit: string;
    amount: number | null;
    currency: string | null;
    periodStart: string;
    periodEnd: string;
    note?: string;
  },
) {
  const res = await run(
    db,
    `INSERT INTO usage_records (project_id, provider, metric_name, metric_value, unit, amount, currency, value_source, period_start,
       period_end, recorded_at, metadata_json) VALUES (?,?,?,?,?,?,?,'MANUAL',?,?,?,?)`,
    input.projectId,
    input.provider,
    input.metricName,
    input.metricValue,
    input.unit,
    input.amount,
    input.currency,
    input.periodStart,
    input.periodEnd,
    now.toISOString(),
    JSON.stringify({ note: input.note ?? '' }),
  );
  return res.meta.last_row_id;
}
