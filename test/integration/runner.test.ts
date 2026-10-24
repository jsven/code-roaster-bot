import { describe, expect, it, vi } from 'vitest';
import { runRunner } from '../../src/bootstrap/runner.js';

const env = (): NodeJS.ProcessEnv => ({
  CI_PIPELINE_SOURCE: 'merge_request_event', CI_SERVER_URL: 'https://gitlab.example.com',
  CI_PROJECT_PATH: 'group/repo', CI_PROJECT_DIR: '/tmp/checkout',
  CI_MERGE_REQUEST_PROJECT_ID: '42', CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '7',
  CI_COMMIT_SHA: 'a'.repeat(40), CI_MERGE_REQUEST_DIFF_BASE_SHA: 'b'.repeat(40),
  GITLAB_TOKEN: 'gitlab-test-secret', OPENAI_API_KEY: 'api-test-secret', CODEX_MODEL: 'test-model',
});

const fixtures = () => ({
  gitlab: {
    getMergeRequest: vi.fn(async () => ({
      title: 'Feature', webUrl: 'https://gitlab.example.com/group/repo/-/merge_requests/7',
      sourceProjectId: '42', targetProjectId: '42', author: 'mr-author',
      headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40), // A newer push than this pipeline.
    })),
    hasRunNote: vi.fn(async () => false),
    createNote: vi.fn(async (_projectId: string, _iid: number, _body: string) => ({ id: 'note-1' })),
  },
  codex: { run: vi.fn(async () => JSON.stringify({ summary: 'Review', findings: [{
    severity: 'medium', title: 'Finding', description: 'Description', file: 'a.ts',
    line_start: 1, line_end: 1, code: 'input();', recommendation: 'Fix',
  }] })) },
  feishu: { enabled: true, sendSummary: vi.fn(async () => undefined) },
  workspace: {
    prepare: vi.fn(async () => ({
      rootPath: '/tmp/snapshot', files: new Set(['a.ts']), diff: 'diff', reviewInput: 'diff and file',
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    })),
    close: vi.fn(async () => undefined),
  },
  log: vi.fn(),
});

describe('stateless Runner workflow', () => {
  it('posts receipt, reviews the pipeline snapshot, comments, notifies and exits without a queue', async () => {
    const deps = fixtures();
    const result = await runRunner(env(), deps);
    expect(result).toMatchObject({ status: 'succeeded', notificationStatus: 'succeeded' });
    expect(deps.gitlab.createNote).toHaveBeenNthCalledWith(1, '42', 7, '🤖⏳ 赛博老王 正在细品你的优雅代码');
    expect(deps.gitlab.createNote.mock.invocationCallOrder[0]).toBeLessThan(deps.codex.run.mock.invocationCallOrder[0]!);
    expect(deps.workspace.prepare).toHaveBeenCalledWith('a'.repeat(40), 'b'.repeat(40));
    expect(deps.codex.run).toHaveBeenCalledWith('diff and file', '/tmp/snapshot');
    expect(deps.gitlab.createNote.mock.calls[1]?.[2]).toContain(`codereview:run:${'a'.repeat(40)}`);
    expect(deps.feishu.sendSummary).toHaveBeenCalledWith(expect.objectContaining({ author: 'mr-author', medium: 1 }));
    expect(deps.workspace.close).toHaveBeenCalledOnce();
  });

  it('skips non-MR pipelines before requiring secrets or posting comments', async () => {
    const deps = fixtures();
    expect(await runRunner({}, deps)).toEqual({ status: 'not_mr_pipeline' });
    expect(deps.gitlab.createNote).not.toHaveBeenCalled();
    expect(deps.codex.run).not.toHaveBeenCalled();
  });

  it('skips fork pipelines without using credentials', async () => {
    const deps = fixtures();
    expect(await runRunner({ CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_PROJECT_ID: '42', CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '43' }, deps))
      .toEqual({ status: 'fork_skipped' });
    expect(deps.gitlab.createNote).not.toHaveBeenCalled();
  });

  it('continues after a failed receipt comment and redacts credentials in its log', async () => {
    const deps = fixtures();
    deps.gitlab.createNote.mockRejectedValueOnce(new Error('failed with gitlab-test-secret'));
    expect(await runRunner(env(), deps)).toMatchObject({ status: 'succeeded' });
    expect(deps.log.mock.calls.flat().join(' ')).toContain('[REDACTED]');
    expect(deps.log.mock.calls.flat().join(' ')).not.toContain('gitlab-test-secret');
  });

  it('rejects invalid review output, sends no result/notification and cleans up', async () => {
    const deps = fixtures();
    deps.codex.run.mockResolvedValueOnce('not-json');
    await expect(runRunner(env(), deps)).rejects.toThrow(/not valid JSON/);
    expect(deps.gitlab.createNote).toHaveBeenCalledOnce();
    expect(deps.feishu.sendSummary).not.toHaveBeenCalled();
    expect(deps.workspace.close).toHaveBeenCalledOnce();
  });

  it('rejects a result comment failure and does not notify before publishing the review', async () => {
    const deps = fixtures();
    deps.gitlab.createNote.mockResolvedValueOnce({ id: 'receipt' }).mockRejectedValueOnce(new Error('comment unavailable'));
    await expect(runRunner(env(), deps)).rejects.toThrow(/comment unavailable/);
    expect(deps.feishu.sendSummary).not.toHaveBeenCalled();
    expect(deps.workspace.close).toHaveBeenCalledOnce();
  });

  it('keeps the successful result comment and exposes Feishu failure for the CLI exit code', async () => {
    const deps = fixtures();
    deps.feishu.sendSummary.mockRejectedValueOnce(new Error('Feishu unavailable'));
    expect(await runRunner(env(), deps)).toMatchObject({ status: 'succeeded', notificationStatus: 'failed' });
    expect(deps.gitlab.createNote).toHaveBeenCalledTimes(2);
  });

  it('posts a receipt on reruns but does not duplicate the completed result', async () => {
    const deps = fixtures();
    deps.gitlab.hasRunNote.mockResolvedValueOnce(true);
    expect(await runRunner(env(), deps)).toMatchObject({ status: 'skipped' });
    expect(deps.gitlab.createNote).toHaveBeenCalledOnce();
    expect(deps.workspace.prepare).not.toHaveBeenCalled();
    expect(deps.codex.run).not.toHaveBeenCalled();
  });

  it('can retry notification without duplicating a completed result comment', async () => {
    const deps = fixtures();
    deps.gitlab.hasRunNote.mockResolvedValueOnce(true);
    expect(await runRunner({ ...env(), REVIEW_RETRY_NOTIFICATION: 'true' }, deps)).toMatchObject({ notificationStatus: 'succeeded' });
    expect(deps.gitlab.createNote).toHaveBeenCalledOnce();
    expect(deps.codex.run).toHaveBeenCalledOnce();
    expect(deps.feishu.sendSummary).toHaveBeenCalledOnce();
  });
});
