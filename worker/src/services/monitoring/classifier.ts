import type { IncidentSeverity, ProjectStatus } from '../../../../shared/constants';
import { EARLY_START_TOLERANCE_MINUTES, lastDueOccurrence, nextOccurrence, type ScheduleConfig } from './schedule';

/**
 * 프로젝트 상태 판정(순수 함수).
 * - NORMAL: 최신 예정 실행이 정상 완료되고 주요 연동이 확인됨
 * - FAILED: 최근 실행 실패 또는 심각한 API/업로드 오류
 * - ATTENTION: 지연·미실행 의심·인증 문제·수집 실패 등 조치 필요
 * - UNKNOWN: 연결 없음/데이터 부족. 절대 NORMAL로 간주하지 않는다.
 */
export interface RunLite {
  id: number;
  status: string; // queued/running/success/failure/cancelled/skipped/unknown
  startedAt: string | null;
  completedAt: string | null;
  workflowName?: string | null;
  errorCode?: string | null;
  safeErrorMessage?: string | null;
}

export interface PublicationLite {
  status: string;
  platform: string;
  title: string | null;
  updatedAt: string;
  errorCode?: string | null;
}

export interface SignalInput {
  project: {
    id: number;
    isActive: boolean;
    monitoringMode: string;
    hasGithubSource: boolean;
    hasHeartbeatSource: boolean;
    createdAt: string;
    schedule: ScheduleConfig;
  };
  runs: RunLite[]; // 최신순
  publications: PublicationLite[]; // 최신순
  /** 프로젝트에 영향을 주는 연동 상태(GitHub 토큰 등) */
  githubIntegrationStatus: 'connected' | 'not_connected' | 'error' | 'reauth_required';
  githubIntegrationError?: string | null;
  lastSyncErrorCode: string | null;
  /** 이벤트로 생긴(엔진이 직접 관리하지 않는) 미해결 incident */
  externalIncidents: { severity: IncidentSeverity; title: string; category: string }[];
  now: Date;
}

export interface Reason {
  code:
    | 'RUN_FAILED'
    | 'MISSED_RUN'
    | 'LONG_RUNNING'
    | 'COLLECTION_ERROR'
    | 'INTEGRATION_ERROR'
    | 'PUBLICATION_FAILED'
    | 'PUBLICATION_UNVERIFIED'
    | 'NO_DATA'
    | 'BASELINE'
    | 'NOT_CONNECTED'
    | 'EXTERNAL_INCIDENT'
    | 'OK';
  severity: IncidentSeverity | 'info';
  message: string;
  relatedRunId?: number;
  /** 이 사유로 incident를 자동 관리할지 */
  managed: boolean;
}

export interface Classification {
  status: ProjectStatus;
  reasons: Reason[];
  lastRun: RunLite | null;
  lastSuccessAt: string | null;
  nextExpectedAt: string | null;
  dueAt: string | null;
}

export const BASELINE_HOURS = 24;
export const LONG_RUNNING_HOURS = 3;

const FAILED_STATES = new Set(['failure']);

