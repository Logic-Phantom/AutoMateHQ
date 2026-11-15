import type { IntegrationProvider, IntegrationStatus } from '../../../shared/constants';
import type { Env } from '../env';
import { all, first, parseJson, run, type Db } from '../lib/db';
import { decryptSecret, encryptSecret, type KeyRing } from '../security/crypto';
import { redact } from '../security/redact';

export interface IntegrationRow {
  id: number;
  provider: IntegrationProvider;
  display_name: string;
  status: IntegrationStatus;
  encrypted_credentials: string | null;
  credential_key_version: number;
  metadata_json: string;
  last_verified_at: string | null;
  last_error_code: string | null;
  last_error_message_safe: string | null;
  created_at: string;
  updated_at: string;
}

/** 프런트엔드로 보내도 되는 형태. 자격 증명은 존재 여부만 알려 준다. */
export function publicIntegration(row: IntegrationRow) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    status: row.status,
    hasCredentials: Boolean(row.encrypted_credentials),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message_safe,
    updatedAt: row.updated_at,
  };
}

export const keyRing = (env: Env): KeyRing => ({
  current: env.HQ_ENCRYPTION_KEY,
  previous: env.HQ_ENCRYPTION_KEY_PREVIOUS,
});

export async function getIntegration(db: Db, provider: IntegrationProvider): Promise<IntegrationRow | null> {
  return first<IntegrationRow>(db, `SELECT * FROM integrations WHERE provider = ? ORDER BY id LIMIT 1`, provider);
}

export async function getIntegrationById(db: Db, id: number): Promise<IntegrationRow | null> {
  return first<IntegrationRow>(db, `SELECT * FROM integrations WHERE id = ?`, id);
}

export async function listIntegrations(db: Db, provider?: IntegrationProvider): Promise<IntegrationRow[]> {
  return provider
    ? all<IntegrationRow>(db, `SELECT * FROM integrations WHERE provider = ? ORDER BY id`, provider)
    : all<IntegrationRow>(db, `SELECT * FROM integrations ORDER BY provider, id`);
}

export async function readCredentials<T>(env: Env, row: IntegrationRow | null): Promise<T | null> {
  if (!row?.encrypted_credentials) return null;
  return JSON.parse(await decryptSecret(keyRing(env), row.encrypted_credentials, `integration:${row.provider}`)) as T;
}

/** provider당 하나만 두는 연동(github, kakao)을 생성하거나 갱신한다. */
export async function upsertSingletonIntegration(
  env: Env,
  db: Db,
  provider: IntegrationProvider,
  input: {
    displayName: string;
    status: IntegrationStatus;
    credentials?: unknown | null;
    metadata?: Record<string, unknown>;
    verifiedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
  now: Date,
): Promise<number> {
  const existing = await getIntegration(db, provider);
  const encrypted =
    input.credentials === undefined
      ? (existing?.encrypted_credentials ?? null)
      : input.credentials === null
        ? null
        : await encryptSecret(keyRing(env), JSON.stringify(input.credentials), `integration:${provider}`);
  const metadata = JSON.stringify(input.metadata ?? parseJson(existing?.metadata_json, {}));
  const iso = now.toISOString();
  if (existing) {
    await run(
      db,
      `UPDATE integrations SET display_name=?, status=?, encrypted_credentials=?, metadata_json=?, last_verified_at=?,
         last_error_code=?, last_error_message_safe=?, updated_at=? WHERE id=?`,
      input.displayName,
      input.status,
      encrypted,
      metadata,
      input.verifiedAt === undefined ? existing.last_verified_at : input.verifiedAt,
      input.errorCode === undefined ? existing.last_error_code : input.errorCode,
      input.errorMessage === undefined ? existing.last_error_message_safe : redact(input.errorMessage),
      iso,
      existing.id,
    );
    return existing.id;
  }
  const res = await run(
    db,
    `INSERT INTO integrations (provider, display_name, status, encrypted_credentials, metadata_json, last_verified_at,
       last_error_code, last_error_message_safe, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    provider,
    input.displayName,
    input.status,
    encrypted,
    metadata,
    input.verifiedAt ?? null,
    input.errorCode ?? null,
    input.errorMessage ? redact(input.errorMessage) : null,
    iso,
    iso,
  );
  return res.meta.last_row_id;
}

export async function markIntegrationStatus(
  db: Db,
  id: number,
  status: IntegrationStatus,
  now: Date,
  error?: { code: string; message: string } | null,
): Promise<void> {
  await run(
    db,
    `UPDATE integrations SET status=?, last_error_code=?, last_error_message_safe=?, updated_at=?,
       last_verified_at = CASE WHEN ? = 'connected' THEN ? ELSE last_verified_at END WHERE id=?`,
    status,
    error?.code ?? null,
    error ? redact(error.message) : null,
    now.toISOString(),
    status,
    now.toISOString(),
    id,
  );
}
