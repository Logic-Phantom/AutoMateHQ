// 프런트엔드와 Worker가 함께 쓰는 상수. 값 문자열은 DB에 그대로 저장되므로 바꾸지 않는다.

export const DEFAULT_TIMEZONE = 'Asia/Seoul';

export const PROJECT_STATUSES = ['NORMAL', 'FAILED', 'ATTENTION', 'UNKNOWN'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  NORMAL: '정상',
  FAILED: '실패',
  ATTENTION: '확인 필요',
  UNKNOWN: '확인 불가',
};

export const CATEGORIES = ['youtube', 'instagram', 'briefing', 'app', 'devtool', 'other'] as const;
export type ProjectCategory = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<ProjectCategory, string> = {
  youtube: 'YouTube 자동화',
  instagram: 'Instagram 자동화',
  briefing: '정보 브리핑',
  app: '생활형 앱',
  devtool: '개발 도구',
  other: '기타',
};

export const MONITORING_MODES = ['github_actions', 'github_webhook', 'heartbeat', 'official_api', 'manual'] as const;
export type MonitoringMode = (typeof MONITORING_MODES)[number];
export const MONITORING_MODE_LABEL: Record<MonitoringMode, string> = {
  github_actions: 'GitHub Actions 조회',
  github_webhook: 'GitHub Webhook',
  heartbeat: 'Heartbeat',
  official_api: '공식 API',
  manual: '수동',
};

export const CADENCES = ['daily', 'weekdays', 'weekly', 'interval', 'irregular'] as const;
export type Cadence = (typeof CADENCES)[number];
export const CADENCE_LABEL: Record<Cadence, string> = {
  daily: '매일',
  weekdays: '평일',
  weekly: '매주(요일 지정)',
  interval: 'N시간마다',
  irregular: '비정기',
};

export const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { critical: '최상', high: '높음', normal: '보통', low: '낮음' };

export const MAINTENANCE_MODES = ['AUDIT', 'PROPOSE', 'DRAFT_PR'] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];
export const MAINTENANCE_MODE_LABEL: Record<MaintenanceMode, string> = {
  AUDIT: '읽기 전용 점검',
  PROPOSE: '개선안 제안',
  DRAFT_PR: 'Draft PR 생성',
};
export const MAINTENANCE_MODE_RANK: Record<MaintenanceMode, number> = { AUDIT: 0, PROPOSE: 1, DRAFT_PR: 2 };

export const RUN_STATUSES = ['queued', 'running', 'success', 'failure', 'cancelled', 'skipped', 'unknown'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: '대기',
  running: '실행 중',
  success: '성공',
  failure: '실패',
  cancelled: '취소',
  skipped: '건너뜀',
  unknown: '알 수 없음',
};

export const PUBLICATION_STAGES = [
  'planned',
  'generating',
  'generated',
  'uploading',
  'published',
  'failed',
  'verification_pending',
] as const;
export type PublicationStage = (typeof PUBLICATION_STAGES)[number];
export const PUBLICATION_STAGE_LABEL: Record<PublicationStage, string> = {
  planned: '계획됨',
  generating: '생성 중',
  generated: '생성 완료',
  uploading: '업로드 중',
  published: '게시 완료 보고됨',
  failed: '실패',
  verification_pending: '게시 확인 대기',
};
export const PLATFORMS = ['youtube', 'instagram', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** 게시 확인 출처. heartbeat 보고와 공식 API 검증을 절대 같은 것으로 취급하지 않는다. */
export const VERIFICATION_SOURCES = ['heartbeat_reported', 'official_api_verified', 'unverified'] as const;
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

export const INCIDENT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const SEVERITY_RANK: Record<IncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  critical: '치명',
  high: '높음',
  medium: '보통',
  low: '낮음',
};
export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved', 'suppressed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const VALUE_SOURCES = ['ACTUAL', 'ESTIMATED', 'MANUAL', 'UNAVAILABLE'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];
export const VALUE_SOURCE_LABEL: Record<ValueSource, string> = {
  ACTUAL: '실제',
  ESTIMATED: '추정',
  MANUAL: '수동',
  UNAVAILABLE: '확인 불가',
};

export const INTEGRATION_PROVIDERS = ['github', 'kakao', 'claude_routine', 'youtube', 'instagram', 'custom'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['not_connected', 'connected', 'error', 'reauth_required'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  not_connected: '미연결',
  connected: '연결됨',
  error: '오류',
  reauth_required: '재연결 필요',
};

export const MAINTENANCE_JOB_STATUSES = [
  'not_configured',
  'blocked',
  'rule_based_done',
  'started',
  'running',
  'completed',
  'needs_review',
  'failed',
  'cancelled',
] as const;
export type MaintenanceJobStatus = (typeof MAINTENANCE_JOB_STATUSES)[number];
export const MAINTENANCE_JOB_STATUS_LABEL: Record<MaintenanceJobStatus, string> = {
  not_configured: 'Claude Code 연결 필요',
  blocked: '정책상 차단',
  rule_based_done: '규칙 기반 점검 완료',
  started: '시작됨(세션 생성)',
  running: '실행 중',
  completed: '완료',
  needs_review: '검토 필요(테스트 미통과/미검증)',
  failed: '실패',
  cancelled: '취소',
};

/** GitHub/외부 API 오류 분류. 401·403·404·rate limit을 같은 오류로 뭉치지 않는다. */
export const API_ERROR_CODES = [
  'AUTH_INVALID',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'UPSTREAM_ERROR',
  'NETWORK_ERROR',
  'NOT_CONFIGURED',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export const API_ERROR_LABEL: Record<ApiErrorCode, string> = {
  AUTH_INVALID: '인증 오류(401)',
  PERMISSION_DENIED: '권한 부족(403)',
  RATE_LIMITED: '호출 제한',
  NOT_FOUND: '대상 없음(404)',
  VALIDATION_FAILED: '요청 검증 실패(422)',
  UPSTREAM_ERROR: '외부 서비스 오류(5xx)',
  NETWORK_ERROR: '네트워크/시간 초과',
  NOT_CONFIGURED: '미연동',
};

/** 정기 보고서를 보낼 수 있는 한국 시간 구간. 07:00에 못 보내면 이 시각 전까지 따라잡는다. */
export const DAILY_REPORT_HOUR = 7;
export const DAILY_REPORT_CATCHUP_END_HOUR = 12;

/** 카카오 기본 텍스트 템플릿의 text 최대 길이(공식 문서: 최대 200자). */
export const KAKAO_TEXT_LIMIT = 200;
export const KAKAO_MAX_MESSAGES_PER_REPORT = 3;
