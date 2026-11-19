import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps, Env } from '../../worker/src/env';
import { ensureSchedulerAlarm, nextTickTime, SchedulerAlarm } from '../../worker/src/scheduler/alarm';
import { runScheduledTick } from '../../worker/src/scheduler/index';

vi.mock('../../worker/src/scheduler/index', () => ({ runScheduledTick: vi.fn() }));

const tick = vi.mocked(runScheduledTick);
const env = { APP_MODE: 'live' } as Env;

function harness(nowIso: string, alarm: number | null = null) {
  const storage = {
    alarm,
    getAlarm: vi.fn(async () => storage.alarm),
    setAlarm: vi.fn(async (t: number) => {
      storage.alarm = t;
    }),
  };
  const deps = { fetch: vi.fn(), now: () => new Date(nowIso) } as unknown as AppDeps;
  return { storage, deps, scheduler: new SchedulerAlarm({ storage }, env, deps) };
}

describe('SchedulerAlarm', () => {
  beforeEach(() => tick.mockReset());

  it('다음 10분 경계를 계산하고 08:00 KST 정각을 건너뛰지 않는다', () => {
    expect(new Date(nextTickTime(Date.parse('2026-11-19T22:55:00.000Z'))).toISOString()).toBe('2026-11-19T23:00:00.000Z');
    expect(new Date(nextTickTime(Date.parse('2026-11-19T23:00:00.000Z'))).toISOString()).toBe('2026-11-19T23:10:00.000Z');
  });

  it('알람이 없을 때만 새로 건다', async () => {
    const empty = harness('2026-11-19T22:55:00.000Z');
    await empty.scheduler.fetch();
    expect(empty.storage.setAlarm).toHaveBeenCalledWith(Date.parse('2026-11-19T23:00:00.000Z'));

    const armed = harness('2026-11-19T22:55:00.000Z', Date.parse('2026-11-19T23:00:00.000Z'));
    await armed.scheduler.fetch();
    expect(armed.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('알람이 울리면 tick을 실행하고 다음 알람을 건다', async () => {
    const h = harness('2026-11-19T23:00:02.000Z');
    await h.scheduler.alarm();
    expect(tick).toHaveBeenCalledWith(env, h.deps, Date.parse('2026-11-19T23:00:00.000Z'));
    expect(h.storage.alarm).toBe(Date.parse('2026-11-19T23:10:00.000Z'));
  });

  it('tick이 실패해도 다음 알람을 건다', async () => {
    tick.mockRejectedValueOnce(new Error('boom'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness('2026-11-19T23:00:02.000Z');
    await expect(h.scheduler.alarm()).resolves.toBeUndefined();
    expect(h.storage.alarm).toBe(Date.parse('2026-11-19T23:10:00.000Z'));
    errorLog.mockRestore();
  });

  it('샘플 모드나 바인딩이 없으면 알람을 걸지 않는다', async () => {
    expect(await ensureSchedulerAlarm({ APP_MODE: 'demo' } as Env)).toBe(false);
    expect(await ensureSchedulerAlarm({ APP_MODE: 'live' } as Env)).toBe(false);
  });
});
