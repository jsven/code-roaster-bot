import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerWorkspace } from '../../../src/infrastructure/git/runner-workspace.js';

const exec = promisify(execFile);

describe('Runner checkout snapshots', () => {
  let directory: string;
  let checkout: string;
  let manager: RunnerWorkspace;
  let baseSha: string;
  const git = async (...args: string[]) => (await exec('git', args, { cwd: checkout })).stdout.trim();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-checkout-test-'));
    checkout = path.join(directory, 'checkout');
    await fs.mkdir(checkout);
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(checkout, 'a.ts'), 'base();\n');
    await fs.writeFile(path.join(checkout, 'deleted.ts'), 'old();\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    baseSha = await git('rev-parse', 'HEAD');
    manager = new RunnerWorkspace(checkout);
  });

  afterEach(async () => {
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reviews exact pipeline SHAs without modifying the checkout and removes the temporary worktree', async () => {
    await fs.writeFile(path.join(checkout, 'a.ts'), 'pipeline();\n');
    await fs.writeFile(path.join(checkout, 'space name.ts'), 'added();\n');
    await fs.unlink(path.join(checkout, 'deleted.ts'));
    await git('add', '-A');
    await git('commit', '-m', 'pipeline');
    const sourceSha = await git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(checkout, 'a.ts'), 'later-push();\n');
    await git('commit', '-am', 'later push');
    const latestSha = await git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(checkout, 'keep-untracked.txt'), 'preserve');

    const prepared = await manager.prepare(sourceSha, baseSha);
    expect(prepared.files).toEqual(new Set(['a.ts', 'deleted.ts', 'space name.ts']));
    expect(prepared.reviewInput).toContain('pipeline();');
    expect(prepared.reviewInput).not.toContain('later-push();');
    expect(await fs.readFile(path.join(prepared.rootPath, 'a.ts'), 'utf8')).toBe('pipeline();\n');
    expect(await git('rev-parse', 'HEAD')).toBe(latestSha);
    expect(await fs.readFile(path.join(checkout, 'keep-untracked.txt'), 'utf8')).toBe('preserve');
    await manager.close();
    await expect(fs.stat(prepared.rootPath)).rejects.toThrow();
    expect((await git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  });

  it('fails clearly if a shallow checkout does not contain the pipeline base', async () => {
    await expect(manager.prepare(baseSha, 'f'.repeat(40))).rejects.toThrow(/GIT_DEPTH/);
  });

  it('does not follow changed symlinks outside the checkout when collecting file contents', async () => {
    const secret = path.join(directory, 'outside.txt');
    await fs.writeFile(secret, 'MUST_NOT_INCLUDE_EXTERNAL_CONTENT');
    await fs.symlink(secret, path.join(checkout, 'link.txt'));
    await git('add', 'link.txt');
    await git('commit', '-m', 'symlink');
    const prepared = await manager.prepare(await git('rev-parse', 'HEAD'), baseSha);
    expect(prepared.files.has('link.txt')).toBe(true);
    expect(prepared.reviewInput).not.toContain('MUST_NOT_INCLUDE_EXTERNAL_CONTENT');
  });
});
