// 화면에서 쓰는 API 응답 타입(Worker 응답 형태와 맞춘다)
export interface ProjectDto {
  id: number;
  projectKey: string;
  name: string;
  description: string;
  category: string;
  repoOwner: string | null;
  repoName: string | null;
  defaultBranch: string;
  repositoryUrl: string | null;
  docsUrl: string | null;
  monitoringMode: string;
  expectedCadence: string;
  expectedDays: number[];
  intervalHours: number | null;
  expectedTimeLocal: string | null;
  timezone: string;
  gracePeriodMinutes: number;
  priority: string;
  maintenanceMode: 'AUDIT' | 'PROPOSE' | 'DRAFT_PR';
  maintenanceEnabled: boolean;
  isActive: boolean;
  workflowFile: string | null;
  workflowEvent: 'schedule' | 'any';
  commitFilter: string | null;
  hasHeartbeat: boolean;
  lastSyncedAt: string | null;
  lastSyncErrorCode: string | null;
  status: string;
  statusReason: string | null;
  createdAt: string;
}

export interface IncidentDto {
  id: number;
  projectId: number | null;
  projectName?: string | null;
  fingerprint: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  title: string;
  description: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  relatedRunId: number | null;
  occurrenceCount: number;
}

export interface IntegrationDto {
  id: number;
  provider: string;
  displayName: string;
  status: string;
  hasCredentials: boolean;
  metadata: Record<string, unknown>;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface KakaoStatusDto {
  configured: boolean;
  clientSecretConfigured: boolean;
  redirectUri: string | null;
  status: string;
  lastVerifiedAt: string | null;
  lastRefreshAt: string | null;
  refreshExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastDelivery: { notification_type: string; status: string; sent_at: string | null; created_at: string; safe_error_message: string | null } | null;
}

export interface OverviewDto {
  mode: 'live' | 'demo';
  generatedAt: string;
  kpi: { activeProjects: number; normal: number; failed: number; attention: number; unknown: number; runs24h: number; failures24h: number };
  projects: {
    id: number;
    name: string;
    category: string;
    priority: string;
    isActive: boolean;
    status: string;
    reason: string | null;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastSuccessAt: string | null;
    nextExpectedAt: string | null;
  }[];
  openIncidents: IncidentDto[];
  integrations: IntegrationDto[];
  githubWebhookSecretConfigured: boolean;
  kakao: KakaoStatusDto;
  todayReport: { reportDate: string; status: string; sentAt: string | null; error: string | null } | null;
}

export interface RunRow {
  id: number;
  projectId: number;
  projectName: string;
  category?: string;
  sourceType: string;
  workflowName: string | null;
  triggerType?: string | null;
  status: string;
  stage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds?: number | null;
  branch?: string | null;
  commitSha?: string | null;
  externalUrl: string | null;
  errorCode?: string | null;
  safeErrorMessage?: string | null;
  runAttempt?: number;
  rerunStatus?: string | null;
}

export interface MaintenanceJobDto {
  id: number;
  projectId: number;
  projectName?: string;
  incidentId: number | null;
  mode: string;
  status: string;
  analysisKind: string;
  routineSessionUrl: string | null;
  branchName: string | null;
  pullRequestUrl: string | null;
  testsPassed: boolean | null;
  summary: string | null;
  findings: { title: string; severity: string; detail?: string }[];
  startedAt: string | null;
  completedAt: string | null;
  approvalState: string;
  createdAt: string;
}

export interface DailyReportDto {
  reportDate: string;
  generatedAt: string;
  timezone: string;
  counts: { total: number; NORMAL: number; FAILED: number; ATTENTION: number; UNKNOWN: number };
  failed: ReportItem[];
  attention: ReportItem[];
  unknown: ReportItem[];
  normal: ReportItem[];
  globalIssues: string[];
  analysisKind: 'ai' | 'rule';
  analysis: string;
  isSample: boolean;
}
export interface ReportItem {
  projectId: number;
  name: string;
  status: string;
  reason: string;
  lastRunAt: string | null;
  lastRunUrl: string | null;
}
