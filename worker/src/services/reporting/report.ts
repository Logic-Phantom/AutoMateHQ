import { KAKAO_MAX_MESSAGES_PER_REPORT, KAKAO_TEXT_LIMIT, type ProjectStatus } from '../../../../shared/constants';
import { formatKoreanDateTime, formatLocalTime } from '../../lib/time';
import { primaryReason, summarize } from '../monitoring/classifier';
import type { ProjectEvaluation } from '../monitoring/evaluate';

export interface ReportProjectItem {
  projectId: number;
  name: string;
  status: ProjectStatus;
  reason: string;
  lastRunAt: string | null;
  lastRunUrl: string | null;
}

export interface DailyReport {
  reportDate: string;
  generatedAt: string;
  timezone: string;
  counts: { total: number; NORMAL: number; FAILED: number; ATTENTION: number; UNKNOWN: number };
  failed: ReportProjectItem[];
  attention: ReportProjectItem[];
  unknown: ReportProjectItem[];
  normal: ReportProjectItem[];
  globalIssues: string[];
  /** AI 분석(Claude Routine 실제 실행 결과)이 있으면 'ai', 없으면 규칙 기반 'rule' */
  analysisKind: 'ai' | 'rule';
  analysis: string;
  isSample: boolean;
}

export function buildDailyReport(
  evaluations: ProjectEvaluation[],
  opts: {
    reportDate: string;
    now: Date;
    timezone: string;
    globalIssues: string[];
    aiAnalysis?: string | null;
    isSample: boolean;
    runUrls?: Map<number, string | null>;
  },
): DailyReport {
  const active = evaluations.filter((e) => e.project.is_active === 1);
  const counts = summarize(active.map((e) => ({ isActive: true, status: e.classification.status })));
  const item = (e: ProjectEvaluation): ReportProjectItem => ({
    projectId: e.project.id,
    name: e.project.name,
    status: e.classification.status,
    reason: primaryReason(e.classification)?.message ?? '원인 분석 필요',
    lastRunAt: e.classification.lastRun?.startedAt ?? null,
    lastRunUrl: e.classification.lastRun ? (opts.runUrls?.get(e.classification.lastRun.id) ?? null) : null,
  });
  const byPriority = (a: ProjectEvaluation, b: ProjectEvaluation) => priorityRank(a.project.priority) - priorityRank(b.project.priority);
  const pick = (s: ProjectStatus) => active.filter((e) => e.classification.status === s).sort(byPriority).map(item);
  const report: Omit<DailyReport, 'analysis' | 'analysisKind'> = {
    reportDate: opts.reportDate,
    generatedAt: opts.now.toISOString(),
    timezone: opts.timezone,
    counts,
    failed: pick('FAILED'),
    attention: pick('ATTENTION'),
    unknown: pick('UNKNOWN'),
    normal: pick('NORMAL'),
    globalIssues: opts.globalIssues,
    isSample: opts.isSample,
  };
  return opts.aiAnalysis
    ? { ...report, analysisKind: 'ai', analysis: opts.aiAnalysis }
    : { ...report, analysisKind: 'rule', analysis: ruleBasedAnalysis(report) };
}

function priorityRank(p: string): number {
  return { critical: 0, high: 1, normal: 2, low: 3 }[p] ?? 2;
}

/** 규칙 기반 자동 점검 요약. 원인을 추측하지 않고 확인된 사실만 쓴다. */
export function ruleBasedAnalysis(r: Pick<DailyReport, 'failed' | 'attention' | 'unknown' | 'globalIssues' | 'counts'>): string {
  const parts: string[] = [];
  const auth = [...r.failed, ...r.attention].filter((x) => /인증|401|403|재연결/.test(x.reason)).length + r.globalIssues.filter((g) => /인증|재연결/.test(g)).length;
  if (auth > 0) parts.push(`인증 관련 문제 ${auth}건. 재연결 전 재실행은 보류하세요.`);
  const missed = r.attention.filter((x) => /실행 기록이 없/.test(x.reason)).length;
  if (missed > 0) parts.push(`예정 실행 누락 의심 ${missed}건.`);
  const pub = r.failed.filter((x) => /게시 실패/.test(x.reason)).length;
  if (pub > 0) parts.push(`게시 실패 ${pub}건: 중복 게시 위험이 있어 게시 여부 확인 후 재시도하세요.`);
  if (r.failed.length > 0 && parts.length === 0) parts.push(`실패 ${r.failed.length}건: 실행 로그에서 원인 분석이 필요합니다.`);
  if (r.unknown.length > 0) parts.push(`확인 불가 ${r.unknown.length}건(연동/데이터 부족).`);
  if (parts.length === 0) parts.push(r.counts.total > 0 ? '모든 활성 프로젝트가 정상입니다.' : '등록된 활성 프로젝트가 없습니다.');
  return parts.join(' ');
}

