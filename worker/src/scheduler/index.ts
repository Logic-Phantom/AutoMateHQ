import type { AppDeps, Env } from '../env';
import { acquireLock, housekeeping, releaseLock } from '../repositories/common';
import { randomToken } from '../security/crypto';
import { redact } from '../security/redact';
import { syncGithubProjects } from '../services/github/service';
import { evaluateAll } from '../services/monitoring/evaluate';
import { dispatchInstantAlerts, runDailyReport } from '../services/reporting/daily';

/**
 * Cloudflare Cron(10분마다, UTC 기준) 한 번에 수행하는 작업.
 * 각 단계는 독립적으로 실패해도 다음 단계를 계속하고, Worker가 무한 재시도하지 않도록 예외를 삼킨다(로그만 남김).
 * 무료 플랜 한도(호출당 subrequest 50·D1 쿼리 50)를 고려해 GitHub 동기화는 회당 3개 프로젝트만 처리한다.
 */
export async function runScheduledTick(env: Env, deps: AppDeps, scheduledTime: number): Promise<Record<string, unknown>> {
  const db = env.DB;
  const now = deps.now();
  const holder = randomToken(8);
  const summary: Record<string, unknown> = { scheduledTime: new Date(scheduledTime).toISOString() };
  if (!(await acquireLock(db, 'scheduler-tick', holder, now, 8 * 60))) return { ...summary, skipped: 'previous tick running' };

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      summary[name] = await fn();
    } catch (err) {
      summary[name] = { error: redact((err as Error)?.message ?? String(err)) };
      console.error(`scheduler_step_failed:${name}`, summary[name]);
    }
  };

  try {
    if (env.APP_MODE !== 'demo') await step('githubSync', () => syncGithubProjects(env, db, deps, { maxProjects: 3 }));
    let transitions: Awaited<ReturnType<typeof evaluateAll>>['transitions'] = [];
    await step('evaluate', async () => {
      const r = await evaluateAll(db, deps.now());
      transitions = r.transitions;
      return { projects: r.evaluations.length, transitions: r.transitions.length };
    });
    await step('dailyReport', () => runDailyReport(env, db, deps, { trigger: 'cron' }));
    await step('alerts', () => dispatchInstantAlerts(env, db, deps, transitions));
    if (new Date(scheduledTime).getUTCMinutes() < 10) await step('housekeeping', () => housekeeping(db, deps.now()));
  } finally {
    await releaseLock(db, 'scheduler-tick', holder);
  }
  console.info('scheduler_tick', JSON.stringify(summary));
  return summary;
}
