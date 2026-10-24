import type { GitLabChanges, GitLabMergeRequest, GitLabProject, GitLabPort } from '../../application/ports.js';

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class GitLabClient implements GitLabPort {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly fetcher: Fetcher;

  constructor(baseUrl: string, token: string, fetcher: Fetcher = fetch) {
    this.apiBase = `${baseUrl.replace(/\/$/, '')}/api/v4`;
    this.token = token;
    this.fetcher = fetcher;
  }

  async createNote(projectId: string, mrIid: number, body: string): Promise<{ id: string }> {
    const response = await this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    const value = await response.json() as { id?: number | string };
    if (value.id === undefined) throw new Error('GitLab note response did not contain an id');
    return { id: String(value.id) };
  }

  async getMergeRequest(projectId: string, mrIid: number): Promise<GitLabMergeRequest> {
    const response = await this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`);
    const value = await response.json() as {
      title?: string; web_url?: string; sha?: string; source_project_id?: number | string; target_project_id?: number | string;
      diff_refs?: { head_sha?: string; base_sha?: string };
    };
    const headSha = value.diff_refs?.head_sha ?? value.sha;
    const baseSha = value.diff_refs?.base_sha;
    if (!value.title || !value.web_url || !headSha || !baseSha || value.source_project_id === undefined || value.target_project_id === undefined) {
      throw new Error('GitLab MR response is missing clone metadata');
    }
    return {
      title: value.title,
      webUrl: value.web_url,
      headSha,
      baseSha,
      sourceProjectId: String(value.source_project_id),
      targetProjectId: String(value.target_project_id),
    };
  }

  async getProject(projectId: string): Promise<GitLabProject> {
    const response = await this.request(`/projects/${encodeURIComponent(projectId)}`);
    const value = await response.json() as { id?: number | string; path_with_namespace?: string; http_url_to_repo?: string };
    if (value.id === undefined || !value.path_with_namespace || !value.http_url_to_repo) throw new Error('GitLab project response is missing clone URL');
    return { id: String(value.id), pathWithNamespace: value.path_with_namespace, httpUrlToRepo: value.http_url_to_repo };
  }

  async getChanges(projectId: string, mrIid: number): Promise<GitLabChanges> {
    const response = await this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`);
    const value = await response.json() as { changes?: Array<{ new_path?: string; old_path?: string; diff?: string }> };
    const changes = value.changes ?? [];
    const files = new Set<string>();
    const diffs: string[] = [];
    for (const change of changes) {
      if (change.new_path) files.add(change.new_path);
      if (change.old_path) files.add(change.old_path);
      if (change.diff) diffs.push(change.diff);
    }
    return { files, diff: diffs.join('\n\n') };
  }

  async hasRunNote(projectId: string, mrIid: number, sourceSha: string): Promise<boolean> {
    const response = await this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes?sort=desc&order_by=created_at&per_page=100`);
    const notes = await response.json() as Array<{ body?: string }>;
    return notes.some((note) => note.body?.includes(`<!-- codereview:run:${sourceSha} -->`) === true);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitLab API ${response.status}: ${body.slice(0, 500)}`);
    }
    return response;
  }
}
