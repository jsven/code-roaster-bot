import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PreparedWorkspace } from '../../application/ports.js';

const exec = promisify(execFile);

// Use GitLab's checkout objects, with an isolated snapshot for Codex to read.
// Never reset/clean the CI checkout, clone another repo, or follow a moving branch.
export class RunnerWorkspace {
  private temporaryDirectory?: string;
  private snapshot?: string;

  constructor(private readonly checkout: string, private readonly maxFileBytes = 200_000, private readonly maxContextBytes = 2_000_000) {}

  async prepare(headSha: string, baseSha: string): Promise<PreparedWorkspace> {
    if (this.temporaryDirectory) throw new Error('Runner workspace is already prepared');
    for (const commit of [headSha, baseSha]) {
      try { await this.git(['cat-file', '-e', `${commit}^{commit}`]); }
      catch { throw new Error('Pipeline commit is missing from the checkout; configure GIT_DEPTH: "0" and rerun the job'); }
    }
    this.temporaryDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-review-runner-')));
    this.snapshot = path.join(this.temporaryDirectory, 'repository');
    try {
      await this.git(['worktree', 'add', '--detach', this.snapshot, headSha]);
      const { stdout: names } = await this.git(['diff', '--name-only', '-z', '--no-renames', baseSha, headSha, '--']);
      const files = new Set(names.split('\0').filter(Boolean));
      const { stdout: diff } = await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=80', baseSha, headSha, '--']);
      let contextBytes = Buffer.byteLength(diff);
      if (contextBytes > this.maxContextBytes) throw new Error('MR diff exceeds the review context limit');
      const contents: string[] = [];
      for (const file of files) {
        const absolute = path.resolve(this.snapshot, file);
        if (!absolute.startsWith(`${this.snapshot}${path.sep}`)) continue;
        try {
          const stat = await fs.lstat(absolute);
          if (!stat.isFile() || stat.size > this.maxFileBytes) continue;
          const realPath = await fs.realpath(absolute);
          if (!realPath.startsWith(`${this.snapshot}${path.sep}`)) continue;
          const content = await fs.readFile(absolute, 'utf8');
          if (content.includes('\0')) continue;
          const section = `\n===== FILE: ${file} =====\n${content}\n===== END FILE: ${file} =====\n`;
          const bytes = Buffer.byteLength(section);
          if (contextBytes + bytes > this.maxContextBytes) continue;
          contents.push(section);
          contextBytes += bytes;
        } catch {
          // Deleted files remain represented by the diff.
        }
      }
      return { rootPath: this.snapshot, files, diff, reviewInput: diff + contents.join(''), headSha, baseSha };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const temporary = this.temporaryDirectory;
    const snapshot = this.snapshot;
    this.temporaryDirectory = undefined;
    this.snapshot = undefined;
    if (!temporary) return;
    try {
      if (snapshot) await this.git(['worktree', 'remove', '--force', snapshot]);
    } catch {
      // A failed worktree add may not have registered a snapshot.
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: this.checkout, maxBuffer: 10 * 1024 * 1024, timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
    });
  }
}