export function classify(input: SignalInput): Classification {
  const { project, runs, now } = input;
  const reasons: Reason[] = [];
  const lastRun = runs[0] ?? null;
  const lastSuccess = runs.find((r) => r.status === 'success') ?? null;
  const lastStart = runs.find((r) => r.startedAt)?.startedAt ?? null;
  const lastStartDate = lastStart ? new Date(lastStart) : null;
  const due = lastDueOccurrence(project.schedule, now, lastStartDate);
  const next = nextOccurrence(project.schedule, now, lastStartDate);

  const usesGithub = project.hasGithubSource;
  const hasAnySource = usesGithub || project.hasHeartbeatSource || project.monitoringMode === 'manual';

  // 1) 연결 자체가 없으면 판단 불가
  if (!hasAnySource) {
    reasons.push({ code: 'NOT_CONNECTED', severity: 'info', message: '모니터링 소스가 연결되지 않았습니다.', managed: false });
  }
  if (usesGithub && input.githubIntegrationStatus !== 'connected') {
    const severe = input.githubIntegrationStatus === 'error' || input.githubIntegrationStatus === 'reauth_required';
    reasons.push({
      code: severe ? 'INTEGRATION_ERROR' : 'NOT_CONNECTED',
      severity: severe ? 'high' : 'info',
      message: severe
        ? `GitHub 연동 오류: ${input.githubIntegrationError ?? '재연결 필요'}`
        : 'GitHub 토큰이 연결되지 않아 실행 기록을 가져올 수 없습니다.',
      managed: false,
    });
  }

  // 2) 수집 실패는 프로젝트 실패와 구별한다
  if (input.lastSyncErrorCode && input.githubIntegrationStatus === 'connected') {
    reasons.push({
      code: 'COLLECTION_ERROR',
      severity: 'medium',
      message: `실행 기록 수집 실패(${input.lastSyncErrorCode}). 프로젝트 자체 실패가 아닐 수 있습니다.`,
      managed: true,
    });
  }

  // 3) 최근 실행 결과
  const lastCompleted = runs.find((r) => r.status !== 'running' && r.status !== 'queued') ?? null;
  if (lastCompleted && FAILED_STATES.has(lastCompleted.status)) {
    reasons.push({
      code: 'RUN_FAILED',
      severity: 'high',
      message: `최근 실행 실패${lastCompleted.workflowName ? `(${lastCompleted.workflowName})` : ''}${
        lastCompleted.safeErrorMessage ? `: ${lastCompleted.safeErrorMessage}` : lastCompleted.errorCode ? `: ${lastCompleted.errorCode}` : ': 원인 분석 필요'
      }`,
      relatedRunId: lastCompleted.id,
      managed: true,
    });
  }

  // 4) 장시간 실행
  const running = runs.find((r) => r.status === 'running' && r.startedAt);
  if (running && now.getTime() - new Date(running.startedAt!).getTime() > LONG_RUNNING_HOURS * 3600_000) {
    reasons.push({
      code: 'LONG_RUNNING',
      severity: 'medium',
      message: `${LONG_RUNNING_HOURS}시간 넘게 실행 중입니다.`,
      relatedRunId: running.id,
      managed: true,
    });
  }

  // 5) 미실행 탐지(예정일·유예 시간·기준선 반영)
  const baselineEnd = new Date(project.createdAt).getTime() + BASELINE_HOURS * 3600_000;
  if (due && hasAnySource) {
    const windowStart = due.getTime() - EARLY_START_TOLERANCE_MINUTES * 60_000;
    const covered = runs.some((r) => r.startedAt && new Date(r.startedAt).getTime() >= windowStart);
    if (!covered) {
      if (due.getTime() < baselineEnd) {
        reasons.push({ code: 'BASELINE', severity: 'info', message: '최근 등록되어 기준 실행을 수집하는 중입니다.', managed: false });
      } else if (!(usesGithub && input.githubIntegrationStatus !== 'connected')) {
        reasons.push({
          code: 'MISSED_RUN',
          severity: 'medium',
          message: '예정 실행 시간이 지났지만 새 실행 기록이 없습니다.',
          managed: true,
        });
      }
    }
  }

  // 6) 게시 단계: 파이프라인 성공과 게시 완료를 구분한다
  const latestPub = input.publications[0];
  if (latestPub && latestPub.status === 'failed') {
    reasons.push({
      code: 'PUBLICATION_FAILED',
      severity: 'high',
      message: `${latestPub.platform} 게시 실패${latestPub.errorCode ? `(${latestPub.errorCode})` : ''}: ${latestPub.title ?? '콘텐츠'}`,
      managed: true,
    });
  } else if (latestPub && latestPub.status === 'verification_pending') {
    reasons.push({ code: 'PUBLICATION_UNVERIFIED', severity: 'low', message: '게시 확인 대기 중입니다.', managed: false });
  }

  for (const inc of input.externalIncidents) {
    reasons.push({ code: 'EXTERNAL_INCIDENT', severity: inc.severity, message: inc.title, managed: false });
  }

  // 판정
  const severe = reasons.some(
    (r) =>
      (r.code === 'RUN_FAILED' || r.code === 'PUBLICATION_FAILED') ||
      (r.code === 'EXTERNAL_INCIDENT' && (r.severity === 'high' || r.severity === 'critical')),
  );
  const attention = reasons.some((r) =>
    ['MISSED_RUN', 'LONG_RUNNING', 'COLLECTION_ERROR', 'INTEGRATION_ERROR', 'EXTERNAL_INCIDENT', 'PUBLICATION_UNVERIFIED'].includes(r.code),
  );
  let status: ProjectStatus;
  if (severe) status = 'FAILED';
  else if (attention) status = 'ATTENTION';
  else if (reasons.some((r) => r.code === 'NOT_CONNECTED') || !lastRun) status = 'UNKNOWN';
  else if (lastSuccess || lastRun.status === 'running' || lastRun.status === 'queued' || lastRun.status === 'skipped')
    status = 'NORMAL';
  else status = 'UNKNOWN';

  if (status === 'UNKNOWN' && !reasons.some((r) => r.code === 'NOT_CONNECTED' || r.code === 'BASELINE')) {
    reasons.push({ code: 'NO_DATA', severity: 'info', message: '판단할 실행 기록이 없습니다.', managed: false });
  }
  if (status === 'NORMAL') reasons.push({ code: 'OK', severity: 'info', message: '최근 실행 정상', managed: false });

  return {
    status,
    reasons,
    lastRun,
    lastSuccessAt: lastSuccess?.completedAt ?? lastSuccess?.startedAt ?? null,
    nextExpectedAt: next?.toISOString() ?? null,
    dueAt: due?.toISOString() ?? null,
  };
}

/** 대시보드·보고서 요약 집계. 비활성 프로젝트는 제외하고 프로젝트당 한 번만 센다. */
export function summarize(statuses: { isActive: boolean; status: ProjectStatus }[]) {
  const active = statuses.filter((s) => s.isActive);
  const counts = { total: active.length, NORMAL: 0, FAILED: 0, ATTENTION: 0, UNKNOWN: 0 };
  for (const s of active) counts[s.status] += 1;
  return counts;
}

export function primaryReason(c: Classification): Reason | undefined {
  const order: Reason['code'][] = [
    'RUN_FAILED',
    'PUBLICATION_FAILED',
    'EXTERNAL_INCIDENT',
    'INTEGRATION_ERROR',
    'MISSED_RUN',
    'LONG_RUNNING',
    'COLLECTION_ERROR',
    'PUBLICATION_UNVERIFIED',
    'NOT_CONNECTED',
    'BASELINE',
    'NO_DATA',
    'OK',
  ];
  return [...c.reasons].sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))[0];
}
