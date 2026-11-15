/**
 * Cloudflare D1에서 실제로 쓰는 부분만 추린 인터페이스.
 * 테스트에서는 Node 내장 SQLite로 같은 인터페이스를 구현해 실제 migration SQL을 그대로 실행한다.
 * 모든 쿼리는 prepared statement + bind 로만 실행한다(SQL injection 방지).
 */
export interface DbRunResult {
  meta: { changes: number; last_row_id: number };
}
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<DbRunResult>;
}
export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

export async function all<T>(db: Db, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return res.results;
}

export async function first<T>(db: Db, sql: string, ...params: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function run(db: Db, sql: string, ...params: unknown[]): Promise<DbRunResult> {
  return db
    .prepare(sql)
    .bind(...params)
    .run();
}

export function stmt(db: Db, sql: string, ...params: unknown[]): DbStatement {
  return db.prepare(sql).bind(...params);
}

/** undefined 는 D1 bind에서 오류가 나므로 null로 바꾼다. */
export function n<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
