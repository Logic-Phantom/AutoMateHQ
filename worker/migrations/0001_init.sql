-- AI Automation HQ 초기 스키마
-- 모든 시각은 UTC ISO-8601 문자열로 저장한다. 화면·보고서에서만 사용자 시간대로 변환한다.
-- 비밀 값은 *_encrypted 컬럼에 AES-GCM 암호문으로만 저장한다(평문 금지).

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  repo_owner TEXT,
  repo_name TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  repository_url TEXT,
  docs_url TEXT,
  monitoring_mode TEXT NOT NULL DEFAULT 'github_actions',
  expected_cadence TEXT NOT NULL DEFAULT 'daily',
  expected_days TEXT NOT NULL DEFAULT '',          -- ISO 요일 CSV (1=월 … 7=일), weekly 전용
  interval_hours INTEGER,                          -- interval 전용
  expected_time_local TEXT,                        -- HH:mm
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  grace_period_minutes INTEGER NOT NULL DEFAULT 60,
  priority TEXT NOT NULL DEFAULT 'normal',
  maintenance_mode TEXT NOT NULL DEFAULT 'AUDIT' CHECK (maintenance_mode IN ('AUDIT','PROPOSE','DRAFT_PR')),
  maintenance_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_sync_error_code TEXT,
  last_status TEXT,                                -- 마지막 판정(NORMAL/FAILED/ATTENTION/UNKNOWN)
  last_status_reason TEXT,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_projects_active ON projects (is_active, deleted_at);
CREATE INDEX idx_projects_repo ON projects (repo_owner, repo_name);

CREATE TABLE integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_connected',
  encrypted_credentials TEXT,
  credential_key_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',        -- 비밀 값 제외
  last_verified_at TEXT,
  last_error_code TEXT,
  last_error_message_safe TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_integrations_provider ON integrations (provider);

CREATE TABLE project_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source_type TEXT NOT NULL,                       -- github_actions/heartbeat/youtube/instagram/custom_api
  external_identifier TEXT NOT NULL DEFAULT '',    -- 예: 워크플로 파일명
  expected_cadence_override TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',          -- 비밀 값 제외
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_type, external_identifier)
);

-- 프로젝트별 Heartbeat 서명 비밀 값. 원문은 발급 시 한 번만 보여 주고 암호문만 남긴다.
CREATE TABLE project_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'heartbeat',
  secret_encrypted TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  secret_hint TEXT NOT NULL,                       -- 앞 4자리만(식별용)
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_project_secrets_active ON project_secrets (project_id, kind, revoked_at);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source_id INTEGER REFERENCES project_sources(id),
  source_type TEXT NOT NULL,                       -- github_actions/heartbeat
  external_run_id TEXT NOT NULL,
  idempotency_key TEXT,
  trigger_type TEXT,                               -- schedule/push/workflow_dispatch/heartbeat/rerun …
  workflow_name TEXT,
  run_attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,                            -- queued/running/success/failure/cancelled/skipped/unknown
  stage TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_seconds INTEGER,
  branch TEXT,
  commit_sha TEXT,
  external_url TEXT,
  summary TEXT,
  error_code TEXT,
  safe_error_message TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_type, external_run_id)
);
CREATE INDEX idx_runs_project_started ON runs (project_id, started_at DESC);
CREATE INDEX idx_runs_started ON runs (started_at DESC);

-- 실행 단위 이벤트 타임라인(heartbeat start/complete/fail, webhook 갱신, 재실행 요청 등)
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  event_type TEXT NOT NULL,
  status TEXT,
  stage TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_run_events_run ON run_events (run_id, created_at);

-- 재실행 요청 중복 방지
CREATE TABLE rerun_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,                            -- requested/accepted/rejected/failed
  response_code INTEGER,
  safe_error_message TEXT,
  github_run_url TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_type TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  processing_status TEXT NOT NULL,                 -- processed/ignored/duplicate/rejected/failed
  received_at TEXT NOT NULL,
  processed_at TEXT,
  safe_error_message TEXT,
  UNIQUE (provider, delivery_id)
);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  source_id INTEGER REFERENCES project_sources(id),
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  related_run_id INTEGER REFERENCES runs(id),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_notified_at TEXT,
  last_notified_severity TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
-- 같은 fingerprint의 미해결 incident는 하나만 존재한다
CREATE UNIQUE INDEX idx_incidents_open_fp ON incidents (fingerprint) WHERE status IN ('open','acknowledged');
CREATE INDEX idx_incidents_status ON incidents (status, last_seen_at DESC);

CREATE TABLE maintenance_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  incident_id INTEGER REFERENCES incidents(id),
  integration_id INTEGER REFERENCES integrations(id),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  analysis_kind TEXT NOT NULL DEFAULT 'rule_based', -- rule_based / claude_routine
  routine_session_id TEXT,
  routine_session_url TEXT,
  callback_token_hash TEXT,
  branch_name TEXT,
  pull_request_url TEXT,
  tests_passed INTEGER,                            -- NULL=미확인, 0=실패, 1=통과
  summary TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  started_at TEXT,
  completed_at TEXT,
  approval_state TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/not_required
  actor TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_maintenance_project ON maintenance_jobs (project_id, created_at DESC);

CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  platform TEXT NOT NULL,
  content_key TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  generated_at TEXT,
  upload_started_at TEXT,
  published_at TEXT,
  platform_post_id TEXT,
  platform_url TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified', -- heartbeat_reported/official_api_verified/unverified
  failed_stage TEXT,
  error_code TEXT,
  safe_error_message TEXT,
  retried INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, platform, content_key)
);
CREATE INDEX idx_publications_updated ON publications (updated_at DESC);

CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  provider TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL,
  unit TEXT NOT NULL DEFAULT '',
  amount REAL,
  currency TEXT,
  value_source TEXT NOT NULL CHECK (value_source IN ('ACTUAL','ESTIMATED','MANUAL','UNAVAILABLE')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_usage_period ON usage_records (period_start, provider);

CREATE TABLE daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date_local TEXT NOT NULL UNIQUE,          -- Asia/Seoul 날짜 YYYY-MM-DD
  timezone TEXT NOT NULL,
  report_json TEXT NOT NULL,
  rendered_message TEXT NOT NULL,
  status TEXT NOT NULL,                            -- generated/sending/sent/failed/skipped
  attempt_count INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  sent_at TEXT,
  provider_message_id TEXT,
  safe_error_message TEXT
);

CREATE TABLE notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                           -- kakao
  notification_type TEXT NOT NULL,                 -- daily_report/test/incident_alert/recovery
  dedupe_key TEXT,
  status TEXT NOT NULL,                            -- sent/failed/skipped
  payload_summary TEXT,
  sent_at TEXT,
  provider_response_code TEXT,
  safe_error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_created ON notification_deliveries (created_at DESC);
CREATE INDEX idx_notifications_dedupe ON notification_deliveries (dedupe_key, created_at DESC);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);

-- 관리자 세션. 토큰 원문이 아닌 SHA-256 해시만 저장한다.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash TEXT
);

-- 고정 창(fixed window) 방식의 범용 호출 제한 카운터
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_end TEXT NOT NULL
);

-- OAuth state(CSRF 방지). 해시만 저장하고 1회 사용 후 삭제한다.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Heartbeat 재전송 방지(nonce = project + runId + event + timestamp)
CREATE TABLE heartbeat_nonces (
  nonce TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- scheduled job 중복 실행 방지용 임대(lease) 잠금
CREATE TABLE job_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
