import type { ProjectInput } from '../../../shared/schemas';
import { all, bool, first, n, run, stmt, type Db } from '../lib/db';

export interface ProjectRow {
  id: number;
  project_key: string;
  name: string;
  description: string;
  category: string;
  repo_owner: string | null;
  repo_name: string | null;
  default_branch: string;
  repository_url: string | null;
  docs_url: string | null;
  monitoring_mode: string;
  expected_cadence: string;
  expected_days: string;
  interval_hours: number | null;
  expected_time_local: string | null;
  timezone: string;
  grace_period_minutes: number;
  priority: string;
  maintenance_mode: 'AUDIT' | 'PROPOSE' | 'DRAFT_PR';
  maintenance_enabled: number;
  is_active: number;
  last_synced_at: string | null;
  last_sync_error_code: string | null;
  last_status: string | null;
  last_status_reason: string | null;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SourceRow {
  id: number;
  project_id: number;
  source_type: string;
  external_identifier: string;
  config_json: string;
  is_enabled: number;
}

export function toProjectDto(p: ProjectRow, sources: SourceRow[] = []) {
  const gh = sources.find((s) => s.source_type === 'github_actions');
  const ghConfig = gh ? (JSON.parse(gh.config_json || '{}') as { event?: string }) : {};
  return {
    id: p.id,
    projectKey: p.project_key,
    name: p.name,
    description: p.description,
    category: p.category,
    repoOwner: p.repo_owner,
    repoName: p.repo_name,
    defaultBranch: p.default_branch,
    repositoryUrl: p.repository_url,
    docsUrl: p.docs_url,
    monitoringMode: p.monitoring_mode,
    expectedCadence: p.expected_cadence,
    expectedDays: p.expected_days ? p.expected_days.split(',').map(Number) : [],
    intervalHours: p.interval_hours,
    expectedTimeLocal: p.expected_time_local,
    timezone: p.timezone,
    gracePeriodMinutes: p.grace_period_minutes,
    priority: p.priority,
    maintenanceMode: p.maintenance_mode,
    maintenanceEnabled: bool(p.maintenance_enabled),
    isActive: bool(p.is_active),
    workflowFile: gh?.external_identifier && gh.external_identifier !== '*' ? gh.external_identifier : null,
    workflowEvent: ghConfig.event === 'schedule' ? 'schedule' : 'any',
    hasHeartbeat: sources.some((s) => s.source_type === 'heartbeat' && bool(s.is_enabled)),
    lastSyncedAt: p.last_synced_at,
    lastSyncErrorCode: p.last_sync_error_code,
    status: p.last_status ?? 'UNKNOWN',
    statusReason: p.last_status_reason,
    lastEvaluatedAt: p.last_evaluated_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}
export type ProjectDto = ReturnType<typeof toProjectDto>;

export const listProjects = (db: Db, includeInactive = true) =>
  all<ProjectRow>(
    db,
    `SELECT * FROM projects WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY name`,
  );

export const getProject = (db: Db, id: number) =>
  first<ProjectRow>(db, `SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`, id);

export const getProjectByKey = (db: Db, key: string) =>
  first<ProjectRow>(db, `SELECT * FROM projects WHERE project_key = ? AND deleted_at IS NULL`, key);

export const listSources = (db: Db, projectId?: number) =>
  projectId
    ? all<SourceRow>(db, `SELECT * FROM project_sources WHERE project_id = ?`, projectId)
    : all<SourceRow>(db, `SELECT * FROM project_sources`);

function repoUrl(input: Pick<ProjectInput, 'repoOwner' | 'repoName'>) {
  return input.repoOwner && input.repoName ? `https://github.com/${input.repoOwner}/${input.repoName}` : null;
}

function columns(input: ProjectInput) {
  return [
    input.name,
    input.description,
    input.category,
    n(input.repoOwner),
    n(input.repoName),
    input.defaultBranch,
    repoUrl(input),
    n(input.docsUrl),
    input.monitoringMode,
    input.expectedCadence,
    input.expectedDays.join(','),
    n(input.intervalHours),
    n(input.expectedTimeLocal),
    input.timezone,
    input.gracePeriodMinutes,
    input.priority,
    input.maintenanceMode,
    input.maintenanceEnabled ? 1 : 0,
    input.isActive ? 1 : 0,
  ];
}

export async function insertProject(db: Db, input: ProjectInput, now: Date): Promise<number> {
  const iso = now.toISOString();
  const res = await run(
    db,
    `INSERT INTO projects (project_key, name, description, category, repo_owner, repo_name, default_branch, repository_url,
       docs_url, monitoring_mode, expected_cadence, expected_days, interval_hours, expected_time_local, timezone,
       grace_period_minutes, priority, maintenance_mode, maintenance_enabled, is_active, last_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'UNKNOWN',?,?)`,
    input.projectKey,
    ...columns(input),
    iso,
    iso,
  );
  const id = res.meta.last_row_id;
  await syncSources(db, id, input, now);
  return id;
}

export async function updateProject(db: Db, id: number, input: ProjectInput, now: Date): Promise<void> {
  await run(
    db,
    `UPDATE projects SET name=?, description=?, category=?, repo_owner=?, repo_name=?, default_branch=?, repository_url=?,
       docs_url=?, monitoring_mode=?, expected_cadence=?, expected_days=?, interval_hours=?, expected_time_local=?, timezone=?,
       grace_period_minutes=?, priority=?, maintenance_mode=?, maintenance_enabled=?, is_active=?, updated_at=? WHERE id=?`,
    ...columns(input),
    now.toISOString(),
    id,
  );
  await syncSources(db, id, input, now);
}

/** 프로젝트 설정에서 GitHub Actions 소스를 만들고/끈다. heartbeat 소스는 secret 발급 시 만든다. */
async function syncSources(db: Db, projectId: number, input: ProjectInput, now: Date) {
  const iso = now.toISOString();
  const wantsGithub = Boolean(input.repoOwner && input.repoName) && input.monitoringMode.startsWith('github');
  const identifier = input.workflowFile ?? '*';
  await db.batch([
    stmt(
      db,
      `UPDATE project_sources SET is_enabled = 0, updated_at = ? WHERE project_id = ? AND source_type = 'github_actions'
         AND external_identifier != ?`,
      iso,
      projectId,
      identifier,
    ),
    ...(wantsGithub
      ? [
          stmt(
            db,
            `INSERT INTO project_sources (project_id, source_type, external_identifier, config_json, is_enabled, created_at, updated_at)
             VALUES (?, 'github_actions', ?, ?, 1, ?, ?)
             ON CONFLICT(project_id, source_type, external_identifier)
             DO UPDATE SET config_json = excluded.config_json, is_enabled = 1, updated_at = excluded.updated_at`,
            projectId,
            identifier,
            JSON.stringify({ event: input.workflowEvent }),
            iso,
            iso,
          ),
        ]
      : [
          stmt(
            db,
            `UPDATE project_sources SET is_enabled = 0, updated_at = ? WHERE project_id = ? AND source_type = 'github_actions'`,
            iso,
            projectId,
          ),
        ]),
  ]);
}

/** DTO → 입력 형태(PATCH 병합용) */
export function projectToInput(p: ProjectRow, sources: SourceRow[]): ProjectInput {
  const dto = toProjectDto(p, sources);
  return {
    projectKey: dto.projectKey,
    name: dto.name,
    description: dto.description,
    category: dto.category as ProjectInput['category'],
    repoOwner: dto.repoOwner,
    repoName: dto.repoName,
    defaultBranch: dto.defaultBranch,
    docsUrl: dto.docsUrl,
    monitoringMode: dto.monitoringMode as ProjectInput['monitoringMode'],
    expectedCadence: dto.expectedCadence as ProjectInput['expectedCadence'],
    expectedDays: dto.expectedDays,
    intervalHours: dto.intervalHours,
    expectedTimeLocal: dto.expectedTimeLocal,
    timezone: dto.timezone,
    gracePeriodMinutes: dto.gracePeriodMinutes,
    priority: dto.priority as ProjectInput['priority'],
    maintenanceMode: dto.maintenanceMode,
    maintenanceEnabled: dto.maintenanceEnabled,
    isActive: dto.isActive,
    workflowFile: dto.workflowFile,
    workflowEvent: dto.workflowEvent as ProjectInput['workflowEvent'],
  };
}
