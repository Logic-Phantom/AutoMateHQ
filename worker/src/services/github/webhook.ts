import type { AppDeps, Env } from '../../env';
import { all, first, run, type Db } from '../../lib/db';
import { verifyGithubSignature } from '../../security/crypto';
import { redact } from '../../security/redact';
import type { ProjectRow, SourceRow } from '../../repositories/projects';
import { addRunEvent, upsertRun } from '../runs';
import type { WorkflowRunApi } from './client';
import { runFromApi } from './service';

/**
 * GitHub Webhook 처리.
 * 1) raw body 기준 X-Hub-Signature-256 검증  2) X-GitHub-Delivery 중복 차단
 * 3) 허용 이벤트만 처리  4) 저장소→프로젝트 매핑 후 run upsert
 * 원본 payload 전체는 저장하지 않는다.
 */
export const ALLOWED_GITHUB_EVENTS = new Set(['workflow_run', 'ping']);

export type WebhookOutcome =
  | { httpStatus: 401; result: 'rejected'; reason: string }
  | { httpStatus: 200; result: 'duplicate' | 'ignored' | 'processed'; reason?: string; runIds?: number[] }
  | { httpStatus: 400 | 503; result: 'failed'; reason: string };

export async function handleGithubWebhook(
  env: Env,
  db: Db,
  deps: AppDeps,
  rawBody: Uint8Array<ArrayBuffer>,
  headers: Headers,
): Promise<WebhookOutcome> {
  const now = deps.now();
  const deliveryId = (headers.get('x-github-delivery') ?? '').slice(0, 100);
  const event = (headers.get('x-github-event') ?? '').slice(0, 50);
  if (!env.GITHUB_WEBHOOK_SECRET) return { httpStatus: 503, result: 'failed', reason: 'GITHUB_WEBHOOK_SECRET 미설정' };
  if (!deliveryId) return { httpStatus: 400, result: 'failed', reason: 'X-GitHub-Delivery 헤더 없음' };

  const valid = await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, headers.get('x-hub-signature-256'));
  if (!valid) {
    // 서명 불일치도 기록하되 중복 키 충돌은 무시(공격자가 delivery id를 선점하지 못하게 provider를 분리)
    await run(
      db,
      `INSERT OR IGNORE INTO webhook_deliveries (provider, delivery_id, event_type, signature_valid, processing_status, received_at, safe_error_message)
       VALUES ('github_invalid', ?, ?, 0, 'rejected', ?, '서명 불일치')`,
      deliveryId,
      event,
      now.toISOString(),
    );
    return { httpStatus: 401, result: 'rejected', reason: '서명 불일치' };
  }

  const inserted = await run(
    db,
    `INSERT OR IGNORE INTO webhook_deliveries (provider, delivery_id, event_type, signature_valid, processing_status, received_at)
     VALUES ('github', ?, ?, 1, 'processing', ?)`,
    deliveryId,
    event,
    now.toISOString(),
  );
  if (inserted.meta.changes === 0) return { httpStatus: 200, result: 'duplicate' };

  const finish = (status: string, message?: string) =>
    run(
      db,
      `UPDATE webhook_deliveries SET processing_status=?, processed_at=?, safe_error_message=? WHERE provider='github' AND delivery_id=?`,
      status,
      deps.now().toISOString(),
      message ? redact(message, 200) : null,
      deliveryId,
    );

  if (!ALLOWED_GITHUB_EVENTS.has(event)) {
    await finish('ignored', `허용하지 않은 이벤트: ${event}`);
    return { httpStatus: 200, result: 'ignored', reason: event };
  }
  if (event === 'ping') {
    await finish('processed');
    return { httpStatus: 200, result: 'processed' };
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as {
      action?: string;
      workflow_run?: WorkflowRunApi;
      repository?: { name: string; owner: { login: string } };
    };
    const wr = payload.workflow_run;
    const repo = payload.repository;
    if (!wr || !repo) {
      await finish('ignored', 'workflow_run 데이터 없음');
      return { httpStatus: 200, result: 'ignored' };
    }
    const projects = await all<ProjectRow>(
      db,
      `SELECT * FROM projects WHERE deleted_at IS NULL AND lower(repo_owner) = lower(?) AND lower(repo_name) = lower(?)`,
      repo.owner.login,
      repo.name,
    );
    const runIds: number[] = [];
    for (const p of projects) {
      const sources = await all<SourceRow>(
        db,
        `SELECT * FROM project_sources WHERE project_id=? AND source_type='github_actions' AND is_enabled=1`,
        p.id,
      );
      const source =
        sources.find((s) => s.external_identifier === '*' || (wr.path ?? '').endsWith(`/${s.external_identifier}`)) ?? null;
      if (!source) continue; // 감시 대상 워크플로가 아님
      const id = await upsertRun(db, runFromApi(p, source, wr), now);
      await addRunEvent(db, id, `webhook:workflow_run.${payload.action ?? 'unknown'}`, now, {
        status: wr.conclusion ?? wr.status,
      });
      runIds.push(id);
    }
    await finish(runIds.length ? 'processed' : 'ignored', runIds.length ? undefined : '매핑된 프로젝트 없음');
    return { httpStatus: 200, result: runIds.length ? 'processed' : 'ignored', runIds };
  } catch (err) {
    await finish('failed', (err as Error).message);
    return { httpStatus: 400, result: 'failed', reason: '처리 실패' };
  }
}

export async function recentDeliveries(db: Db, limit = 30) {
  return all(db, `SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT ?`, limit);
}

export async function deliveryExists(db: Db, deliveryId: string) {
  return first(db, `SELECT id FROM webhook_deliveries WHERE provider='github' AND delivery_id=?`, deliveryId);
}
