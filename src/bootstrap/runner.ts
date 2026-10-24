import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRunnerConfig } from '../config/runner-config.js';
import { ReviewExecution, type ReviewExecutionResult } from '../application/review-execution.js';
import { notifyReviewReceived } from '../application/review-received.js';
import type { CodexPort, FeishuPort, GitLabPort } from '../application/ports.js';
import { GitLabClient } from '../infrastructure/gitlab/gitlab-client.js';
import { CodexRunner } from '../infrastructure/codex/codex-runner.js';
import { FeishuClient } from '../infrastructure/feishu/feishu-client.js';
import { RunnerWorkspace } from '../infrastructure/git/runner-workspace.js';

export interface RunnerOverrides {
  gitlab?: GitLabPort;
  codex?: CodexPort;
  feishu?: FeishuPort;
  workspace?: Pick<RunnerWorkspace, 'prepare' | 'close'>;
  log?: (message: string) => void;
}

export function runnerErrorMessage(error: unknown, env: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ['GITLAB_TOKEN', 'OPENAI_API_KEY', 'FEISHU_WEBHOOK_URL', 'FEISHU_SECRET', 'CI_JOB_TOKEN', 'CI_REPOSITORY_URL']) {
    const value = env[name]?.trim();
    if (value) message = message.replaceAll(value, '[REDACTED]');
  }
  return message;
}

export async function runRunner(env: NodeJS.ProcessEnv = process.env, overrides: RunnerOverrides = {}): Promise<ReviewExecutionResult | { status: 'not_mr_pipeline' | 'fork_skipped' }> {
  const log = overrides.log ?? console.log;
  if (env.CI_PIPELINE_SOURCE !== 'merge_request_event') {
    log('Skipped: not a merge request pipeline');
    return { status: 'not_mr_pipeline' };
  }
  if (env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID && env.CI_MERGE_REQUEST_PROJECT_ID
    && env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID !== env.CI_MERGE_REQUEST_PROJECT_ID) {
    log('Skipped: fork MR pipelines are not enabled');
    return { status: 'fork_skipped' };
  }
  const config = loadRunnerConfig(env);
  const { context } = config;
  const gitlab = overrides.gitlab ?? new GitLabClient(config.gitlab.baseUrl, config.gitlab.token);
  const feishu = overrides.feishu ?? new FeishuClient(config.feishu);
  const workspace = overrides.workspace ?? new RunnerWorkspace(context.projectDirectory);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'code-review-cli-'));
  try {
    const codex = overrides.codex ?? new CodexRunner({
      ...config.codex,
      args: [...config.codex.args, '--ignore-user-config', '--ignore-rules'],
      isolatedEnvironment: true,
      configDirectory: temporary,
    });
    // Send the receipt as soon as the job starts; no deduplication for this comment.
    try {
      await notifyReviewReceived(gitlab, context);
      log('MR receipt comment: succeeded');
    } catch (error) {
      log(`MR receipt comment: failed (${runnerErrorMessage(error, env)}); continuing review`);
    }
    if (!gitlab.getMergeRequest) throw new Error('GitLab MR metadata method is required');
    const mr = await gitlab.getMergeRequest(context.projectId, context.mrIid);
    if (mr.sourceProjectId !== context.projectId || mr.targetProjectId !== context.projectId) {
      throw new Error('MR project metadata does not match the internal MR pipeline');
    }
    const execution = new ReviewExecution(gitlab, codex, feishu, config.feishu.minSeverity);
    const result = await execution.execute({
      repository: context.repository, projectId: context.projectId, mrIid: context.mrIid,
      mrUrl: mr.webUrl, author: mr.author ?? 'unknown', sourceSha: context.sourceSha, targetSha: context.baseSha,
    }, async () => {
      // MR API may already point at a newer push. Review this pipeline's SHAs only.
      const prepared = await workspace.prepare(context.sourceSha, context.baseSha);
      return { title: mr.title, files: prepared.files, reviewInput: prepared.reviewInput, cwd: prepared.rootPath };
    }, { retryNotification: config.retryNotification });
    log(`Review: ${result.status}; result comment: ${result.commentId}; Feishu: ${result.notificationStatus}`);
    if (result.notificationError) log(`Feishu error: ${runnerErrorMessage(result.notificationError, env)}`);
    return result;
  } finally {
    try { await workspace.close(); }
    finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
}
