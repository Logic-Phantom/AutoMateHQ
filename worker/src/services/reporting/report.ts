import { KAKAO_TEXT_LIMIT, type ProjectStatus } from '../../../../shared/constants';
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

/** 정기 보고서 머리줄용 짧은 시각. 예: 11.16 (일) 12:00 */
function shortDateTime(now: Date, tz: string): string {
  return formatKoreanDateTime(now, tz).replace(/^\d{4}\./, '');
}

/**
 * 일일 보고서를 카카오 텍스트 메시지 한 건(200자 이하)으로 만든다. 한눈에 읽히게 묶음 사이에 빈 줄을 둔다.
 *   제목 / 상태 건수 / 문제 프로젝트(이름 + 원인 한 줄) / 한줄 분석
 * 정상 프로젝트 이름과 상세 원인은 버튼 링크(대시보드 보고서 페이지)에서 본다.
 * 200자를 넘으면 문제 프로젝트를 뒤에서부터 '외 N건'으로 접는다. 분석 줄은 남는 자리만큼 줄인다.
 */
export function renderKakaoMessages(r: DailyReport, now: Date): string[] {
  const c = r.counts;
  const head = `${r.isSample ? '[샘플] ' : ''}🤖 HQ 운영 보고 · ${shortDateTime(now, r.timezone)}`;
  const problems = c.FAILED + c.ATTENTION;
  const status: string[] = [
    problems === 0 && c.UNKNOWN === 0 && c.total > 0
      ? `✅ ${c.total}개 모두 정상`
      : [`🔴 실패 ${c.FAILED}`, `🟡 확인 ${c.ATTENTION}`, `🟢 정상 ${c.NORMAL}`, ...(c.UNKNOWN ? [`⚪ 미확인 ${c.UNKNOWN}`] : [])].join(' · '),
  ];
  if (r.globalIssues.length) status.push(`⚠️ ${clip(r.globalIssues.join(' / '), 40)}`);

  const problemList = [...r.failed.map((x) => ['🔴', x] as const), ...r.attention.map((x) => ['🟡', x] as const)];
  // 자세히: 이름 + 원인 한 줄(아이콘이 이미 실패를 뜻하므로 '최근 실행 실패:' 머리말은 뺀다). 짧게: 이름만
  const detailed = problemList.map(([icon, x]) => {
    const when = x.lastRunAt ? ` · ${formatLocalTime(x.lastRunAt, r.timezone)}` : '';
    return `${icon} ${clip(x.name, 26)}\n   └ ${clip(x.reason.replace(/^최근 실행 실패:\s*/, ''), 34)}${when}`;
  });
  const compact = problemList.map(([icon, x]) => `${icon} ${clip(x.name, 26)}`);
  const label = r.analysisKind === 'ai' ? '🧠 AI 분석' : '🧭 점검 요약';

  const compose = (items: string[], shown: number): { text: string; hasAnalysis: boolean } => {
    const blocks = [head, status.join('\n')];
    if (items.length) {
      const rest = items.length - shown;
      blocks.push([...items.slice(0, shown), ...(rest > 0 ? [`외 ${rest}건은 HQ에서 확인`] : [])].join('\n'));
    }
    const base = blocks.join('\n\n');
    const room = Math.min(KAKAO_TEXT_LIMIT - len(base) - len(`\n\n${label}\n`), 80);
    if (room < 16) return { text: base, hasAnalysis: false };
    return { text: `${base}\n\n${label}\n${clip(r.analysis, room)}`, hasAnalysis: true };
  };
  const fits = (out: { text: string; hasAnalysis: boolean }, needAnalysis: boolean) =>
    len(out.text) <= KAKAO_TEXT_LIMIT && (out.hasAnalysis || !needAnalysis);

  // 1) 문제를 전부 원인까지 2) 전부 이름만 3) 이름만 앞에서부터(최소 1개) — 분석 줄이 함께 들어가는 첫 형태를 쓴다
  const n = problemList.length;
  const tries: Array<[string[], number]> = [[detailed, n], [compact, n]];
  for (let shown = n - 1; shown >= Math.min(1, n); shown--) tries.push([compact, shown]);
  for (const needAnalysis of [true, false]) {
    for (const [items, shown] of tries) {
      const out = compose(items, shown);
      if (fits(out, needAnalysis)) return [out.text];
    }
  }
  const last = compose(compact, 0);
  return [clip(last.text, KAKAO_TEXT_LIMIT)];
}
