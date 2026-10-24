import { describe, expect, it, vi } from 'vitest';
import { GitLabClient } from '../../../src/infrastructure/gitlab/gitlab-client.js';

describe('GitLabClient', () => {
  it('posts one MR note with an encoded project path and token', async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://gitlab.example.com/api/v4/projects/group%2Fdemo/merge_requests/7/notes');
      expect(init?.headers).toMatchObject({ 'PRIVATE-TOKEN': 'token' });
      expect(JSON.parse(String(init?.body))).toEqual({ body: 'review body' });
      return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    });
    const client = new GitLabClient('https://gitlab.example.com', 'token', fetcher);
    await expect(client.createNote('group/demo', 7, 'review body')).resolves.toEqual({ id: '99' });
  });

  it('extracts changed paths and combined diff from the MR changes response', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ changes: [
      { new_path: 'src/a.ts', old_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
      { new_path: 'src/new.ts', old_path: 'src/new.ts', diff: '@@ -0 +1 @@\n+new' },
    ] }), { status: 200 }));
    const client = new GitLabClient('https://gitlab.example.com', 'token', fetcher);
    await expect(client.getChanges('42', 7)).resolves.toEqual({
      files: new Set(['src/a.ts', 'src/new.ts']),
      diff: '@@ -1 +1 @@\n-old\n+new\n\n@@ -0 +1 @@\n+new',
    });
  });

  it('reads MR head/base SHAs and source/target project IDs', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      title: 'Feature', web_url: 'https://gitlab/mr/7', sha: 'head-sha',
      source_project_id: 43, target_project_id: 42,
      diff_refs: { head_sha: 'head-sha', base_sha: 'base-sha' },
    }), { status: 200 }));
    const client = new GitLabClient('https://gitlab.example.com', 'token', fetcher);
    await expect(client.getMergeRequest('42', 7)).resolves.toMatchObject({
      title: 'Feature', headSha: 'head-sha', baseSha: 'base-sha', sourceProjectId: '43', targetProjectId: '42',
    });
  });

  it('reads a project clone URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 42, path_with_namespace: 'group/demo', http_url_to_repo: 'https://gitlab.example.com/group/demo.git' }), { status: 200 }));
    const client = new GitLabClient('https://gitlab.example.com', 'token', fetcher);
    await expect(client.getProject('42')).resolves.toEqual({ id: '42', pathWithNamespace: 'group/demo', httpUrlToRepo: 'https://gitlab.example.com/group/demo.git' });
  });
});
