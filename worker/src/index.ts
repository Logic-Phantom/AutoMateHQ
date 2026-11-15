import { createApp } from './app';
import { defaultDeps, type Env } from './env';
import { runScheduledTick } from './scheduler';

const app = createApp(defaultDeps);

interface ScheduledEventLike {
  scheduledTime: number;
  cron: string;
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    return app.fetch(request, env, ctx as never);
  },
  /** Cron Trigger(UTC). 한국 시간 07:00 = UTC 22:00. 실제 처리 시각 판단은 내부에서 Asia/Seoul로 한다. */
  scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike) {
    ctx.waitUntil(runScheduledTick(env, defaultDeps, event.scheduledTime));
  },
};
