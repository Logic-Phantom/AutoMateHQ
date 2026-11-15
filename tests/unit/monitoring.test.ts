import { describe, expect, it } from 'vitest';
import { classify, summarize, type SignalInput } from '../../worker/src/services/monitoring/classifier';
import { isScheduledDay, lastDueOccurrence, nextOccurrence } from '../../worker/src/services/monitoring/schedule';

// 2026-11-16(월) 09:00 KST = 2026-11-16T00:00Z
const NOW = new Date('2026-11-16T00:00:00Z');

function input(over: Partial<SignalInput> & { schedule?: Partial<SignalInput['project']['schedule']> } = {}): SignalInput {
  const { schedule, project, ...rest } = over;
  return {
    project: {
      id: 1,
      isActive: true,
      monitoringMode: 'github_actions',
      hasGithubSource: true,
      hasHeartbeatSource: false,
      createdAt: '2026-10-01T00:00:00Z',
      schedule: {
        cadence: 'daily',
        expectedDays: [],
        intervalHours: null,
        expectedTimeLocal: '07:00',
        timezone: 'Asia/Seoul',
        gracePeriodMinutes: 60,
        ...schedule,
      },
      ...(project ?? {}),
    },
    runs: [],
    publications: [],
    githubIntegrationStatus: 'connected',
    lastSyncErrorCode: null,
    externalIncidents: [],
    now: NOW,
    ...rest,
  } as SignalInput;
}

const run = (id: number, status: string, startedAt: string) => ({ id, status, startedAt, completedAt: startedAt });

