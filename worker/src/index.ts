import { createApp } from './app';
import { defaultDeps, type Env } from './env';
import { runScheduledTick } from './scheduler';
import { ensureSchedulerAlarm } from './scheduler/alarm';

export { SchedulerAlarm } from './scheduler/alarm';

const app = createApp(defaultDeps);

/** isolate마다 한 번만 알람을 확인한다. 실패하면 다음 요청에서 다시 시도한다. */
let alarmEnsured = false;

interface ScheduledEventLike {
  scheduledTime: number;
  cron: string;
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    if (!alarmEnsured) {
      alarmEnsured = true;
      ctx.waitUntil(
        ensureSchedulerAlarm(env).catch((err) => {
          alarmEnsured = false;
          console.error('scheduler_alarm_ensure_failed', (err as Error)?.message ?? String(err));
        }),
      );
    }
    return app.fetch(request, env, ctx as never);
  },
  /** Cron Trigger(UTC). 한국 시간 07:00 = UTC 22:00. 실제 처리 시각 판단은 내부에서 Asia/Seoul로 한다. */
  scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike) {
    ctx.waitUntil(runScheduledTick(env, defaultDeps, event.scheduledTime));
  },
};
