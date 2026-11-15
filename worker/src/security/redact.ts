/**
 * 로그·오류 메시지·DB 저장 전에 비밀 값 패턴을 가린다.
 * 외부 API 오류 본문이나 GitHub 로그에 토큰이 섞여 들어오는 경우를 막기 위한 마지막 방어선이다.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/g,
  /KakaoAK\s+[A-Za-z0-9]+/g,
];
const KEY_VALUE = /(authorization|access_token|refresh_token|client_secret|secret|token|password)(["'\s]*[:=]\s*["']?)([^\s"'&,}]+)/gi;

export function redact(input: string | null | undefined, maxLength = 300): string {
  if (!input) return '';
  let out = String(input);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[REDACTED]');
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  return out.length > maxLength ? out.slice(0, maxLength) + '…' : out;
}

/** 객체에서 민감 키를 제거한다(감사 로그 메타데이터용). */
const SENSITIVE_KEYS = /token|secret|password|authorization|credential|cookie/i;
export function safeMetadata(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) continue;
    if (typeof v === 'string') out[k] = redact(v, 200);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? redact(x, 100) : x));
  }
  return out;
}
