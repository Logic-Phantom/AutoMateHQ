/** Worker API 클라이언트. 세션 쿠키는 브라우저가 관리하고, 상태 변경 요청에는 CSRF 토큰 헤더를 붙인다. */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', '서버에 연결할 수 없습니다.');
  }
  const json = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok || !json || json.ok === false) {
    if (res.status === 401 && !path.startsWith('/api/auth')) window.dispatchEvent(new Event('hq:unauthorized'));
    throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `요청 실패(${res.status})`, json?.error?.details);
  }
  return json.data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details)
      ? (err.details as { path?: string; message: string }[]).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join(', ')
      : '';
    return details ? `${err.message} (${details})` : err.message;
  }
  return '알 수 없는 오류가 발생했습니다.';
}
