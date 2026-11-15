// 샘플(데모) 전용 로컬 D1(`automatehq-demo`)을 비우고 샘플 데이터를 넣는다.
// 운영 DB(`automatehq`)나 원격(--remote) DB에는 절대 쓰지 않는다. 모든 이름에 [샘플] 표시를 붙인다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const DB = 'automatehq-demo';
if (process.argv.includes('--remote')) {
  console.error('샘플 데이터는 원격 DB에 넣을 수 없습니다.');
  process.exit(1);
}

const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// 다음 07:00 KST 기준 시각 계산(어제/오늘 07:00 KST)
const kstNow = new Date(now + 9 * 3600_000);
const today7 = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), 7, 0) - 9 * 3600_000;
const lastSeven = today7 <= now ? today7 : today7 - 86400_000;
const minAgoOf = (ts) => Math.round((now - ts) / 60_000);

const projects = [
  ['sample-youtube', '[샘플] YouTube 자동 영상', 'youtube', 'daily-shorts.yml', 'daily', '07:00', 'high'],
  ['sample-instagram', '[샘플] Instagram 카드 자동화', 'instagram', 'daily.yml', 'daily', '07:00', 'high'],
  ['sample-chip', '[샘플] 반도체 브리핑', 'briefing', 'daily.yml', 'daily', '07:07', 'normal'],
  ['sample-subscription', '[샘플] 청약 브리핑', 'briefing', 'daily.yml', 'daily', '07:07', 'normal'],
  ['sample-fixedcost', '[샘플] 고정비 브리핑', 'briefing', 'daily.yml', 'weekdays', '07:07', 'normal'],
  ['sample-app', '[샘플] 개인 생활형 앱', 'app', 'ci.yml', 'irregular', null, 'low'],
  ['sample-blog', '[샘플] 기술 블로그', 'other', 'daily-post.yml', 'interval', null, 'low'],
  ['sample-exbuilder', '[샘플] eXBuilder 개인 도구', 'devtool', 'ci.yml', 'irregular', null, 'low'],
];

const sql = [
  // 외래 키 순서: 참조하는 쪽부터 지운다
  'DELETE FROM run_events; DELETE FROM rerun_requests; DELETE FROM maintenance_jobs; DELETE FROM incidents; DELETE FROM runs; DELETE FROM publications;',
  'DELETE FROM usage_records; DELETE FROM daily_reports; DELETE FROM notification_deliveries;',
  'DELETE FROM project_secrets; DELETE FROM project_sources; DELETE FROM projects; DELETE FROM audit_logs; DELETE FROM integrations;',
];
const created = iso(60 * 24 * 30);
// 샘플 화면 구성을 위한 가짜 연결 표시(자격 증명 없음). 샘플 모드에서는 외부 호출 자체를 하지 않는다.
sql.push(
  `INSERT INTO integrations (provider, display_name, status, encrypted_credentials, metadata_json, last_verified_at, created_at, updated_at)
   VALUES ('github', '[샘플] GitHub', 'connected', NULL, '{"login":"sample-owner","tokenType":"샘플","tokenHint":"(샘플 — 토큰 없음)"}', ${q(iso(5))}, ${q(created)}, ${q(created)});`,
);
projects.forEach(([key, name, cat, wf, cadence, time, prio], i) => {
  const id = i + 1;
  sql.push(
    `INSERT INTO projects (id, project_key, name, description, category, repo_owner, repo_name, default_branch, repository_url, monitoring_mode, expected_cadence, expected_days, interval_hours, expected_time_local, timezone, grace_period_minutes, priority, maintenance_mode, maintenance_enabled, is_active, last_status, created_at, updated_at)
     VALUES (${id}, ${q(key)}, ${q(name)}, '샘플 데이터', ${q(cat)}, 'sample-owner', ${q(key)}, 'main', NULL, 'github_actions', ${q(cadence)}, '', ${cadence === 'interval' ? 8 : 'NULL'}, ${q(time)}, 'Asia/Seoul', 90, ${q(prio)}, ${id === 6 ? "'DRAFT_PR'" : "'AUDIT'"}, ${id === 6 ? 1 : 0}, 1, 'UNKNOWN', ${q(created)}, ${q(created)});`,
    `INSERT INTO project_sources (id, project_id, source_type, external_identifier, config_json, is_enabled, created_at, updated_at) VALUES (${id}, ${id}, 'github_actions', ${q(wf)}, '{"event":"any"}', 1, ${q(created)}, ${q(created)});`,
  );
});

let runId = 1;
const addRun = (pid, status, startMinAgo, durMin, extra = {}) => {
  const started = iso(startMinAgo);
  const completed = status === 'running' ? null : iso(startMinAgo - durMin);
  sql.push(
    `INSERT INTO runs (id, project_id, source_id, source_type, external_run_id, trigger_type, workflow_name, status, stage, started_at, completed_at, duration_seconds, branch, commit_sha, external_url, error_code, safe_error_message, metrics_json, created_at, updated_at)
     VALUES (${runId}, ${pid}, ${pid}, 'github_actions', 'sample-${runId}', ${q(extra.trigger ?? 'schedule')}, ${q(extra.wf ?? 'daily')}, ${q(status)}, ${q(extra.stage ?? null)}, ${q(started)}, ${q(completed)}, ${status === 'running' ? 'NULL' : durMin * 60}, 'main', 'sample000', NULL, ${q(extra.code ?? null)}, ${q(extra.msg ?? null)}, '{}', ${q(started)}, ${q(started)});`,
  );
  return runId++;
};