// ---------------- 카카오 메시지 렌더링 ----------------
const len = (s: string) => [...s].length;

function clip(s: string, max: number): string {
  return len(s) <= max ? s : [...s].slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** 줄 단위로 200자 한도에 맞춰 담고, 넘치면 남은 개수를 요약한다. */
function packLines(header: string, lines: string[], overflowLabel: (n: number) => string): string {
  let text = header;
  for (let i = 0; i < lines.length; i++) {
    const candidate = `${text}\n${lines[i]}`;
    const rest = lines.length - i - 1;
    const reserve = rest > 0 ? len(`\n${overflowLabel(rest)}`) : 0;
    if (len(candidate) + reserve > KAKAO_TEXT_LIMIT) {
      return `${text}\n${overflowLabel(lines.length - i)}`;
    }
    text = candidate;
  }
  return text;
}

/**
 * 일일 보고서를 카카오 텍스트 메시지(각 200자 이하, 최대 3개)로 만든다.
 * 1) 요약(건수 + 실패/확인 필요 프로젝트명)  2) 실패·확인 필요 상세  3) 정상 요약 + 운영 분석
 * 전체 내용은 버튼 링크(대시보드 보고서 페이지)에서 본다.
 */
export function renderKakaoMessages(r: DailyReport, now: Date): string[] {
  const c = r.counts;
  const sample = r.isSample ? '[샘플 데이터] ' : '';
  const head = `${sample}🤖 AI Automation HQ\n${formatKoreanDateTime(now, r.timezone)} KST`;
  const countLine = `총 ${c.total}개 · 🟢${c.NORMAL} 🔴${c.FAILED} 🟡${c.ATTENTION}${c.UNKNOWN ? ` ⚪${c.UNKNOWN}` : ''}`;
  const names = [...r.failed.map((x) => `🔴 ${clip(x.name, 18)}`), ...r.attention.map((x) => `🟡 ${clip(x.name, 18)}`)];
  const msg1 = packLines(`${head}\n${countLine}`, names, (n) => `외 ${n}개 확인 필요`);

  const messages = [msg1];
  const details = [
    ...r.failed.map((x) => `🔴${clip(x.name, 14)}: ${clip(x.reason, 46)}${x.lastRunAt ? ` (${formatLocalTime(x.lastRunAt, r.timezone)})` : ''}`),
    ...r.attention.map((x) => `🟡${clip(x.name, 14)}: ${clip(x.reason, 46)}`),
  ];
  if (details.length > 0) messages.push(packLines('[상세]', details, (n) => `외 ${n}건은 HQ에서 확인`));

  const label = r.analysisKind === 'ai' ? '🧠 AI 분석' : '🧭 자동 점검 요약';
  const normalNames = r.normal.slice(0, 4).map((x) => clip(x.name, 16));
  const normalLine =
    r.normal.length === 0 ? '' : `🟢 ${normalNames.join(', ')}${r.normal.length > 4 ? ` 외 ${r.normal.length - 4}개` : ''} 정상\n`;
  const globalLine = r.globalIssues.length ? `⚠️ ${clip(r.globalIssues.join(' / '), 60)}\n` : '';
  const prefix = `${normalLine}${globalLine}${label}\n`;
  messages.push(prefix + clip(r.analysis, KAKAO_TEXT_LIMIT - len(prefix)));

  return messages.slice(0, KAKAO_MAX_MESSAGES_PER_REPORT).map((m) => clip(m, KAKAO_TEXT_LIMIT));
}
