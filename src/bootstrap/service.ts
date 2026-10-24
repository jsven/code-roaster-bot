import fs from 'node:fs';
import type { AppConfig } from '../config/config.js';
import { SqliteDatabase } from '../infrastructure/database/sqlite-database.js';
import { FeishuClient } from '../infrastructure/feishu/feishu-client.js';
import { GitLabClient } from '../infrastructure/gitlab/gitlab-client.js';
import { buildApp } from '../http/app.js';
import { ReviewOrchestrator } from '../application/review-orchestrator.js';
import { notifyReviewReceived } from '../application/review-received.js';
import type { CodexPort, FeishuPort, GitLabPort, WorkspacePort } from '../application/ports.js';
import { ReviewQueue } from '../infrastructure/database/review-queue.js';
import { CodexRunner } from '../infrastructure/codex/codex-runner.js';
import { ReviewWorker } from '../application/review-worker.js';
import { WorkspaceManager } from '../infrastructure/git/workspace-manager.js';

export interface ServiceOverrides {
  gitlab?: GitLabPort;
  codex?: CodexPort;
  feishu?: FeishuPort;
  workspace?: WorkspacePort;
}

export function createService(config: AppConfig, overrides: ServiceOverrides = {}) {
  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  const database = new SqliteDatabase(config.databasePath);
  const queue = new ReviewQueue(database);
  const gitlab = overrides.gitlab ?? new GitLabClient(config.gitlab.baseUrl, config.gitlab.token);
  const codex = overrides.codex ?? new CodexRunner(config.codex);
  const feishu = overrides.feishu ?? new FeishuClient(config.feishu);
  const workspace = overrides.workspace ?? new WorkspaceManager(config.workspaceRoot, config.gitlab.token);
  const orchestrator = new ReviewOrchestrator(queue, gitlab, codex, feishu, config.feishu.minSeverity, workspace);
  const worker = new ReviewWorker(queue, orchestrator);
  const app = buildApp({
    queue,
    webhookSecret: config.gitlab.webhookSecret,
    onReviewReceived: (job) => notifyReviewReceived(gitlab, job),
  });
  return {
    app,
    worker,
    queue,
    async close(): Promise<void> {
      worker.stop();
      await app.close();
      database.close();
    },
  };
}
