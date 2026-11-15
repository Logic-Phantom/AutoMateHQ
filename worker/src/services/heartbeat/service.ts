import { heartbeatSchema, type HeartbeatPayload, type PublicationEvent } from '../../../../shared/schemas';
import type { AppDeps, Env } from '../../env';
import { first, run, type Db } from '../../lib/db';
import { AppError } from '../../lib/http';
import { audit, rateLimit } from '../../repositories/common';
import { keyRing } from '../../repositories/integrations';
import { getProjectByKey } from '../../repositories/projects';
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken, sha256Hex, timingSafeEqual } from '../../security/crypto';
import { raiseIncident } from '../incidents/engine';
import { recordPublicationEvent } from '../publications/service';
import { addRunEvent, upsertRun } from '../runs';

/**
 * 범용 Heartbeat 수신.
 * 서명: X-HQ-Signature: sha256=HEX(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
 * 헤더: X-HQ-Project(projectKey), X-HQ-Timestamp(unix 초)
 * timestamp 허용 오차 ±5분, 같은 (project, runId, type, timestamp) 재전송은 거부한다.
 */
export const HEARTBEAT_TOLERANCE_SECONDS = 300;
export type HeartbeatType = 'start' | 'complete' | 'fail' | 'event';

export async function issueHeartbeatSecret(env: Env, db: Db, projectId: number, now: Date, actor: string) {
  const secret = `hqhb_${randomToken(32)}`;
  const encrypted = await encryptSecret(keyRing(env), secret, `heartbeat:${projectId}`);
  const iso = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE project_secrets SET revoked_at=? WHERE project_id=? AND kind='heartbeat' AND revoked_at IS NULL`).bind(iso, projectId),
    db
      .prepare(`INSERT INTO project_secrets (project_id, kind, secret_encrypted, secret_hint, created_at) VALUES (?, 'heartbeat', ?, ?, ?)`)
      .bind(projectId, encrypted, secret.slice(0, 9), iso),
    db
      .prepare(
        `INSERT INTO project_sources (project_id, source_type, external_identifier, config_json, is_enabled, created_at, updated_at)
         VALUES (?, 'heartbeat', '', '{}', 1, ?, ?)
         ON CONFLICT(project_id, source_type, external_identifier) DO UPDATE SET is_enabled=1, updated_at=excluded.updated_at`,
      )
      .bind(projectId, iso, iso),
  ]);
  await audit(db, now, actor, 'heartbeat_secret.rotate', 'project', projectId);
  return { secret, hint: secret.slice(0, 9) };
}

export async function revokeHeartbeatSecret(db: Db, projectId: number, now: Date, actor: string) {
  const iso = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE project_secrets SET revoked_at=? WHERE project_id=? AND kind='heartbeat' AND revoked_at IS NULL`).bind(iso, projectId),
    db.prepare(`UPDATE project_sources SET is_enabled=0, updated_at=? WHERE project_id=? AND source_type='heartbeat'`).bind(iso, projectId),
  ]);
  await audit(db, now, actor, 'heartbeat_secret.revoke', 'project', projectId);
}

