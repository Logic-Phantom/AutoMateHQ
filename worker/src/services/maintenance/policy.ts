import { MAINTENANCE_MODE_RANK, type MaintenanceMode } from '../../../../shared/constants';

/**
 * 유지보수 안전 정책(순수 함수).
 * - 기본 AUDIT(읽기 전용). DRAFT_PR은 프로젝트별로 사용자가 명시적으로 켜야 한다.
 * - 기본 브랜치 직접 push·자동 merge 금지.
 * - 테스트 미통과/미검증 결과는 성공으로 표시하지 않는다.
 */
export interface PolicyProject {
  maintenanceEnabled: boolean;
  maintenanceMode: MaintenanceMode;
  defaultBranch: string;
  isActive: boolean;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export function checkMaintenancePolicy(project: PolicyProject, requested: MaintenanceMode): PolicyDecision {
  if (!project.isActive) return { allowed: false, reason: '비활성 프로젝트입니다.' };
  if (requested === 'AUDIT') return { allowed: true }; // 읽기 전용 점검은 항상 허용
  if (!project.maintenanceEnabled) return { allowed: false, reason: '이 프로젝트는 자동 유지보수가 꺼져 있습니다(AUDIT만 가능).' };
  if (MAINTENANCE_MODE_RANK[requested] > MAINTENANCE_MODE_RANK[project.maintenanceMode]) {
    return { allowed: false, reason: `허용 범위(${project.maintenanceMode})를 넘는 모드(${requested})입니다.` };
  }
  return { allowed: true };
}

/** 금지 변경 범위. Routine 프롬프트와 결과 검증에 함께 쓴다. */
export const FORBIDDEN_CHANGES = [
  '기본 브랜치에 직접 push',
  'PR 자동 merge',
  '운영 배포',
  'DB 스키마 파괴적 변경·데이터 마이그레이션',
  'secret/credential 추가·변경',
  'CI/워크플로 권한(permissions) 확대',
  '인증·결제·게시(업로드) 로직 변경',
  '대규모 리팩터링·다수 파일 삭제',
];

export interface CallbackVerdict {
  status: 'completed' | 'needs_review' | 'failed' | 'running';
  flags: string[];
}

/** Routine 결과 판정. PR이 있는데 테스트 통과가 확인되지 않으면 needs_review. */
export function judgeCallback(
  mode: MaintenanceMode,
  defaultBranch: string,
  cb: { status: 'running' | 'completed' | 'failed'; testsPassed?: boolean | null; branchName?: string; pullRequestUrl?: string },
): CallbackVerdict {
  const flags: string[] = [];
  if (cb.status === 'running') return { status: 'running', flags };
  if (cb.status === 'failed') return { status: 'failed', flags };
  if (cb.branchName && cb.branchName === defaultBranch) flags.push('기본 브랜치 변경이 보고됨 — 정책 위반 여부 확인 필요');
  if (mode !== 'DRAFT_PR' && (cb.pullRequestUrl || cb.branchName)) flags.push(`${mode} 모드인데 브랜치/PR이 보고됨 — 정책 위반 여부 확인 필요`);
  if (cb.pullRequestUrl && cb.testsPassed !== true) flags.push(cb.testsPassed === false ? '테스트 실패' : '테스트 결과 미확인');
  return { status: flags.length ? 'needs_review' : 'completed', flags };
}

export function buildRoutinePrompt(input: {
  mode: MaintenanceMode;
  jobId: number;
  project: { name: string; repo: string | null; defaultBranch: string; projectKey: string };
  incident?: { title: string; description: string; category: string } | null;
  recentFailures: { workflow: string | null; startedAt: string | null; url: string | null; error: string | null }[];
  instructions?: string | null;
  callback?: { url: string; token: string } | null;
}): string {
  const modeRule: Record<MaintenanceMode, string> = {
    AUDIT: '읽기 전용 점검만 수행한다. 파일을 수정하거나 브랜치·커밋·PR·이슈를 만들지 않는다.',
    PROPOSE: '개선안을 보고서로 작성한다. 코드 수정·브랜치·PR은 만들지 않는다.',
    DRAFT_PR: `별도 브랜치(hq/maint-${input.jobId}-*)에서만 최소 수정하고, 테스트·lint를 실행한 뒤 Draft PR을 만든다. 테스트가 실패하면 PR 본문 첫 줄에 "⚠️ 테스트 실패/미검증"을 명시한다.`,
  };
  const lines = [
    '# AI Automation HQ 유지보수 요청',
    `jobId: ${input.jobId}`,
    `mode: ${input.mode}`,
    `project: ${input.project.name} (${input.project.projectKey})`,
    `repository: ${input.project.repo ?? '(미연결)'}  default branch: ${input.project.defaultBranch}`,
    '',
    '## 모드 규칙',
    modeRule[input.mode],
    '',
    '## 절대 금지',
    ...FORBIDDEN_CHANGES.map((x) => `- ${x}`),
    '- 회사 고객 소스·민감 데이터 외부 전송',
    '',
  ];
  if (input.incident) {
    lines.push('## 관련 장애', `- [${input.incident.category}] ${input.incident.title}`, input.incident.description.slice(0, 1000), '');
  }
  if (input.recentFailures.length) {
    lines.push('## 최근 실패 실행');
    for (const f of input.recentFailures.slice(0, 5)) lines.push(`- ${f.startedAt ?? '-'} ${f.workflow ?? ''} ${f.error ?? ''} ${f.url ?? ''}`);
    lines.push('');
  }
  if (input.instructions) lines.push('## 사용자 추가 지시', input.instructions, '');
  lines.push(
    '## 보고',
    '원인 분석, 발견 사항(심각도 포함), 테스트 결과(통과/실패/미실행)를 한국어로 요약한다. 확인되지 않은 원인은 추측하지 말고 "원인 분석 필요"로 쓴다.',
  );
  if (input.callback) {
    lines.push(
      '',
      '## 결과 회신(선택)',
      `작업이 끝나면 다음 주소로 결과 JSON을 POST 한다: ${input.callback.url}`,
      `헤더 Authorization: Bearer ${input.callback.token}`,
      '본문 예: {"jobId":' + input.jobId + ',"status":"completed","summary":"…","testsPassed":true,"branchName":"…","pullRequestUrl":"https://github.com/…","findings":[{"title":"…","severity":"medium"}]}',
    );
  }
  return lines.join('\n');
}
