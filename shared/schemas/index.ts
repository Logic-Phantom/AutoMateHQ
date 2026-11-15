import { z } from 'zod';
import {
  CADENCES,
  CATEGORIES,
  INCIDENT_STATUSES,
  MAINTENANCE_MODES,
  MONITORING_MODES,
  PLATFORMS,
  PRIORITIES,
  PUBLICATION_STAGES,
  VALUE_SOURCES,
} from '../constants';

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((v) => v.startsWith('https://'), 'https URL만 허용합니다.');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm 형식이어야 합니다.');
const githubName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/, 'GitHub 이름 형식이 아닙니다.');

export const projectKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, '영문 소문자·숫자·하이픈 2~63자');

const projectBaseSchema = z.object({
    projectKey: projectKeySchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    category: z.enum(CATEGORIES).default('other'),
    repoOwner: githubName.nullable().default(null),
    repoName: githubName.nullable().default(null),
    defaultBranch: z.string().trim().max(100).default('main'),
    docsUrl: httpsUrl.nullable().default(null),
    monitoringMode: z.enum(MONITORING_MODES).default('github_actions'),
    expectedCadence: z.enum(CADENCES).default('daily'),
    expectedDays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    intervalHours: z.number().int().min(1).max(168).nullable().default(null),
    expectedTimeLocal: hhmm.nullable().default('07:00'),
    timezone: z.string().trim().max(64).default('Asia/Seoul'),
    gracePeriodMinutes: z.number().int().min(5).max(1440).default(60),
    priority: z.enum(PRIORITIES).default('normal'),
    maintenanceMode: z.enum(MAINTENANCE_MODES).default('AUDIT'),
    maintenanceEnabled: z.boolean().default(false),
    isActive: z.boolean().default(true),
    workflowFile: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.\-/]{1,200}$/)
      .nullable()
      .default(null),
    workflowEvent: z.enum(['schedule', 'any']).default('any'),
  });

type ProjectShape = z.infer<typeof projectBaseSchema>;

/** 프로젝트 필드 사이의 조건 검증. 수정(PATCH) 시에는 기존 값과 합친 결과에 다시 적용한다. */
export function validateProjectShape(v: ProjectShape): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if ((v.repoOwner && !v.repoName) || (!v.repoOwner && v.repoName)) add('repoName', '저장소 owner와 이름을 함께 입력하세요.');
  if ((v.monitoringMode === 'github_actions' || v.monitoringMode === 'github_webhook') && !v.repoOwner)
    add('repoOwner', 'GitHub 모니터링에는 저장소가 필요합니다.');
  if (v.expectedCadence === 'weekly' && v.expectedDays.length === 0) add('expectedDays', '매주 실행 요일을 하나 이상 고르세요.');
  if (v.expectedCadence === 'interval' && !v.intervalHours) add('intervalHours', '실행 간격(시간)을 입력하세요.');
  if (['daily', 'weekdays', 'weekly'].includes(v.expectedCadence) && !v.expectedTimeLocal)
    add('expectedTimeLocal', '기대 실행 시각을 입력하세요.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v.timezone });
  } catch {
    add('timezone', '알 수 없는 시간대입니다.');
  }
  return issues;
}

export const projectInputSchema = projectBaseSchema.superRefine((v, ctx) => {
  for (const issue of validateProjectShape(v)) ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
});
export type ProjectInput = z.infer<typeof projectBaseSchema>;

export const projectPatchSchema = projectBaseSchema.partial().omit({ projectKey: true });

export const loginSchema = z.object({ password: z.string().min(1).max(200) });

export const rerunSchema = z.object({
  confirm: z.literal('RERUN'),
  idempotencyKey: z.string().min(8).max(100),
  failedJobsOnly: z.boolean().default(true),
});

const metricsSchema = z.record(z.string().max(60), z.number().finite()).refine((m) => Object.keys(m).length <= 30, {
  message: 'metrics 항목은 30개 이하',
});