const m7 = minAgoOf(lastSeven);
// 과거 13일 이력: 대부분 정상, 일부 실패·재실행·누락을 섞는다(결정적 패턴)
for (let d = 1; d <= 13; d++) {
  for (const pid of [1, 2, 3, 4, 5]) {
    if (pid === 4 && (d === 5 || d === 9)) continue; // 실행 누락
    if (pid === 5 && [2, 3, 9, 10].includes(d)) continue; // 주말(평일 일정)
    const fail = (pid === 2 && (d === 3 || d === 8)) || (pid === 1 && d === 11) || (pid === 3 && d === 6);
    if (fail) {
      addRun(pid, 'failure', m7 + d * 1440 - 3, 4, { code: 'FAILURE', msg: 'GitHub Actions failure' });
      addRun(pid, 'success', m7 + d * 1440 - 60, 7, { trigger: 'workflow_dispatch' }); // 수동 재실행 성공
    } else {
      addRun(pid, 'success', m7 + d * 1440 - 3 - pid, 5 + ((d * pid) % 6));
    }
  }
  if (d % 2 === 0) addRun(6, d % 4 === 0 ? 'failure' : 'success', m7 + d * 1440 - 600, 2, { trigger: 'push', wf: 'ci', code: d % 4 === 0 ? 'FAILURE' : undefined });
  if (d % 3 === 0) for (const off of [0, 480]) addRun(7, 'success', m7 + d * 1440 - off, 1, { wf: 'daily-post' });
}
// 오늘
addRun(1, 'success', m7 - 2, 9, { stage: 'published' });
const failRun = addRun(2, 'failure', m7 - 1, 3, { code: 'FAILURE', msg: 'GitHub Actions failure — 게시 API 응답 401' });
addRun(3, 'success', m7 - 8, 4);
// 4번(청약)은 오늘 실행 없음 → 미실행 의심
addRun(5, 'success', m7 - 7, 3);
addRun(6, 'success', 300, 2, { trigger: 'pull_request', wf: 'ci' });
addRun(6, 'failure', 40, 2, { trigger: 'push', wf: 'ci', code: 'FAILURE', msg: '테스트 2건 실패' });
addRun(7, 'success', 200, 1, { wf: 'daily-post' });
addRun(8, 'success', 2000, 1, { trigger: 'pull_request', wf: 'ci' });

sql.push(
  `INSERT INTO publications (project_id, platform, content_key, title, status, generated_at, upload_started_at, published_at, platform_url, verification_status, created_at, updated_at)
   VALUES (1, 'youtube', 'sample-short-today', '[샘플] 오늘의 기묘한 기록', 'published', ${q(iso(m7 - 5))}, ${q(iso(m7 - 8))}, ${q(iso(m7 - 10))}, NULL, 'heartbeat_reported', ${q(iso(m7))}, ${q(iso(m7 - 10))});`,
  `INSERT INTO publications (project_id, platform, content_key, title, status, generated_at, upload_started_at, failed_stage, error_code, safe_error_message, verification_status, created_at, updated_at)
   VALUES (2, 'instagram', 'sample-card-today', '[샘플] 오늘의 카드뉴스', 'failed', ${q(iso(m7 - 2))}, ${q(iso(m7 - 3))}, 'uploading', 'IG_401', '게시 API 401 — 게시 여부 확인 필요', 'unverified', ${q(iso(m7))}, ${q(iso(m7 - 4))});`,
  `INSERT INTO maintenance_jobs (project_id, mode, status, analysis_kind, summary, findings_json, started_at, completed_at, approval_state, created_at, updated_at)
   VALUES (6, 'AUDIT', 'rule_based_done', 'rule_based', '[샘플] Claude Code 연결 필요: 규칙 기반 점검 결과만 기록했습니다.', '[{"title":"최근 14일 실패 1회 / 2회 (50%)","severity":"high"},{"title":"오류 코드 FAILURE: 1회","severity":"info"}]', ${q(iso(30))}, ${q(iso(30))}, 'not_required', ${q(iso(30))}, ${q(iso(30))});`,
  `INSERT INTO usage_records (project_id, provider, metric_name, metric_value, unit, amount, currency, value_source, period_start, period_end, recorded_at, metadata_json)
   VALUES (NULL, 'cloudflare', 'workers_requests', 12345, 'requests', 0, 'USD', 'MANUAL', ${q(new Date(now - 30 * 86400_000).toISOString().slice(0, 10))}, ${q(new Date(now).toISOString().slice(0, 10))}, ${q(iso(0))}, '{"note":"샘플"}');`,
  `INSERT INTO notification_deliveries (channel, notification_type, dedupe_key, status, payload_summary, created_at, safe_error_message) VALUES ('kakao', 'daily_report', 'daily:sample', 'skipped', '[샘플 데이터] 샘플 모드에서는 카카오로 보내지 않습니다.', ${q(iso(m7))}, '샘플 모드');`,
);
void failRun;

mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/demo-seed.sql', sql.join('\n'));
const isWin = process.platform === 'win32';
const res = spawnSync(isWin ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'execute', DB, '--local', '--env', 'demo', '--file', '.wrangler/demo-seed.sql', '--yes'], {
  stdio: 'inherit',
  shell: isWin,
});
if (res.status !== 0) process.exit(res.status ?? 1);
writeFileSync('.wrangler/.demo-seeded', new Date().toISOString());
console.info('샘플 데이터를 넣었습니다(로컬 automatehq-demo 전용).');
