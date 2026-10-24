import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('loads GitLab and Feishu settings and defaults the Feishu threshold to medium', () => {
    const config = loadConfig({
      GITLAB_TOKEN: 'token',
      GITLAB_WEBHOOK_SECRET: 'secret',
      FEISHU_ENABLED: 'true',
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook',
    });

    expect(config.gitlab.token).toBe('token');
    expect(config.feishu.enabled).toBe(true);
    expect(config.feishu.minSeverity).toBe('medium');
  });

  it('loads Codex model and execution parameters', () => {
    const config = loadConfig({
      GITLAB_TOKEN: 'token', GITLAB_WEBHOOK_SECRET: 'secret',
      CODEX_MODEL: 'gpt-5.2', CODEX_REASONING_EFFORT: 'xhigh', CODEX_SANDBOX: 'read-only', CODEX_APPROVAL_POLICY: 'never',
      CODEX_PROFILE: 'review', CODEX_EPHEMERAL: 'true', CODEX_OUTPUT_SCHEMA: './schema.json',
    });
    expect(config.codex.model).toBe('gpt-5.2');
    expect(config.codex.reasoningEffort).toBe('xhigh');
    expect(config.codex.sandbox).toBe('read-only');
    expect(config.codex.approvalPolicy).toBe('never');
    expect(config.codex.profile).toBe('review');
    expect(config.codex.ephemeral).toBe(true);
    expect(config.codex.outputSchema).toContain('schema.json');
  });

  it('loads explicit API credentials and normalizes the base URL', () => {
    const config = loadConfig({
      GITLAB_TOKEN: 'token', GITLAB_WEBHOOK_SECRET: 'secret',
      OPENAI_API_KEY: ' test-key ', OPENAI_BASE_URL: ' https://gateway.example.com/v1/ ',
    });
    expect(config.codex.apiKey).toBe('test-key');
    expect(config.codex.apiBaseUrl).toBe('https://gateway.example.com/v1');
  });

  it('preserves existing login behavior when API settings are blank', () => {
    const config = loadConfig({
      GITLAB_TOKEN: 'token', GITLAB_WEBHOOK_SECRET: 'secret', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    });
    expect(config.codex.apiKey).toBeUndefined();
    expect(config.codex.apiBaseUrl).toBeUndefined();
  });

  it('rejects a custom API URL without its credentials', () => {
    expect(() => loadConfig({
      GITLAB_TOKEN: 'token', GITLAB_WEBHOOK_SECRET: 'secret', OPENAI_BASE_URL: 'https://gateway.example.com/v1',
    })).toThrow(/OPENAI_API_KEY/);
  });

  it.each(['invalid', 'file:///tmp/api', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment'])(
    'rejects an invalid API base URL: %s', (baseUrl) => {
      expect(() => loadConfig({
        GITLAB_TOKEN: 'token', GITLAB_WEBHOOK_SECRET: 'secret', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: baseUrl,
      })).toThrow(/OPENAI_BASE_URL/);
    },
  );
});
