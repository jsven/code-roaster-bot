import { describe, expect, it, vi } from 'vitest';
import { createService } from '../src/server.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  server: { host: '127.0.0.1', port: 0 },
  databasePath: ':memory:',
  workspaceRoot: '/tmp/code-review-test',
  gitlab: { baseUrl: 'https://gitlab.example.com', token: 'token', webhookSecret: 'secret' },
  codex: { command: 'codex', args: ['exec'], promptFile: '/tmp/prompt', timeoutMs: 1000, maxOutputBytes: 10000, model: 'gpt-5.2', reasoningEffort: 'medium', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true },
  feishu: { enabled: true, webhookUrl: 'https://feishu/hook', secret: 'secret', minSeverity: 'medium', timeoutMs: 1000 },
};

describe('service integration', () => {
  it('runs webhook, queue, review, GitLab comment, and Feishu notification end to end', async () => {
    const gitlab = {
      getMergeRequest: vi.fn(async () => ({ title: 'Feature', webUrl: 'https://gitlab/mr/7', headSha: 'abc', baseSha: 'def', sourceProjectId: '42', targetProjectId: '42' })),
      getProject: vi.fn(async () => ({ id: '42', pathWithNamespace: 'group/demo', httpUrlToRepo: 'https://gitlab/group/demo.git' })),
      hasRunNote: vi.fn(async () => false),
      createNote: vi.fn(async () => ({ id: 'note-1' })),
    };
    const workspace = {
      prepare: vi.fn(async () => ({ rootPath: '/tmp/review-repo', files: new Set(['a.ts']), diff: 'diff', reviewInput: 'diff\n===== FILE: a.ts =====\ninput();', headSha: 'abc', baseSha: 'def' })),
    };
    const codex = { run: vi.fn(async () => JSON.stringify({ summary: '', findings: [{
      severity: 'medium', title: '问题', description: '说明', file: 'a.ts', line_start: 1, line_end: 1,
      code: 'input();', recommendation: '修复',
    }] })) };
    const feishu = { sendSummary: vi.fn(async () => undefined) };
    const service = createService(config, { gitlab, codex, feishu, workspace });
    const response = await service.app.inject({
      method: 'POST', url: '/webhooks/gitlab', headers: { 'x-gitlab-token': 'secret' },
      payload: {
        object_kind: 'merge_request', event_type: 'merge_request', user: { username: 'alice' },
        project: { id: 42, path_with_namespace: 'group/demo' },
        object_attributes: { action: 'open', iid: 7, url: 'https://gitlab/mr/7', last_commit: { id: 'abc' }, target_branch_sha: 'def' },
      },
    });
    expect(response.statusCode).toBe(202);
    await service.worker.tick();
    expect(workspace.prepare).toHaveBeenCalledOnce();
    expect(gitlab.createNote).toHaveBeenCalledOnce();
    expect(feishu.sendSummary).toHaveBeenCalledOnce();
    await service.close();
  });
});
