const TZ = 'Asia/Seoul';

const dtf = new Intl.DateTimeFormat('ko-KR', {
  timeZone: TZ,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const df = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return dtf.format(new Date(iso));
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  return df.format(new Date(iso));
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const diff = Math.round((now - new Date(iso).getTime()) / 60000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '전' : '후';
  if (abs < 1) return '방금';
  if (abs < 60) return `${abs}분 ${suffix}`;
  if (abs < 60 * 24) return `${Math.round(abs / 60)}시간 ${suffix}`;
  return `${Math.round(abs / 1440)}일 ${suffix}`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds < 60) return `${seconds}초`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}분 ${seconds % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function fmtNumber(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : new Intl.NumberFormat('ko-KR').format(n);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
