import { DAILY_REPORT_CATCHUP_END_HOUR, DAILY_REPORT_HOUR, DEFAULT_TIMEZONE, SEVERITY_RANK } from '../../../../shared/constants';
import type { AppDeps, Env } from '../../env';
import { all, first, run, type Db } from '../../lib/db';
import { localDateString, localParts } from '../../lib/time';
import { acquireLock, getNotificationSettings, releaseLock } from '../../repositories/common';
import { getIntegration } from '../../repositories/integrations';
import { randomToken } from '../../security/crypto';
import type { IncidentTransition } from '../incidents/engine';
import { recordNotification, sendKakaoMessages, type DeliveryResult } from '../kakao/service';
import { evaluateAll } from '../monitoring/evaluate';
import { buildDailyReport, renderKakaoMessages, type DailyReport } from './report';

export const MAX_DAILY_ATTEMPTS = 3;

export interface DailyRunResult {
  action: 'skipped' | 'sent' | 'failed' | 'generated';
  reason?: string;
  reportDate: string;
  delivery?: DeliveryResult;
}

function baseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
}

async function globalIssues(env: Env, db: Db): Promise<string[]> {
  const rows = await all<{ title: string }>(
    db,
    `SELECT title FROM incidents WHERE project_id IS NULL AND status IN ('open','acknowledged') ORDER BY last_seen_at DESC LIMIT 5`,
  );
  const issues = rows.map((r) => r.title);
  const gh = await getIntegration(db, 'github');
  if (!gh || gh.status === 'not_connected') issues.push('GitHub 미연결');
  if (env.APP_MODE !== 'demo' && !env.KAKAO_REST_API_KEY) issues.push('카카오 앱 키 미설정');
  return [...new Set(issues)];
}

/** 최근 24시간 안에 실제 완료된 Claude Routine 분석만 'AI 분석'으로 쓴다. */
async function latestAiAnalysis(db: Db, now: Date): Promise<string | null> {
  const row = await first<{ summary: string | null }>(
    db,
    `SELECT summary FROM maintenance_jobs WHERE analysis_kind='claude_routine' AND status IN ('completed','needs_review')
       AND summary IS NOT NULL AND completed_at > ? ORDER BY completed_at DESC LIMIT 1`,
    new Date(now.getTime() - 86400_000).toISOString(),
  );
  return row?.summary ?? null;
}

export async function generateReport(env: Env, db: Db, deps: AppDeps, reportDate: string): Promise<{ report: DailyReport; messages: string[] }> {
  const now = deps.now();
  const tz = env.APP_TIMEZONE || DEFAULT_TIMEZONE;
  const { evaluations } = await evaluateAll(db, now);
  const runIds = evaluations.map((e) => e.classification.lastRun?.id).filter((x): x is number => typeof x === 'number');
  const urls = new Map<number, string | null>();
  if (runIds.length) {
    const rows = await all<{ id: number; external_url: string | null }>(
      db,
      `SELECT id, external_url FROM runs WHERE id IN (${runIds.map(() => '?').join(',')})`,
      ...runIds,
    );
    for (const r of rows) urls.set(r.id, r.external_url);
  }
  const report = buildDailyReport(evaluations, {
    reportDate,
    now,
    timezone: tz,
    globalIssues: await globalIssues(env, db),
    aiAnalysis: await latestAiAnalysis(db, now),
    isSample: env.APP_MODE === 'demo',
    runUrls: urls,
  });
  return { report, messages: renderKakaoMessages(report, now) };
}

/**
 * 07:00 KST 정기 보고서.
 * - cron은 10분마다 실행되며, 07:00~12:00 KST 사이에 아직 보내지 않은 날짜만 처리한다(지연 복구).
 * - report_date_local UNIQUE + 상태로 같은 날 중복 발송을 막는다.
 * - 실패 시 다음 cron(10분 후)에 재시도, 최대 3회.
 */
