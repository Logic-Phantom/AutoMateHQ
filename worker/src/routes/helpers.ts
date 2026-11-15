import type { z } from 'zod';
import { badRequest } from '../lib/http';
import type { AppContext } from '../security/session';

export async function parseJsonBody<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('JSON 본문이 필요합니다.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      '입력값이 올바르지 않습니다.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function idParam(c: AppContext, name = 'id'): number {
  const v = Number(c.req.param(name));
  if (!Number.isInteger(v) || v <= 0) throw badRequest('잘못된 ID입니다.');
  return v;
}

export const ok = <T>(c: AppContext, data: T, status: 200 | 201 | 202 = 200) => c.json({ ok: true as const, data }, status);
