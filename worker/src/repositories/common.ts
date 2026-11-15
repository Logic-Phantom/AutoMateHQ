import { all, first, parseJson, run, stmt, type Db } from '../lib/db';
import { safeMetadata } from '../security/redact';

// ---------------- 감사 로그 ----------------
export async function audit(
  db: Db,
  now: Date,
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string | number | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await run(
    db,
    `INSERT INTO audit_logs (actor, action, resource_type, resource_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?,?)`,
    actor,
    action,
    resourceType,
    resourceId === null ? null : String(resourceId),
    JSON.stringify(safeMetadata(metadata)),
    now.toISOString(),
  );
}

export function auditStmt(
  db: Db,
  now: Date,
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string | number | null,
  metadata: Record<string, unknown> = {},
) {
  return stmt(
    db,
    `INSERT INTO audit_logs (actor, action, resource_type, resource_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?,?)`,
    actor,
    action,
    resourceType,
    resourceId === null ? null : String(resourceId),
    JSON.stringify(safeMetadata(metadata)),
    now.toISOString(),
  );
}

// ---------------- 설정 ----------------
export interface NotificationSettings {
  dailyReportEnabled: boolean;
  instantAlertsEnabled: boolean;
  alertCooldownMinutes: number;
}
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  dailyReportEnabled: true,
  instantAlertsEnabled: true,
  alertCooldownMinutes: 180,
};

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const row = await first<{ value_json: string }>(db, `SELECT value_json FROM settings WHERE key = ?`, key);
  return row ? { ...fallback, ...parseJson<Partial<T>>(row.value_json, {}) } : fallback;
}

export async function putSetting(db: Db, key: string, value: unknown, now: Date): Promise<void> {
  await run(
    db,
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    now.toISOString(),
  );
}

export const getNotificationSettings = (db: Db) =>
  getSetting<NotificationSettings>(db, 'notifications', DEFAULT_NOTIFICATION_SETTINGS);

// ---------------- 잠금(lease) ----------------
/** 만료된 잠금만 가져갈 수 있다. scheduled job과 토큰 갱신이 겹치지 않게 한다. */
export async function acquireLock(db: Db, name: string, holder: string, now: Date, ttlSeconds: number): Promise<boolean> {
  const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const res = await run(
    db,
    `INSERT INTO job_locks (name, holder, expires_at) VALUES (?,?,?)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
     WHERE job_locks.expires_at < ?`,
    name,
    holder,
    expires,
    now.toISOString(),
  );
  return res.meta.changes > 0;
}

export async function releaseLock(db: Db, name: string, holder: string): Promise<void> {
  await run(db, `DELETE FROM job_locks WHERE name = ? AND holder = ?`, name, holder);
}

// ---------------- 호출 제한 ----------------
/** 고정 창 카운터. 허용되면 true. */
export async function rateLimit(db: Db, bucket: string, limit: number, windowSeconds: number, now: Date): Promise<boolean> {
  const windowEnd = new Date(now.getTime() + windowSeconds * 1000).toISOString();
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO rate_limits (bucket, count, window_end) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.window_end < ? THEN 1 ELSE rate_limits.count + 1 END,
       window_end = CASE WHEN rate_limits.window_end < ? THEN excluded.window_end ELSE rate_limits.window_end END
     RETURNING count`,
    bucket,
    windowEnd,
    now.toISOString(),
    now.toISOString(),
  );
  return (row?.count ?? 1) <= limit;
}

export async function housekeeping(db: Db, now: Date): Promise<void> {
  const iso = now.toISOString();
  const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
  const ninetyDays = new Date(now.getTime() - 90 * 86400_000).toISOString();
  await db.batch([
    stmt(db, `DELETE FROM admin_sessions WHERE expires_at < ?`, iso),
    stmt(db, `DELETE FROM rate_limits WHERE window_end < ?`, iso),
    stmt(db, `DELETE FROM oauth_states WHERE expires_at < ?`, iso),
    stmt(db, `DELETE FROM heartbeat_nonces WHERE created_at < ?`, dayAgo),
    stmt(db, `DELETE FROM webhook_deliveries WHERE received_at < ?`, ninetyDays),
  ]);
}

export async function listAudit(db: Db, limit = 100) {
  return all(db, `SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`, limit);
}