export async function runDailyReport(
  env: Env,
  db: Db,
  deps: AppDeps,
  opts: { trigger: 'cron' | 'manual' },
): Promise<DailyRunResult> {
  const now = deps.now();
  const tz = env.APP_TIMEZONE || DEFAULT_TIMEZONE;
  const reportDate = localDateString(now, tz);
  const hour = localParts(now, tz).hour;

  if (opts.trigger === 'cron') {
    if (hour < DAILY_REPORT_HOUR || hour >= DAILY_REPORT_CATCHUP_END_HOUR) return { action: 'skipped', reason: '발송 시간대 아님', reportDate };
    const settings = await getNotificationSettings(db);
    if (!settings.dailyReportEnabled) return { action: 'skipped', reason: '정기 보고서 꺼짐', reportDate };
  }

  const existing = await first<{ status: string; attempt_count: number; generated_at: string }>(
    db,
    `SELECT status, attempt_count, generated_at FROM daily_reports WHERE report_date_local = ?`,
    reportDate,
  );
  if (existing?.status === 'sent') return { action: 'skipped', reason: '이미 발송함', reportDate };
  if (existing && existing.attempt_count >= MAX_DAILY_ATTEMPTS && opts.trigger === 'cron')
    return { action: 'skipped', reason: '재시도 횟수 초과', reportDate };

  const holder = randomToken(8);
  if (!(await acquireLock(db, 'daily-report', holder, now, 300))) return { action: 'skipped', reason: '다른 실행이 진행 중', reportDate };
  try {
    const { report, messages } = await generateReport(env, db, deps, reportDate);
    const rendered = messages.join('\n\n────────\n\n');
    await run(
      db,
      `INSERT INTO daily_reports (report_date_local, timezone, report_json, rendered_message, status, attempt_count, generated_at)
       VALUES (?,?,?,?,'sending',1,?)
       ON CONFLICT(report_date_local) DO UPDATE SET report_json=excluded.report_json, rendered_message=excluded.rendered_message,
         status='sending', attempt_count=daily_reports.attempt_count+1, generated_at=excluded.generated_at
       WHERE daily_reports.status != 'sent'`,
      reportDate,
      tz,
      JSON.stringify(report),
      rendered,
      now.toISOString(),
    );
    const link = `${baseUrl(env)}/reports/${reportDate}`;
    const delivery = await sendKakaoMessages(env, db, deps, messages, link);
    const sentAt = deps.now();
    const ok = delivery.status === 'SENT';
    const terminal = delivery.status === 'REAUTH_REQUIRED' || delivery.status === 'NOT_CONFIGURED' || delivery.status === 'DEMO_SKIPPED';
    await run(
      db,
      `UPDATE daily_reports SET status=?, sent_at=?, provider_message_id=?, safe_error_message=?,
         attempt_count = CASE WHEN ? THEN ? ELSE attempt_count END
       WHERE report_date_local=?`,
      ok ? 'sent' : delivery.status === 'DEMO_SKIPPED' ? 'skipped' : 'failed',
      ok || delivery.status === 'PARTIAL' ? sentAt.toISOString() : null,
      delivery.responseCode,
      ok ? null : delivery.detail,
      terminal ? 1 : 0,
      MAX_DAILY_ATTEMPTS,
      reportDate,
    );
    await recordNotification(db, sentAt, {
      type: 'daily_report',
      dedupeKey: `daily:${reportDate}`,
      result: delivery,
      summary: messages[0] ?? '',
    });
    return { action: ok ? 'sent' : 'failed', reportDate, delivery };
  } finally {
    await releaseLock(db, 'daily-report', holder);
  }
}

/**
 * 장애 즉시 알림. 새 high 이상 장애·심각도 상승·복구만 보낸다. 같은 fingerprint는 쿨다운을 적용한다.
 * 여러 전환은 한 메시지로 묶어 호출량을 줄인다.
 */
export async function dispatchInstantAlerts(env: Env, db: Db, deps: AppDeps, transitions: IncidentTransition[]): Promise<number> {
  if (transitions.length === 0) return 0;
  const settings = await getNotificationSettings(db);
  if (!settings.instantAlertsEnabled) return 0;
  const now = deps.now();
  const cooldownFrom = new Date(now.getTime() - settings.alertCooldownMinutes * 60_000).toISOString();
  const lines: string[] = [];
  const keys: string[] = [];
  for (const t of transitions) {
    const sev = t.incident.severity;
    const important = SEVERITY_RANK[sev] >= SEVERITY_RANK.high;
    if (!important) continue;
    const key = `alert:${t.incident.fingerprint}:${t.kind}`;
    const recent = await first<{ id: number }>(
      db,
      `SELECT id FROM notification_deliveries WHERE dedupe_key=? AND status='sent' AND created_at > ?`,
      key,
      cooldownFrom,
    );
    if (recent) continue;
    const icon = t.kind === 'resolved' ? '✅ 복구' : t.kind === 'escalated' ? '⏫ 악화' : '🔴 신규';
    lines.push(`${icon} ${t.incident.title}`.slice(0, 80));
    keys.push(key);
  }
  if (lines.length === 0) return 0;
  const text = (`🚨 AI Automation HQ 장애 알림\n` + lines.slice(0, 3).join('\n') + (lines.length > 3 ? `\n외 ${lines.length - 3}건` : '')).slice(0, 200);
  const delivery = await sendKakaoMessages(env, db, deps, [text], `${baseUrl(env)}/incidents`);
  for (const key of keys) {
    await recordNotification(db, deps.now(), { type: 'incident_alert', dedupeKey: key, result: delivery, summary: text });
  }
  return delivery.status === 'SENT' ? lines.length : 0;
}

export async function sendTestMessage(env: Env, db: Db, deps: AppDeps): Promise<DeliveryResult> {
  const now = deps.now();
  const text = `✅ AI Automation HQ 테스트 메시지\n카카오톡 나에게 보내기 연결이 정상입니다.\n(정기 보고서와 별도로 기록됩니다)`;
  const delivery = await sendKakaoMessages(env, db, deps, [text], `${baseUrl(env)}/notifications`);
  await recordNotification(db, now, { type: 'test', dedupeKey: null, result: delivery, summary: text });
  return delivery;
}

export async function getDailyReport(db: Db, date?: string) {
  const row = date
    ? await first<Record<string, unknown>>(db, `SELECT * FROM daily_reports WHERE report_date_local = ?`, date)
    : await first<Record<string, unknown>>(db, `SELECT * FROM daily_reports ORDER BY report_date_local DESC LIMIT 1`);
  if (!row) return null;
  return {
    reportDate: row.report_date_local as string,
    status: row.status as string,
    attemptCount: row.attempt_count as number,
    generatedAt: row.generated_at as string,
    sentAt: row.sent_at as string | null,
    safeErrorMessage: row.safe_error_message as string | null,
    renderedMessage: row.rendered_message as string,
    report: JSON.parse(row.report_json as string) as DailyReport,
  };
}

export async function listDailyReports(db: Db, limit = 30) {
  return all<{ report_date_local: string; status: string; sent_at: string | null; attempt_count: number; safe_error_message: string | null }>(
    db,
    `SELECT report_date_local, status, sent_at, attempt_count, safe_error_message FROM daily_reports ORDER BY report_date_local DESC LIMIT ?`,
    limit,
  );
}
