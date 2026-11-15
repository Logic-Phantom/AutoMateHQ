import { addDays, isoWeekdayOf, localDateString, zonedToUtc } from '../../lib/time';

export interface ScheduleConfig {
  cadence: string; // daily/weekdays/weekly/interval/irregular
  expectedDays: number[]; // ISO 요일
  intervalHours: number | null;
  expectedTimeLocal: string | null; // HH:mm
  timezone: string;
  gracePeriodMinutes: number;
}

/** 해당 로컬 날짜가 실행 예정일인지. 예정일이 아닌 날은 미실행으로 판정하지 않는다. */
export function isScheduledDay(cfg: ScheduleConfig, dateStr: string): boolean {
  const wd = isoWeekdayOf(dateStr);
  switch (cfg.cadence) {
    case 'daily':
      return true;
    case 'weekdays':
      return wd <= 5;
    case 'weekly':
      return cfg.expectedDays.includes(wd);
    default:
      return false;
  }
}

function occurrenceOn(cfg: ScheduleConfig, dateStr: string): Date | null {
  if (!cfg.expectedTimeLocal || !isScheduledDay(cfg, dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const [hh, mm] = cfg.expectedTimeLocal.split(':').map(Number) as [number, number];
  return zonedToUtc(y, m, d, hh, mm, cfg.timezone);
}

/**
 * 유예 시간까지 지난 가장 최근 예정 실행 시각. 없으면 null.
 * interval 주기는 마지막 실행 시각을 기준으로 계산한다.
 */
export function lastDueOccurrence(cfg: ScheduleConfig, now: Date, lastRunStartedAt: Date | null): Date | null {
  const graceMs = cfg.gracePeriodMinutes * 60_000;
  if (cfg.cadence === 'interval') {
    if (!cfg.intervalHours || !lastRunStartedAt) return null;
    const due = new Date(lastRunStartedAt.getTime() + cfg.intervalHours * 3600_000);
    return due.getTime() + graceMs <= now.getTime() ? due : null;
  }
  if (cfg.cadence === 'irregular') return null;
  const today = localDateString(now, cfg.timezone);
  for (let back = 0; back <= 14; back++) {
    const occ = occurrenceOn(cfg, addDays(today, -back));
    if (occ && occ.getTime() + graceMs <= now.getTime()) return occ;
  }
  return null;
}

/** 지금 이후 첫 예정 실행 시각(“다음 예정 작업” 표시용). */
export function nextOccurrence(cfg: ScheduleConfig, now: Date, lastRunStartedAt: Date | null): Date | null {
  if (cfg.cadence === 'interval') {
    if (!cfg.intervalHours || !lastRunStartedAt) return null;
    let t = lastRunStartedAt.getTime() + cfg.intervalHours * 3600_000;
    while (t <= now.getTime()) t += cfg.intervalHours * 3600_000;
    return new Date(t);
  }
  if (cfg.cadence === 'irregular') return null;
  const today = localDateString(now, cfg.timezone);
  for (let ahead = 0; ahead <= 14; ahead++) {
    const occ = occurrenceOn(cfg, addDays(today, ahead));
    if (occ && occ.getTime() > now.getTime()) return occ;
  }
  return null;
}

/** 예정 시각보다 조금 일찍 시작한 실행도 그 회차로 인정한다(수동 실행·cron 오차). */
export const EARLY_START_TOLERANCE_MINUTES = 60;
