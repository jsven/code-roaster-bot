import Fastify, { type FastifyInstance } from 'fastify';
import type { ReviewQueuePort } from '../application/ports.js';
import type { ReviewJob } from '../domain/review-job.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerGitLabWebhookRoutes } from './routes/gitlab-webhook.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerReviewRoutes } from './routes/reviews.js';

export interface AppDependencies {
  queue: ReviewQueuePort;
  webhookSecret: string;
  onReviewReceived?: (job: ReviewJob) => Promise<void>;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAssetRoutes(app);
  registerHealthRoutes(app);
  registerGitLabWebhookRoutes(app, deps.queue, deps.webhookSecret, deps.onReviewReceived);
  registerReviewRoutes(app, deps.queue);
  return app;
}
