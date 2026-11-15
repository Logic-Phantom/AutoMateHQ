/** 표준 JSON 응답 형식: { ok: true, data } | { ok: false, error: { code, message, details? } } */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '로그인이 필요합니다.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = '권한이 없습니다.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = '대상을 찾을 수 없습니다.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const tooMany = (message = '요청이 너무 많습니다. 잠시 후 다시 시도하세요.') =>
  new AppError(429, 'RATE_LIMITED', message);

export function errorBody(err: AppError) {
  return { ok: false as const, error: { code: err.code, message: err.message, details: err.details } };
}
