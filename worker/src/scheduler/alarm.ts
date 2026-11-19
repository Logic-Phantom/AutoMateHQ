import { defaultDeps, type AppDeps, type Env } from '../env';
import { runScheduledTick } from './index';

/** 스케줄러 주기. 10분 경계(UTC 기준 :00, :10 …)에 맞춰 깨어나므로 08:00 KST 정각에도 실행된다. */
export const SCHEDULER_INTERVAL_MS = 10 * 60_000;

/** 주어진 시각 바로 다음의 10분 경계. 경계 정각이면 그다음 경계를 돌려준다. */
export function nextTickTime(nowMs: number): number {
  return (Math.floor(nowMs / SCHEDULER_INTERVAL_MS) + 1) * SCHEDULER_INTERVAL_MS;
}

interface AlarmStateLike {
  storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
  };
}

/**
 * Durable Object 알람으로 도는 내부 스케줄러.
 * GitHub Actions 예약 실행은 4~9시간씩 밀려 08:00 보고서를 맞출 수 없고, Cloudflare Cron은 계정 한도(5개)가 차 있다.
 * 알람은 Cron 한도와 무관하고 무료 플랜에서 쓸 수 있다. 작업이 실패해도 다음 알람은 반드시 다시 건다.
 */
export class SchedulerAlarm {
  private readonly state: AlarmStateLike;
  private readonly env: Env;
  private readonly deps: AppDeps;

  constructor(state: AlarmStateLike, env: Env, deps: AppDeps = defaultDeps) {
    this.state = state;
    this.env = env;
    this.deps = deps;
  }

  /** 알람이 없으면 건다. 이미 있으면 그대로 둔다. */
  async fetch(): Promise<Response> {
    let next = await this.state.storage.getAlarm();
    if (next === null) {
      next = nextTickTime(this.deps.now().getTime());
      await this.state.storage.setAlarm(next);
    }
    return Response.json({ nextAlarmAt: new Date(next).toISOString() });
  }

  async alarm(): Promise<void> {
    const slot = Math.floor(this.deps.now().getTime() / SCHEDULER_INTERVAL_MS) * SCHEDULER_INTERVAL_MS;
    try {
      await runScheduledTick(this.env, this.deps, slot);
    } catch (err) {
      console.error('scheduler_alarm_failed', (err as Error)?.message ?? String(err));
    } finally {
      await this.state.storage.setAlarm(nextTickTime(this.deps.now().getTime()));
    }
  }
}

/** 운영 Worker에서 알람이 걸려 있는지 확인한다. 샘플 모드에는 바인딩이 없어 아무 일도 하지 않는다. */
export async function ensureSchedulerAlarm(env: Env): Promise<boolean> {
  if (env.APP_MODE !== 'live' || !env.SCHEDULER_ALARM) return false;
  const stub = env.SCHEDULER_ALARM.get(env.SCHEDULER_ALARM.idFromName('main'));
  const res = await stub.fetch('https://scheduler-alarm.internal/ensure');
  return res.ok;
}
