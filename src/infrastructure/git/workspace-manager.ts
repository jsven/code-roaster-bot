import type { WorkspaceRequest, PreparedWorkspace, WorkspacePort } from '../../application/ports.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class WorkspaceManager implements WorkspacePort {
  constructor(private readonly root: string, private readonly token?: string, private readonly maxFileBytes = 200_000, private readonly maxContextBytes = 2_000_000) {}

  async prepare(request: WorkspaceRequest): Promise<PreparedWorkspace> {
    await fs.mkdir(this.root, { recursive: true });
    const key = crypto.createHash('sha256').update(request.repositoryKey).digest('hex').slice(0, 24);
    const rootPath = path.join(this.root, key);
    const gitDir = path.join(rootPath, '.git');
    if (!(await this.exists(gitDir))) {
      await this.runGit(['clone', '--no-checkout', request.cloneUrl, rootPath]);
    } else {
      await this.runGit(['remote', 'set-url', 'origin', request.cloneUrl], rootPath);
    }

    await this.runGit(['reset', '--hard'], rootPath);
    await this.runGit(['clean', '-fdx'], rootPath);
    await this.runGit(['fetch', '--prune', 'origin', request.headSha], rootPath);
    if (request.baseCloneUrl && request.baseCloneUrl !== request.cloneUrl) {
      try {
        await this.runGit(['remote', 'get-url', 'target'], rootPath);
        await this.runGit(['remote', 'set-url', 'target', request.baseCloneUrl], rootPath);
      } catch {
        await this.runGit(['remote', 'add', 'target', request.baseCloneUrl], rootPath);
      }
      await this.runGit(['fetch', '--prune', 'target', request.baseSha], rootPath);
    } else {
      await this.runGit(['fetch', '--prune', 'origin', request.baseSha], rootPath);
    }
    await this.runGit(['checkout', '--detach', request.headSha], rootPath);

    const { stdout: fileOutput } = await this.runGit(['diff', '--name-only', request.baseSha, request.headSha], rootPath);
    const files = new Set(fileOutput.split('\n').map((file) => file.trim()).filter(Boolean));
    const { stdout: diff } = await this.runGit(['diff', '--no-ext-diff', '--unified=80', request.baseSha, request.headSha], rootPath);
    const contents: string[] = [];
    let contextBytes = Buffer.byteLength(diff);
    for (const file of files) {
      const absolute = path.resolve(rootPath, file);
      if (!absolute.startsWith(`${path.resolve(rootPath)}${path.sep}`)) continue;
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > this.maxFileBytes) continue;
        const content = await fs.readFile(absolute, 'utf8');
        const section = `\n===== FILE: ${file} =====\n${content}\n===== END FILE: ${file} =====\n`;
        const bytes = Buffer.byteLength(section);
        if (contextBytes + bytes > this.maxContextBytes) break;
        contents.push(section);
        contextBytes += bytes;
      } catch {
        // Deleted or unreadable files remain represented by the diff.
      }
    }
    return { rootPath, files, diff, reviewInput: `${diff}${contents.join('')}`, headSha: request.headSha, baseSha: request.baseSha };
  }

  private async runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    const env = { ...process.env };
    if (this.token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `PRIVATE-TOKEN: ${this.token}`;
    }
    try {
      return await exec('git', args, { cwd, env, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      throw new Error(`git ${args.join(' ')} failed: ${(detail.stderr ?? detail.message ?? '').slice(0, 1000)}`);
    }
  }

  private async exists(file: string): Promise<boolean> {
    try { await fs.access(file); return true; } catch { return false; }
  }
}
