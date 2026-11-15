// 프로젝트 등록 제안(shared/presets.ts)을 D1에 등록하는 SQL을 만든다. 이미 있는 project_key는 건너뛴다.
// 사용: node scripts/seed-presets.mjs > .wrangler/presets.sql
//       npx wrangler d1 execute automatehq --remote --file .wrangler/presets.sql
// 대시보드의 "기존 저장소에서 추가"와 같은 값이다(샘플 데이터 아님).
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../shared/presets.ts', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export const PROJECT_PRESETS'));
const blocks = [...body.matchAll(/input:\s*\{([\s\S]*?)\n\s{4}\},/g)].map((m) => m[1]);

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const field = (b, k) => {
  const m = b.match(new RegExp(`\\b${k}:\\s*('([^']*)'|null|\\d+|true|false)`));
  if (!m) return undefined;
  if (m[2] !== undefined) return m[2];
  if (m[1] === 'null') return null;
  if (m[1] === 'true' || m[1] === 'false') return m[1] === 'true';
  return Number(m[1]);
};

const now = new Date().toISOString();
const out = [];
for (const b of blocks) {
  const p = {
    key: field(b, 'projectKey'),
    name: field(b, 'name'),
    description: field(b, 'description') ?? '',
    category: field(b, 'category') ?? 'other',
    owner: field(b, 'repoOwner'),
    repo: field(b, 'repoName'),
    branch: field(b, 'defaultBranch') ?? 'main',
    mode: field(b, 'monitoringMode') ?? 'github_actions',
    wf: field(b, 'workflowFile') ?? '*',
    event: field(b, 'workflowEvent') ?? 'any',
    cadence: field(b, 'expectedCadence') ?? 'daily',
    interval: field(b, 'intervalHours') ?? null,
    time: field(b, 'expectedTimeLocal'),
    grace: field(b, 'gracePeriodMinutes') ?? 60,
    priority: field(b, 'priority') ?? 'normal',
  };
  const url = `https://github.com/${p.owner}/${p.repo}`;
  out.push(
    `INSERT INTO projects (project_key, name, description, category, repo_owner, repo_name, default_branch, repository_url, monitoring_mode,
       expected_cadence, expected_days, interval_hours, expected_time_local, timezone, grace_period_minutes, priority, maintenance_mode,
       maintenance_enabled, is_active, last_status, created_at, updated_at)
     SELECT ${q(p.key)}, ${q(p.name)}, ${q(p.description)}, ${q(p.category)}, ${q(p.owner)}, ${q(p.repo)}, ${q(p.branch)}, ${q(url)}, ${q(p.mode)},
       ${q(p.cadence)}, '', ${q(p.interval)}, ${q(p.time === undefined ? '07:00' : p.time)}, 'Asia/Seoul', ${p.grace}, ${q(p.priority)}, 'AUDIT', 0, 1, 'UNKNOWN', ${q(now)}, ${q(now)}
     WHERE NOT EXISTS (SELECT 1 FROM projects WHERE project_key = ${q(p.key)});`,
    `INSERT OR IGNORE INTO project_sources (project_id, source_type, external_identifier, config_json, is_enabled, created_at, updated_at)
     SELECT id, 'github_actions', ${q(p.wf)}, ${q(JSON.stringify({ event: p.event }))}, 1, ${q(now)}, ${q(now)} FROM projects WHERE project_key = ${q(p.key)};`,
    `INSERT INTO audit_logs (actor, action, resource_type, resource_id, safe_metadata_json, created_at)
     SELECT 'admin-cli', 'project.create', 'project', id, ${q(JSON.stringify({ projectKey: p.key, via: 'seed-presets' }))}, ${q(now)}
     FROM projects WHERE project_key = ${q(p.key)} AND created_at = ${q(now)};`,
  );
}
process.stdout.write(out.join('\n') + '\n');
console.error(`${blocks.length}개 프로젝트 SQL 생성`);
