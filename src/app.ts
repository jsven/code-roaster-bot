import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ReviewQueue } from './queue.js';
import { renderReviewDetail, renderReviewsPage } from './ui.js';

export interface AppDependencies {
  queue: ReviewQueue;
  webhookSecret: string;
}

const asRecord = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object') throw new Error('Webhook body must be an object');
  return value as Record<string, any>;
};

const numberId = (value: unknown, name: string): number => {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} is required`);
  return result;
};

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post('/webhooks/gitlab', async (request, reply) => {
    const supplied = request.headers['x-gitlab-token'];
    if (supplied !== deps.webhookSecret) return reply.code(401).send({ error: 'invalid webhook token' });
    let body: Record<string, any>;
    try { body = asRecord(request.body); } catch (error) { return reply.code(400).send({ error: String(error) }); }
    const attributes = body.object_attributes ?? {};
    if (body.object_kind !== 'merge_request' || attributes.action !== 'open') {
      return reply.code(202).send({ accepted: false, ignored: true });
    }
    try {
      const projectId = String(numberId(body.project?.id, 'project.id'));
      const mrIid = numberId(attributes.iid, 'object_attributes.iid');
      const sourceSha = String(attributes.last_commit?.id ?? attributes.last_commit_id ?? attributes.source_branch_sha ?? '');
      const targetSha = String(attributes.target_branch_sha ?? attributes.target_sha ?? 'unknown');
      if (!sourceSha) throw new Error('source SHA is required');
      const repository = String(body.project?.path_with_namespace ?? body.project?.web_url ?? projectId);
      const mrUrl = String(attributes.url ?? `${repository}/-/merge_requests/${mrIid}`);
      const author = String(body.user?.username ?? body.user?.name ?? 'unknown');
      const raw = JSON.stringify(body);
      deps.queue.recordWebhook({
        provider: 'gitlab', eventId: String(request.headers['x-gitlab-event-uuid'] ?? ''), eventType: String(body.event_type ?? 'merge_request'),
        projectId, mrIid, payloadHash: crypto.createHash('sha256').update(raw).digest('hex'),
      });
      const job = deps.queue.enqueue({ repository, projectId, mrIid, mrUrl, author, sourceSha, targetSha });
      return reply.code(202).send({ accepted: true, jobId: job.id });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/reviews', async (_request, reply) => reply.send(deps.queue.list()));
  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (request, reply) => {
    const job = deps.queue.get(Number(request.params.id));
    return job ? reply.send(job) : reply.code(404).send({ error: 'review not found' });
  });
  app.post<{ Params: { id: string } }>('/api/reviews/:id/retry', async (request, reply) => {
    const id = Number(request.params.id);
    if (!deps.queue.get(id)) return reply.code(404).send({ error: 'review not found' });
    deps.queue.requeue(id);
    return reply.send({ requeued: true, jobId: id });
  });
  app.post<{ Params: { id: string } }>('/api/reviews/:id/retry-feishu', async (request, reply) => {
    const id = Number(request.params.id);
    if (!deps.queue.get(id)) return reply.code(404).send({ error: 'review not found' });
    deps.queue.requeue(id);
    return reply.send({ requeued: true, scope: 'full-review', jobId: id });
  });
  app.get('/health', async (_request, reply) => reply.send({ ok: true }));
  app.get('/ready', async (_request, reply) => reply.send({ ok: true, queue: true }));
  app.get('/reviews', async (_request, reply) => reply.type('text/html; charset=utf-8').send(renderReviewsPage(deps.queue.list())));
  app.get<{ Params: { id: string } }>('/reviews/:id', async (request, reply) => {
    const job = deps.queue.get(Number(request.params.id));
    return job ? reply.type('text/html; charset=utf-8').send(renderReviewDetail(job)) : reply.code(404).send('审核任务不存在');
  });
  return app;
}
