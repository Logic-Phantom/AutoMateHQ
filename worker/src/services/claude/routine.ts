import { ROUTINE_FIRE_URL_RE } from '../../../../shared/schemas';
import type { FetchFn } from '../../env';

/**
 * Claude Code Routine API Trigger (공식 문서 2026-11-15 확인)
 * https://code.claude.com/docs/en/routines , https://platform.claude.com/docs/en/api/claude-code/routines-fire
 * - POST https://api.anthropic.com/v1/claude_code/routines/{trig_…}/fire
 * - Authorization: Bearer sk-ant-oat01-… (루틴별 토큰, 사용자가 claude.ai에서 발급)
 * - anthropic-version 필수, anthropic-beta: experimental-cc-routine-2026-04-01 (있어도/없어도 허용)
 * - body: { text } (최대 65,536자, 신뢰할 수 없는 데이터로 전달됨)
 * - 200: { type: 'routine_fire', claude_code_session_id, claude_code_session_url }
 * - 비동기: 세션 생성까지만 응답한다. 완료 여부는 알려 주지 않는다 → HQ는 '시작됨'으로만 기록한다.
 * - idempotency key 없음 → HQ가 중복 요청을 막는다. 루틴당 시간당 30회 제한.
 * HQ는 Routine을 만들거나 토큰을 발급할 수 없다(공개 API 없음).
 */
export const ROUTINE_ANTHROPIC_VERSION = '2023-06-01';
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';
export const ROUTINE_TEXT_LIMIT = 65_536;

export interface RoutineFireResult {
  ok: boolean;
  httpStatus: number | null;
  sessionId?: string;
  sessionUrl?: string;
  errorType?: string;
  message?: string;
  retryAfterSeconds?: number;
}

export async function fireRoutine(fetchFn: FetchFn, fireUrl: string, token: string, text: string): Promise<RoutineFireResult> {
  if (!ROUTINE_FIRE_URL_RE.test(fireUrl)) return { ok: false, httpStatus: null, errorType: 'invalid_url', message: '허용되지 않은 Routine URL' };
  if (text.length > ROUTINE_TEXT_LIMIT) return { ok: false, httpStatus: null, errorType: 'too_long', message: 'text 65,536자 초과' };
  let res: Response;
  try {
    res = await fetchFn(fireUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': ROUTINE_ANTHROPIC_VERSION,
        'anthropic-beta': ROUTINE_BETA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch {
    return { ok: false, httpStatus: null, errorType: 'network_error', message: 'Routine 호출 실패(네트워크)' };
  }
  const body = (await res.json().catch(() => ({}))) as {
    type?: string;
    claude_code_session_id?: string;
    claude_code_session_url?: string;
    error?: { type?: string; message?: string };
  };
  if (res.ok && body.type === 'routine_fire') {
    const url = body.claude_code_session_url;
    return {
      ok: true,
      httpStatus: res.status,
      sessionId: body.claude_code_session_id,
      // 세션 URL은 claude.ai 링크만 저장한다
      sessionUrl: url && /^https:\/\/claude\.ai\//.test(url) ? url : undefined,
    };
  }
  const retry = Number(res.headers.get('retry-after') ?? '');
  return {
    ok: false,
    httpStatus: res.status,
    errorType: body.error?.type ?? `http_${res.status}`,
    message: routineErrorMessage(res.status, body.error?.type),
    retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}

function routineErrorMessage(status: number, type?: string): string {
  switch (status) {
    case 400:
      return 'Routine 요청 거부(400): 루틴이 일시정지됐거나 버전 헤더/본문 문제';
    case 401:
      return 'Routine 인증 실패(401): 토큰이 재발급되었거나 루틴과 맞지 않습니다';
    case 403:
      return 'Routine 권한 없음(403): 계정/조직 권한을 확인하세요';
    case 404:
      return 'Routine 없음(404): 루틴이 삭제되었습니다';
    case 429:
      return 'Routine 호출 제한(429): 시간당 한도를 초과했습니다';
    default:
      return `Routine 오류(${status}${type ? ` ${type}` : ''})`;
  }
}
