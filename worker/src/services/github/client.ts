import type { ApiErrorCode } from '../../../../shared/constants';
import type { FetchFn } from '../../env';
import { redact } from '../../security/redact';

/**
 * GitHub REST API 최소 클라이언트.
 * 문서: https://docs.github.com/en/rest/actions/workflow-runs
 * 오류는 401/403/404/rate limit/5xx/네트워크로 구분해 돌려준다.
 */
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

export class GithubApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    public readonly httpStatus: number | null,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function classifyGithubError(status: number, headers: Headers, bodyText: string): GithubApiError {
  const msg = redact(safeMessage(bodyText));
  if (status === 401) return new GithubApiError('AUTH_INVALID', 401, `GitHub 인증 오류(401): 토큰이 만료되었거나 잘못되었습니다. ${msg}`);
  if (status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(bodyText)))) {
    const reset = Number(headers.get('x-ratelimit-reset') ?? 0);
    const retryAfter = Number(headers.get('retry-after') ?? 0) || (reset ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : 60);
    return new GithubApiError('RATE_LIMITED', status, `GitHub 호출 제한에 걸렸습니다. 약 ${retryAfter}초 후 재시도`, retryAfter);
  }
  if (status === 403) return new GithubApiError('PERMISSION_DENIED', 403, `GitHub 권한 부족(403): 토큰 권한·저장소 범위를 확인하세요. ${msg}`);
  if (status === 404) return new GithubApiError('NOT_FOUND', 404, `대상 없음(404): 저장소/실행이 없거나 토큰이 접근할 수 없습니다.`);
  if (status === 422) return new GithubApiError('VALIDATION_FAILED', 422, `GitHub 요청 거부(422): ${msg}`);
  if (status >= 500) return new GithubApiError('UPSTREAM_ERROR', status, `GitHub 서버 오류(${status})`);
  return new GithubApiError('UPSTREAM_ERROR', status, `GitHub 오류(${status}): ${msg}`);
}

function safeMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { message?: string };
    return parsed.message ?? '';
  } catch {
    return '';
  }
}

export interface WorkflowRunApi {
  id: number;
  name: string | null;
  path?: string;
  event: string;
  status: string | null; // queued/in_progress/completed/waiting/requested/pending
  conclusion: string | null; // success/failure/cancelled/skipped/timed_out/action_required/neutral/startup_failure/stale
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  run_attempt?: number;
  run_started_at?: string;
  created_at: string;
  updated_at: string;
  workflow_id: number;
}

export interface CommitApi {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
    committer: { name: string; date: string } | null;
  };
}

export interface WorkflowApi {
  id: number;
  name: string;
  path: string;
  state: string; // active / disabled_manually / disabled_inactivity / deleted
}

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ data: T; status: number; headers: Headers }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${GITHUB_API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': 'AI-Automation-HQ',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GithubApiError('NETWORK_ERROR', null, `GitHub 연결 실패: ${redact((err as Error).message ?? '')}`);
    }
    const text = await res.text();
    if (!res.ok) throw classifyGithubError(res.status, res.headers, text);
    return { data: (text ? JSON.parse(text) : {}) as T, status: res.status, headers: res.headers };
  }

  async getAuthenticatedUser() {
    return (await this.request<{ login: string }>('GET', '/user')).data;
  }

  async getRepo(owner: string, repo: string) {
    return (
      await this.request<{ full_name: string; default_branch: string; private: boolean; html_url: string; archived: boolean }>(
        'GET',
        `/repos/${enc(owner)}/${enc(repo)}`,
      )
    ).data;
  }

  async listWorkflows(owner: string, repo: string) {
    return (await this.request<{ workflows: WorkflowApi[] }>('GET', `/repos/${enc(owner)}/${enc(repo)}/actions/workflows?per_page=100`))
      .data.workflows;
  }

  /** workflowFile 지정 시 해당 워크플로만 조회한다. */
  async listRuns(owner: string, repo: string, opts: { workflowFile?: string | null; event?: string; perPage?: number } = {}) {
    const qs = new URLSearchParams({ per_page: String(opts.perPage ?? 15) });
    if (opts.event) qs.set('event', opts.event);
    const base = opts.workflowFile
      ? `/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${enc(opts.workflowFile)}/runs`
      : `/repos/${enc(owner)}/${enc(repo)}/actions/runs`;
    return (await this.request<{ workflow_runs: WorkflowRunApi[] }>('GET', `${base}?${qs}`)).data.workflow_runs;
  }

  /** 브랜치의 최근 커밋(최신순). since는 ISO 시각. */
  async listCommits(owner: string, repo: string, opts: { branch?: string | null; since?: string; perPage?: number } = {}) {
    const qs = new URLSearchParams({ per_page: String(opts.perPage ?? 30) });
    if (opts.branch) qs.set('sha', opts.branch);
    if (opts.since) qs.set('since', opts.since);
    return (await this.request<CommitApi[]>('GET', `/repos/${enc(owner)}/${enc(repo)}/commits?${qs}`)).data;
  }

  async getRun(owner: string, repo: string, runId: number | string) {
    return (await this.request<WorkflowRunApi>('GET', `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${enc(String(runId))}`)).data;
  }

  /** 실패한 job만 재실행(201) 또는 전체 재실행(201). Actions write 권한 필요. */
  async rerun(owner: string, repo: string, runId: number | string, failedJobsOnly: boolean) {
    const suffix = failedJobsOnly ? 'rerun-failed-jobs' : 'rerun';
    const res = await this.request<unknown>('POST', `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${enc(String(runId))}/${suffix}`, {});
    return res.status;
  }

  async rateLimit() {
    return (await this.request<{ resources: { core: { limit: number; remaining: number; reset: number } } }>('GET', '/rate_limit')).data
      .resources.core;
  }
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** GitHub status/conclusion → HQ run 상태 */
export function normalizeRunStatus(status: string | null, conclusion: string | null): string {
  if (status !== 'completed') {
    if (status === 'in_progress') return 'running';
    return 'queued';
  }
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
    case 'stale':
      return 'skipped';
    case 'action_required':
      return 'queued';
    default:
      return 'unknown';
  }
}
