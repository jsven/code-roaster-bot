import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { SqliteDatabase } from './db.js';
import { FeishuClient } from './feishu-client.js';
import { GitLabClient } from './gitlab-client.js';
import { buildApp } from './app.js';
import { ReviewOrchestrator, type CodexPort, type FeishuPort, type GitLabPort, type WorkspacePort } from './orchestrator.js';
import { ReviewQueue } from './queue.js';
import { CodexRunner } from './codex-runner.js';
import { ReviewWorker } from './worker.js';
import { WorkspaceManager } from './workspace.js';

export interface ServiceOverrides {
  gitlab?: GitLabPort;
  codex?: CodexPort;
  feishu?: FeishuPort;
  workspace?: WorkspacePort;
}

export function createService(config: AppConfig, overrides: ServiceOverrides = {}) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  const database = new SqliteDatabase(config.databasePath);
  const queue = new ReviewQueue(database);
  const gitlab = overrides.gitlab ?? new GitLabClient(config.gitlab.baseUrl, config.gitlab.token);
  const codex = overrides.codex ?? new CodexRunner(config.codex);
  const feishu = overrides.feishu ?? new FeishuClient(config.feishu);
  const workspace = overrides.workspace ?? new WorkspaceManager(config.workspaceRoot, config.gitlab.token);
  const orchestrator = new ReviewOrchestrator(queue, gitlab, codex, feishu, config.feishu.minSeverity, workspace);
  const worker = new ReviewWorker(queue, orchestrator);
  const app = buildApp({ queue, webhookSecret: config.gitlab.webhookSecret });
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

async function start(): Promise<void> {
  const config = loadConfig();
  const service = createService(config);
  service.worker.start();
  await service.app.listen({ host: config.server.host, port: config.server.port });
  const shutdown = async (): Promise<void> => {
    await service.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void start();
}
