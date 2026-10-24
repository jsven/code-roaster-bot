import { describe, expect, it } from 'vitest';
import { loadRunnerConfig } from '../../src/config/runner-config.js';
import { projectPath } from '../../src/config/paths.js';

const env = (): NodeJS.ProcessEnv => ({
  CI_PIPELINE_SOURCE: 'merge_request_event', CI_SERVER_URL: 'https://gitlab.example.com',
  CI_PROJECT_PATH: 'group/repo', CI_PROJECT_DIR: '/tmp/checkout',
  CI_MERGE_REQUEST_PROJECT_ID: '42', CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '7',
  CI_COMMIT_SHA: 'a'.repeat(40), CI_MERGE_REQUEST_DIFF_BASE_SHA: 'b'.repeat(40),
  GITLAB_TOKEN: 'test-token', OPENAI_API_KEY: 'test-api-key', CODEX_MODEL: 'test-model',
});

describe('Runner configuration', () => {
  it('uses CI context without requiring webhook, server, database or queue configuration', () => {
    const config = loadRunnerConfig({ ...env(), PORT: 'invalid', DATABASE_PATH: '/not-writable/database.db' });
    expect(config.gitlab).toEqual({ baseUrl: 'https://gitlab.example.com', token: 'test-token' });
    expect(config.context).toMatchObject({ projectId: '42', mrIid: 7, sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) });
    expect(config.codex.promptFile).toBe(projectPath('prompts', 'code-review.md'));
    expect(config).not.toHaveProperty('databasePath');
    expect(config).not.toHaveProperty('server');
    expect(config.gitlab).not.toHaveProperty('webhookSecret');
  });

  it.each(['merged_result', 'merge_train'])('reviews the source commit rather than the synthetic merge commit for %s', (type) => {
    const config = loadRunnerConfig({ ...env(), CI_MERGE_REQUEST_EVENT_TYPE: type, CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: 'c'.repeat(40) });
    expect(config.context.sourceSha).toBe('c'.repeat(40));
  });

  it.each(['GITLAB_TOKEN', 'OPENAI_API_KEY', 'CODEX_MODEL', 'CI_PROJECT_DIR', 'CI_MERGE_REQUEST_DIFF_BASE_SHA', 'CI_MERGE_REQUEST_IID'])(
    'reports missing %s before side effects', (key) => {
      const input = env(); delete input[key];
      expect(() => loadRunnerConfig(input)).toThrow(key);
    },
  );

  it.each(['short-sha', '0'.repeat(40), '--all'])('rejects an invalid commit: %s', (commit) => {
    expect(() => loadRunnerConfig({ ...env(), CI_COMMIT_SHA: commit })).toThrow(/CI_COMMIT_SHA/);
  });

  it('does not fall back to a merge commit when source SHA is absent', () => {
    expect(() => loadRunnerConfig({ ...env(), CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result' })).toThrow(/SOURCE_BRANCH_SHA/);
  });

  it('rejects fork MR configuration', () => {
    expect(() => loadRunnerConfig({ ...env(), CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '43' })).toThrow(/Fork/);
  });
});
