import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspace.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

describe('WorkspaceManager', () => {
  it('clones once, reuses the repository directory, and exposes full changed file content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-repo-'));
    const workspaces = await fs.mkdtemp(path.join(os.tmpdir(), 'review-workspaces-'));
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
    await git(root, ['add', 'a.txt']);
    await git(root, ['commit', '-m', 'initial']);
    const { stdout: baseRaw } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    const baseSha = baseRaw.trim();
    await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    await git(root, ['commit', '-am', 'change']);
    const { stdout: headRaw } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    const headSha = headRaw.trim();
    const manager = new WorkspaceManager(workspaces, undefined);
    const first = await manager.prepare({ repositoryKey: '42', cloneUrl: root, headSha, baseSha });
    const second = await manager.prepare({ repositoryKey: '42', cloneUrl: root, headSha, baseSha });

    expect(second.rootPath).toBe(first.rootPath);
    expect(second.files).toEqual(new Set(['a.txt']));
    expect(second.reviewInput).toContain('one\ntwo');
    expect((await fs.readdir(workspaces))).toHaveLength(1);
  });
});
