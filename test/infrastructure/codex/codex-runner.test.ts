import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexRunner } from '../../../src/infrastructure/codex/codex-runner.js';

describe('CodexRunner', () => {
  it('passes prompt and diff to a local command and captures JSON output', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-'));
    const promptFile = path.join(directory, 'prompt.md');
    await fs.writeFile(promptFile, 'review prompt');
    const runner = new CodexRunner({ command: process.execPath, args: ['-e', "process.stdin.on('data', d => process.stdout.write(d))"], promptFile, timeoutMs: 1000, maxOutputBytes: 10000 });
    await expect(runner.run('diff text')).resolves.toContain('review prompt');
  });

  it('rejects a non-zero command', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-'));
    const promptFile = path.join(directory, 'prompt.md');
    await fs.writeFile(promptFile, 'prompt');
    const runner = new CodexRunner({ command: process.execPath, args: ['-e', 'process.exit(2)'], promptFile, timeoutMs: 1000, maxOutputBytes: 10000 });
    await expect(runner.run('diff')).rejects.toThrow(/exit code 2/);
  });

  it('runs Codex with the persistent repository as the working directory', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cwd-'));
    const promptFile = path.join(directory, 'prompt.md');
    await fs.writeFile(promptFile, 'prompt');
    const runner = new CodexRunner({ command: process.execPath, args: ['-e', "process.stdout.write(process.cwd())"], promptFile, timeoutMs: 1000, maxOutputBytes: 10000 });
    await expect(runner.run('diff', directory)).resolves.toBe(await fs.realpath(directory));
  });

  it('passes configured model, sandbox, approval, profile, and ephemeral flags', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-args-'));
    const promptFile = path.join(directory, 'prompt.md');
    await fs.writeFile(promptFile, 'prompt');
    const argsFile = path.join(directory, 'args.json');
    const scriptFile = path.join(directory, 'capture.mjs');
    await fs.writeFile(scriptFile, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('{}');`);
    const runner = new CodexRunner({
      command: process.execPath,
      args: [scriptFile],
      promptFile, timeoutMs: 1000, maxOutputBytes: 10000,
      model: 'gpt-5.2', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never', profile: 'review', ephemeral: true,
    });
    await runner.run('diff');
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8')) as string[];
    expect(args).toContain('gpt-5.2');
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args).toContain('read-only');
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain('--ask-for-approval');
    expect(args).not.toContain('model_provider="code_review"');
    expect(args).toContain('review');
    expect(args).toContain('--ephemeral');
  });

  it.each([undefined, 'https://gateway.example.com/v1'])(
    'uses explicit API credentials from the environment without requiring a saved login: %s', async (apiBaseUrl) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-api-'));
      try {
        const promptFile = path.join(directory, 'prompt.md');
        const scriptFile = path.join(directory, 'capture.mjs');
        await fs.writeFile(promptFile, 'prompt');
        await fs.writeFile(scriptFile, `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), key: process.env.CODE_REVIEW_API_KEY }));`);
        const runner = new CodexRunner({
          command: process.execPath, args: [scriptFile], promptFile, timeoutMs: 1000, maxOutputBytes: 10000,
          apiKey: 'test-only-api-key', apiBaseUrl,
        });
        const output = JSON.parse(await runner.run('diff')) as { args: string[]; key: string };
        expect(output.key).toBe('test-only-api-key');
        expect(output.args.join(' ')).not.toContain('test-only-api-key');
        expect(output.args).toContain('model_provider="code_review"');
        expect(output.args).toContain(`model_providers.code_review.base_url="${apiBaseUrl ?? 'https://api.openai.com/v1'}"`);
        expect(output.args).toContain('model_providers.code_review.env_key="CODE_REVIEW_API_KEY"');
        expect(output.args).toContain('model_providers.code_review.wire_api="responses"');
        expect(output.args).toContain('model_providers.code_review.requires_openai_auth=false');
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
});
