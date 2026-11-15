/**
 * 시간대 계산. DB에는 UTC ISO 문자열만 저장하고, 판정·표시할 때만 IANA 시간대로 바꾼다.
 * Cloudflare Cron은 UTC로 실행되므로 Asia/Seoul 07:00 은 UTC 전날 22:00 이다.
 */
export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** ISO 요일 1=월 … 7=일 */
  isoWeekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    isoWeekday: WEEKDAY[get('weekday')] ?? 1,
  };
}

/** 지정 시간대의 벽시계 시각을 UTC Date로 바꾼다(DST가 있는 시간대도 2회 보정으로 처리). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(ts), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ts += guess - asUtc;
  }
  return new Date(ts);
}

export function localDateString(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** YYYY-MM-DD 문자열에 일 수를 더한다(달력 계산, 시간대 무관). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function isoWeekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=일
  return wd === 0 ? 7 : wd;
}

const KO_WEEKDAY = ['', '월', '화', '수', '목', '금', '토', '일'];

/** "2026.11.16 (월) 07:00" 형식 */
export function formatKoreanDateTime(date: Date, tz: string): string {
  const p = localParts(date, tz);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${p.year}.${pad(p.month)}.${pad(p.day)} (${KO_WEEKDAY[p.isoWeekday]}) ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatLocalTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '-';
  const p = localParts(new Date(iso), tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}
