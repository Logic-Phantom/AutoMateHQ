import type { ProjectInput } from './schemas';

/**
 * 온보딩용 프로젝트 템플릿.
 * Logic-Phantom 계정의 기존 자동화 저장소 구성(워크플로 파일·cron)을 참고해 만든 "등록 제안"이다.
 * DB에 자동으로 넣지 않는다. 사용자가 프로젝트 등록 화면에서 골라 확인해야만 저장된다.
 */
export interface ProjectPreset {
  presetId: string;
  hint: string;
  input: Partial<ProjectInput> & Pick<ProjectInput, 'projectKey' | 'name'>;
}

export const PROJECT_PRESETS: ProjectPreset[] = [
  {
    presetId: 'strange-records',
    hint: 'daily-shorts.yml · cron 0 22 * * * (07:00 KST) · YouTube Shorts 생성·업로드',
    input: {
      projectKey: 'strange-records',
      name: '기묘한 기록 (YouTube Shorts)',
      description: 'AI YouTube Shorts 자동 제작·업로드',
      category: 'youtube',
      repoOwner: 'Logic-Phantom',
      repoName: 'StrangeRecords',
      monitoringMode: 'github_actions',
      workflowFile: 'daily-shorts.yml',
      workflowEvent: 'schedule',
      expectedCadence: 'daily',
      expectedTimeLocal: '07:00',
      gracePeriodMinutes: 120,
      priority: 'high',
    },
  },
  {
    presetId: 'factbokai',
    hint: 'daily.yml · 07:00 KST 게시 · Instagram 카드뉴스/Reels',
    input: {
      projectKey: 'factbokai',
      name: '팩폭AI (Instagram)',
      description: 'Instagram 카드 콘텐츠 자동 생성·게시',
      category: 'instagram',
      repoOwner: 'Logic-Phantom',
      repoName: 'FactBokAI',
      monitoringMode: 'github_actions',
      workflowFile: 'daily.yml',
      workflowEvent: 'schedule',
      expectedCadence: 'daily',
      expectedTimeLocal: '07:00',
      gracePeriodMinutes: 120,
      priority: 'high',
    },
  },
  {
    presetId: 'chiply',
    hint: 'daily.yml · 07:07 KST + 백업 07:37/08:07/09:07 · 반도체 브리핑 카카오 발송',
    input: {
      projectKey: 'chiply',
      name: 'CHIPLY 반도체 브리핑',
      description: '미국 증시·반도체 업종 데일리 브리핑',
      category: 'briefing',
      repoOwner: 'Logic-Phantom',
      repoName: 'CHIPLY',
      monitoringMode: 'github_actions',
      workflowFile: 'daily.yml',
      workflowEvent: 'schedule',
      expectedCadence: 'daily',
      expectedTimeLocal: '07:07',
      gracePeriodMinutes: 150,
      priority: 'normal',
    },
  },
  {
    presetId: 'subscription-radar',
    hint: 'daily.yml · 07:07 KST + 백업 · 서울 청약 브리핑',
    input: {
      projectKey: 'subscription-radar',
      name: '서울 청약 브리핑',
      description: '서울 아파트 청약 공고 수집·자격 판정·카카오 발송',
      category: 'briefing',
      repoOwner: 'Logic-Phantom',
      repoName: 'SubscriptionRadar',
      monitoringMode: 'github_actions',
      workflowFile: 'daily.yml',
      workflowEvent: 'schedule',
      expectedCadence: 'daily',
      expectedTimeLocal: '07:07',
      gracePeriodMinutes: 120,
      priority: 'normal',
    },
  },
  {
    presetId: 'fixedcost',
    hint: 'daily.yml · 07:07 KST + 백업 · 고정비 브리핑',
    input: {
      projectKey: 'fixedcost',
      name: '고정비 레이더',
      description: '공과금·구독료·카드 결제 예정 브리핑',
      category: 'briefing',
      repoOwner: 'Logic-Phantom',
      repoName: 'FixedCost',
      monitoringMode: 'github_actions',
      workflowFile: 'daily.yml',
      workflowEvent: 'schedule',
      expectedCadence: 'daily',
      expectedTimeLocal: '07:07',
      gracePeriodMinutes: 120,
      priority: 'normal',
    },
  },
  {
    presetId: 'techlog',
    hint: 'daily-post.yml · 하루 4회 · 기술 블로그 자동 포스팅',
    input: {
      projectKey: 'techlog',
      name: 'TechLog 블로그',
      description: 'Gatsby 기술 블로그 자동 포스팅·배포',
      category: 'other',
      repoOwner: 'Logic-Phantom',
      repoName: 'TechLog',
      monitoringMode: 'github_actions',
      workflowFile: 'daily-post.yml',
      workflowEvent: 'schedule',
      expectedCadence: 'interval',
      intervalHours: 8,
      expectedTimeLocal: null,
      gracePeriodMinutes: 120,
      priority: 'low',
    },
  },
  {
    presetId: 'lunchagree',
    hint: 'ci.yml · PR/push 기반 · 생활형 앱',
    input: {
      projectKey: 'lunchagree',
      name: '점심합의',
      description: '생활형 앱 — 빌드·테스트 CI 감시',
      category: 'app',
      repoOwner: 'Logic-Phantom',
      repoName: 'lunchagree',
      monitoringMode: 'github_actions',
      workflowFile: 'ci.yml',
      workflowEvent: 'any',
      expectedCadence: 'irregular',
      expectedTimeLocal: null,
      gracePeriodMinutes: 60,
      priority: 'low',
    },
  },
];