export const publicationEventSchema = z.object({
  platform: z.enum(PLATFORMS),
  contentKey: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).optional(),
  status: z.enum(PUBLICATION_STAGES),
  platformPostId: z.string().trim().max(200).optional(),
  platformUrl: httpsUrl.optional(),
  errorCode: z.string().trim().max(60).optional(),
  message: z.string().trim().max(500).optional(),
  retried: z.boolean().optional(),
  metrics: metricsSchema.optional(),
});
export type PublicationEvent = z.infer<typeof publicationEventSchema>;

/** Heartbeat 공통 계약. secret·토큰은 본문에 넣지 않는다(서명 헤더만 사용). */
export const heartbeatSchema = z.object({
  projectKey: projectKeySchema,
  source: z.string().trim().min(1).max(60).default('heartbeat'),
  runId: z.string().trim().min(1).max(120),
  status: z.enum(['running', 'success', 'failure', 'cancelled', 'skipped']).optional(),
  stage: z.string().trim().max(60).optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  externalUrl: httpsUrl.optional(),
  errorCode: z.string().trim().max(60).optional(),
  metrics: metricsSchema.optional(),
  message: z.string().trim().max(500).optional(),
  publication: publicationEventSchema.optional(),
});
export type HeartbeatPayload = z.infer<typeof heartbeatSchema>;

export const incidentActionSchema = z.object({ note: z.string().trim().max(500).optional() });
export const incidentFilterSchema = z.object({ status: z.enum(INCIDENT_STATUSES).optional() });

export const githubTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(400)
    .regex(/^(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+$/, 'GitHub 토큰 형식이 아닙니다.'),
});

/** 공식 문서의 Routine Fire URL 형식만 허용한다(SSRF 방지). */
export const ROUTINE_FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{8,64}\/fire$/;
export const routineInputSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  purpose: z.enum(['audit', 'draft_pr', 'incident']),
  fireUrl: z.string().trim().regex(ROUTINE_FIRE_URL_RE, 'Routine Fire URL 형식이 아닙니다.'),
  token: z
    .string()
    .trim()
    .regex(/^sk-ant-oat01-[A-Za-z0-9_-]{10,}$/, 'Routine 토큰 형식이 아닙니다.'),
});

export const maintenanceRunSchema = z.object({
  mode: z.enum(MAINTENANCE_MODES).default('AUDIT'),
  incidentId: z.number().int().positive().optional(),
  instructions: z.string().trim().max(2000).optional(),
});

export const maintenanceCallbackSchema = z.object({
  jobId: z.number().int().positive(),
  status: z.enum(['running', 'completed', 'failed']),
  summary: z.string().trim().max(4000).optional(),
  testsPassed: z.boolean().nullable().optional(),
  branchName: z.string().trim().max(200).optional(),
  pullRequestUrl: httpsUrl.optional(),
  findings: z
    .array(
      z.object({
        title: z.string().trim().max(200),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('info'),
        detail: z.string().trim().max(1000).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export const maintenanceDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  pullRequestUrl: httpsUrl.optional(),
  note: z.string().trim().max(500).optional(),
});

export const manualUsageSchema = z.object({
  projectId: z.number().int().positive().nullable().default(null),
  provider: z.string().trim().min(1).max(40),
  metricName: z.string().trim().min(1).max(60),
  metricValue: z.number().finite().nullable().default(null),
  unit: z.string().trim().max(20).default(''),
  amount: z.number().finite().nullable().default(null),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  note: z.string().trim().max(300).optional(),
});

export const notificationSettingsSchema = z.object({
  dailyReportEnabled: z.boolean().optional(),
  instantAlertsEnabled: z.boolean().optional(),
  alertCooldownMinutes: z.number().int().min(10).max(1440).optional(),
});

export const valueSourceSchema = z.enum(VALUE_SOURCES);
