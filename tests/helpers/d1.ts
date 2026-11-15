import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Db, DbRunResult, DbStatement } from '../../worker/src/lib/db';

/** Node 내장 SQLite로 D1 인터페이스를 흉내 낸다. 실제 migration SQL을 그대로 적용한다. */
class Statement implements DbStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}
  bind(...values: unknown[]): DbStatement {
    return new Statement(this.db, this.sql, values);
  }
  private args(): SQLInputValue[] {
    return this.params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : (v as SQLInputValue)));
  }
  async first<T>(): Promise<T | null> {
    return this.firstSync<T>();
  }
  firstSync<T>(): T | null {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row ? { ...row } : null) as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args()).map((r) => ({ ...r })) as T[] };
  }
  async run(): Promise<DbRunResult> {
    return this.runSync();
  }
  runSync(): DbRunResult {
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = this.db.prepare(this.sql).all(...this.args());
      return { meta: { changes: rows.length, last_row_id: 0 } };
    }
    const r = this.db.prepare(this.sql).run(...this.args());
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class TestD1 implements Db {
  readonly raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    const dir = join(process.cwd(), 'worker', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      this.raw.exec(readFileSync(join(dir, file), 'utf8'));
    }
  }
  prepare(sql: string): DbStatement {
    return new Statement(this.raw, sql);
  }
  async batch(statements: DbStatement[]): Promise<unknown[]> {
    // D1 batch는 트랜잭션으로 실행된다
    this.raw.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as Statement).runSync());
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }
  count(table: string, where = '1=1', ...params: SQLInputValue[]): number {
    const row = this.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number };
    return Number(row.n);
  }
  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T {
    return { ...(this.raw.prepare(sql).get(...params) as object) } as T;
  }
}