export async function heartbeatSecretInfo(db: Db, projectId: number) {
  return first<{ secret_hint: string; created_at: string }>(
    db,
    `SELECT secret_hint, created_at FROM project_secrets WHERE project_id=? AND kind='heartbeat' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
    projectId,
  );
}

export async function signHeartbeat(secret: string, timestamp: number, rawBody: string): Promise<string> {
  return 'sha256=' + (await hmacSha256Hex(secret, `${timestamp}.${rawBody}`));
}

export async function handleHeartbeat(
  env: Env,
  db: Db,
  deps: AppDeps,
  type: HeartbeatType,
  rawBody: string,
  headers: Headers,
  clientKey: string,
): Promise<{ eventId: number; duplicate: boolean }> {
  const now = deps.now();
  if (!(await rateLimit(db, `hb:${clientKey}`, 120, 60, now))) throw new AppError(429, 'RATE_LIMITED', '요청이 너무 많습니다.');

  const projectKey = headers.get('x-hq-project') ?? '';
  const tsHeader = headers.get('x-hq-timestamp') ?? '';
  const signature = headers.get('x-hq-signature') ?? '';
  const reject = (msg: string) => new AppError(401, 'INVALID_SIGNATURE', msg);
  if (!projectKey || !tsHeader || !signature) throw reject('서명 헤더가 없습니다.');
  const ts = Number(tsHeader);
  if (!Number.isInteger(ts) || Math.abs(Math.floor(now.getTime() / 1000) - ts) > HEARTBEAT_TOLERANCE_SECONDS) {
    throw reject('timestamp가 허용 범위를 벗어났습니다.');
  }

  const project = await getProjectByKey(db, projectKey);
  // 프로젝트가 없어도 같은 메시지로 거부한다(존재 여부 노출 방지)
  const secretRow = project
    ? await first<{ secret_encrypted: string }>(
        db,
        `SELECT secret_encrypted FROM project_secrets WHERE project_id=? AND kind='heartbeat' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
        project.id,
      )
    : null;
  if (!project || !secretRow) throw reject('서명 검증 실패');
  const secret = await decryptSecret(keyRing(env), secretRow.secret_encrypted, `heartbeat:${project.id}`);
  const expected = await signHeartbeat(secret, ts, rawBody);
  if (!timingSafeEqual(expected, signature)) {
    await raiseIncident(
      db,
      {
        projectId: project.id,
        fingerprint: `heartbeat:${project.id}:SIGNATURE_MISMATCH`,
        severity: 'medium',
        category: 'SIGNATURE_MISMATCH',
        title: 'Heartbeat 서명 불일치 — secret 교체 여부를 확인하세요',
      },
      now,
    );
    throw reject('서명 검증 실패');
  }
  if (!project.is_active) throw new AppError(409, 'PROJECT_INACTIVE', '비활성 프로젝트입니다.');

  let payload: HeartbeatPayload;
  try {
    payload = heartbeatSchema.parse(JSON.parse(rawBody));
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '본문 형식이 계약과 다릅니다.');
  }
  if (payload.projectKey !== projectKey) throw new AppError(400, 'BAD_REQUEST', 'projectKey가 헤더와 다릅니다.');

  // 재전송 방지
  const nonce = await sha256Hex(`${project.id}|${payload.runId}|${type}|${ts}|${signature}`);
  const nonceRes = await run(db, `INSERT OR IGNORE INTO heartbeat_nonces (nonce, created_at) VALUES (?, ?)`, nonce, now.toISOString());
  if (nonceRes.meta.changes === 0) return { eventId: 0, duplicate: true };

  const source = await first<{ id: number }>(
    db,
    `SELECT id FROM project_sources WHERE project_id=? AND source_type='heartbeat' LIMIT 1`,
    project.id,
  );
  const status =
    type === 'start' ? 'running' : type === 'complete' ? (payload.status === 'skipped' ? 'skipped' : 'success') : type === 'fail' ? 'failure' : (payload.status ?? 'running');
  const runId = await upsertRun(
    db,
    {
      projectId: project.id,
      sourceId: source?.id ?? null,
      sourceType: 'heartbeat',
      externalRunId: payload.runId,
      triggerType: 'heartbeat',
      workflowName: payload.source,
      status,
      stage: payload.stage ?? null,
      startedAt: payload.startedAt ? new Date(payload.startedAt).toISOString() : type === 'start' ? now.toISOString() : null,
      completedAt:
        type === 'complete' || type === 'fail'
          ? payload.completedAt
            ? new Date(payload.completedAt).toISOString()
            : now.toISOString()
          : null,
      externalUrl: payload.externalUrl ?? null,
      summary: payload.message ?? null,
      errorCode: type === 'fail' ? (payload.errorCode ?? 'REPORTED_FAILURE') : null,
      safeErrorMessage: type === 'fail' ? (payload.message ?? '실패 보고됨') : null,
      metrics: payload.metrics ?? null,
    },
    now,
  );
  await addRunEvent(db, runId, `heartbeat:${type}`, now, { status, stage: payload.stage, message: payload.message });
  if (payload.publication) await recordPublicationEvent(db, project.id, payload.publication as PublicationEvent, now, 'heartbeat_reported');
  return { eventId: runId, duplicate: false };
}
