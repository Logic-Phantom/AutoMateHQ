import type { PublicationEvent } from '../../../../shared/schemas';
import type { VerificationSource } from '../../../../shared/constants';
import { all, first, parseJson, run, type Db } from '../../lib/db';
import { redact } from '../../security/redact';

/**
 * 콘텐츠 게시 단계 추적.
 * GitHub Actions 성공 ≠ 게시 성공. 게시 확인 출처(heartbeat 보고 / 공식 API 검증)를 반드시 구분한다.
 * 조회수·도달 등은 보고된 값만 저장하고 추정하지 않는다.
 */
export async function recordPublicationEvent(
  db: Db,
  projectId: number,
  ev: PublicationEvent,
  now: Date,
  verification: VerificationSource,
): Promise<number> {
  const iso = now.toISOString();
  const stamp = (stage: string) => (ev.status === stage ? iso : null);
  // 공식 API 검증을 거친 값은 heartbeat 보고로 덮어쓰지 않는다
  await run(
    db,
    `INSERT INTO publications (project_id, platform, content_key, title, status, generated_at, upload_started_at, published_at,
       platform_post_id, platform_url, verification_status, failed_stage, error_code, safe_error_message, retried, metrics_json,
       created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id, platform, content_key) DO UPDATE SET
       title = COALESCE(excluded.title, publications.title),
       failed_stage = CASE WHEN excluded.status = 'failed' THEN publications.status ELSE publications.failed_stage END,
       status = excluded.status,
       generated_at = COALESCE(publications.generated_at, excluded.generated_at),
       upload_started_at = COALESCE(publications.upload_started_at, excluded.upload_started_at),
       published_at = COALESCE(excluded.published_at, publications.published_at),
       platform_post_id = COALESCE(excluded.platform_post_id, publications.platform_post_id),
       platform_url = COALESCE(excluded.platform_url, publications.platform_url),
       verification_status = CASE WHEN publications.verification_status = 'official_api_verified'
         THEN publications.verification_status ELSE excluded.verification_status END,
       error_code = excluded.error_code,
       safe_error_message = excluded.safe_error_message,
       retried = MAX(publications.retried, excluded.retried),
       metrics_json = CASE WHEN excluded.metrics_json = '{}' THEN publications.metrics_json ELSE excluded.metrics_json END,
       updated_at = excluded.updated_at`,
    projectId,
    ev.platform,
    ev.contentKey,
    ev.title ?? null,
    ev.status,
    stamp('generated'),
    stamp('uploading'),
    stamp('published'),
    ev.platformPostId ?? null,
    ev.platformUrl ?? null,
    ev.status === 'published' ? verification : 'unverified',
    ev.status === 'failed' ? 'unknown' : null,
    ev.errorCode ?? null,
    ev.message ? redact(ev.message, 300) : null,
    ev.retried ? 1 : 0,
    JSON.stringify(ev.metrics ?? {}),
    iso,
    iso,
  );
  const row = await first<{ id: number }>(
    db,
    `SELECT id FROM publications WHERE project_id=? AND platform=? AND content_key=?`,
    projectId,
    ev.platform,
    ev.contentKey,
  );
  return row!.id;
}

interface PublicationRow {
  id: number;
  project_id: number;
  platform: string;
  content_key: string;
  title: string | null;
  status: string;
  generated_at: string | null;
  upload_started_at: string | null;
  published_at: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  verification_status: string;
  failed_stage: string | null;
  error_code: string | null;
  safe_error_message: string | null;
  retried: number;
  metrics_json: string;
  updated_at: string;
  project_name?: string;
}

export async function listPublications(db: Db, filter: { platform?: string; projectId?: number; limit?: number }) {
  const rows = await all<PublicationRow>(
    db,
    `SELECT pub.*, p.name AS project_name FROM publications pub JOIN projects p ON p.id = pub.project_id
     WHERE (? IS NULL OR pub.platform = ?) AND (? IS NULL OR pub.project_id = ?)
     ORDER BY pub.updated_at DESC LIMIT ?`,
    filter.platform ?? null,
    filter.platform ?? null,
    filter.projectId ?? null,
    filter.projectId ?? null,
    filter.limit ?? 100,
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    platform: r.platform,
    contentKey: r.content_key,
    title: r.title,
    status: r.status,
    generatedAt: r.generated_at,
    uploadStartedAt: r.upload_started_at,
    publishedAt: r.published_at,
    platformPostId: r.platform_post_id,
    platformUrl: r.platform_url,
    verificationStatus: r.verification_status,
    failedStage: r.failed_stage,
    errorCode: r.error_code,
    safeErrorMessage: r.safe_error_message,
    retried: r.retried === 1,
    metrics: parseJson<Record<string, number>>(r.metrics_json, {}),
    updatedAt: r.updated_at,
  }));
}