describe('상태 판정', () => {
  it('정상 완료 run은 NORMAL', () => {
    const c = classify(input({ runs: [run(1, 'success', '2026-11-15T22:05:00Z')] }));
    expect(c.status).toBe('NORMAL');
  });

  it('실패 run은 FAILED', () => {
    const c = classify(input({ runs: [run(2, 'failure', '2026-11-15T22:05:00Z'), run(1, 'success', '2026-11-14T22:05:00Z')] }));
    expect(c.status).toBe('FAILED');
    expect(c.reasons.some((r) => r.code === 'RUN_FAILED' && r.relatedRunId === 2)).toBe(true);
  });

  it('실패 후 성공하면 다시 NORMAL', () => {
    const c = classify(input({ runs: [run(3, 'success', '2026-11-15T23:00:00Z'), run(2, 'failure', '2026-11-15T22:05:00Z')] }));
    expect(c.status).toBe('NORMAL');
  });

  it('예정 시각+유예 시간이 지나도록 실행이 없으면 ATTENTION(MISSED_RUN)', () => {
    // 오늘 07:00 KST 예정, 유예 60분 → 08:00 이후 미실행. 마지막 실행은 어제.
    const c = classify(input({ runs: [run(1, 'success', '2026-11-14T22:05:00Z')] }));
    expect(c.status).toBe('ATTENTION');
    expect(c.reasons.map((r) => r.code)).toContain('MISSED_RUN');
  });

  it('유예 시간 안이면 아직 미실행으로 보지 않는다', () => {
    const c = classify(input({ now: new Date('2026-11-15T22:30:00Z'), runs: [run(1, 'success', '2026-11-14T22:05:00Z')] }));
    expect(c.reasons.map((r) => r.code)).not.toContain('MISSED_RUN');
    expect(c.status).toBe('NORMAL');
  });

  it('실행 예정일이 아닌 날은 미실행으로 판정하지 않는다(평일 일정, 일요일)', () => {
    // 2026-11-15(일) 12:00 KST. 마지막 실행 금요일 07:05 KST.
    const c = classify(
      input({
        now: new Date('2026-11-15T03:00:00Z'),
        schedule: { cadence: 'weekdays' },
        runs: [run(1, 'success', '2026-11-12T22:05:00Z')],
      }),
    );
    expect(c.reasons.map((r) => r.code)).not.toContain('MISSED_RUN');
    expect(c.status).toBe('NORMAL');
  });

  it('데이터가 없거나 연동이 안 되면 UNKNOWN(정상으로 간주하지 않음)', () => {
    expect(classify(input({ runs: [] , project: { hasGithubSource: true } as never })).status).not.toBe('NORMAL');
    const noToken = classify(input({ githubIntegrationStatus: 'not_connected', runs: [] }));
    expect(noToken.status).toBe('UNKNOWN');
    const noSource = classify(
      input({ project: { id: 1, isActive: true, monitoringMode: 'heartbeat', hasGithubSource: false, hasHeartbeatSource: false, createdAt: '2026-10-01T00:00:00Z' } as never }),
    );
    expect(noSource.status).toBe('UNKNOWN');
  });

  it('최근 등록 프로젝트는 기준선 기간 동안 MISSED_RUN을 만들지 않는다', () => {
    const c = classify(input({ project: { createdAt: '2026-11-15T20:00:00Z' } as never, runs: [] }));
    expect(c.reasons.map((r) => r.code)).not.toContain('MISSED_RUN');
    expect(c.status).toBe('UNKNOWN');
  });

  it('수집 실패는 프로젝트 실패(FAILED)와 구별해 ATTENTION으로 둔다', () => {
    const c = classify(input({ lastSyncErrorCode: 'NETWORK_ERROR', runs: [run(1, 'success', '2026-11-15T22:05:00Z')] }));
    expect(c.status).toBe('ATTENTION');
    expect(c.reasons.map((r) => r.code)).toContain('COLLECTION_ERROR');
  });

  it('파이프라인 성공이어도 게시 실패면 FAILED', () => {
    const c = classify(
      input({
        runs: [run(1, 'success', '2026-11-15T22:05:00Z')],
        publications: [{ status: 'failed', platform: 'instagram', title: '카드', updatedAt: '2026-11-15T22:10:00Z', errorCode: '401' }],
      }),
    );
    expect(c.status).toBe('FAILED');
  });

  it('집계 숫자는 활성 프로젝트 수와 일치하고 비활성은 제외한다', () => {
    const s = summarize([
      { isActive: true, status: 'NORMAL' },
      { isActive: true, status: 'FAILED' },
      { isActive: true, status: 'ATTENTION' },
      { isActive: true, status: 'UNKNOWN' },
      { isActive: false, status: 'NORMAL' },
    ]);
    expect(s.total).toBe(4);
    expect(s.NORMAL + s.FAILED + s.ATTENTION + s.UNKNOWN).toBe(s.total);
  });
});

describe('일정 계산', () => {
  const cfg = { cadence: 'weekly', expectedDays: [1, 3], intervalHours: null, expectedTimeLocal: '07:00', timezone: 'Asia/Seoul', gracePeriodMinutes: 30 };
  it('주간 일정 요일 판정', () => {
    expect(isScheduledDay(cfg, '2026-11-16')).toBe(true); // 월
    expect(isScheduledDay(cfg, '2026-11-17')).toBe(false); // 화
  });
  it('KST 07:00은 UTC 전날 22:00', () => {
    const due = lastDueOccurrence(cfg, NOW, null);
    expect(due?.toISOString()).toBe('2026-11-15T22:00:00.000Z');
    expect(nextOccurrence(cfg, NOW, null)?.toISOString()).toBe('2026-11-17T22:00:00.000Z'); // 수 07:00 KST
  });
  it('interval 주기는 마지막 실행 기준', () => {
    const icfg = { ...cfg, cadence: 'interval', intervalHours: 8, expectedTimeLocal: null };
    expect(lastDueOccurrence(icfg, NOW, new Date('2026-11-15T10:00:00Z'))?.toISOString()).toBe('2026-11-15T18:00:00.000Z');
    expect(lastDueOccurrence(icfg, NOW, new Date('2026-11-15T20:00:00Z'))).toBeNull();
  });
});
