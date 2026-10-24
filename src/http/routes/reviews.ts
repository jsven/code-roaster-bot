import type { FastifyInstance } from 'fastify';
import type { ReviewQueuePort } from '../../application/ports.js';
import { renderReviewDetail } from '../views/review-detail.js';
import { renderReviewsPage } from '../views/reviews.js';
import { reviewListOptions, reviewListQuerySchema, type ReviewListQuery } from '../schemas/review-list.js';

export function registerReviewRoutes(app: FastifyInstance, queue: ReviewQueuePort): void {
  app.get('/', async (_request, reply) => reply.redirect('/reviews'));

  app.get<{ Querystring: ReviewListQuery }>('/api/reviews', { schema: { querystring: reviewListQuerySchema } }, async (request, reply) => {
    return reply.send(queue.listPage(reviewListOptions(request.query)));
  });
  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (request, reply) => {
    const job = queue.get(Number(request.params.id));
    return job ? reply.send(job) : reply.code(404).send({ error: 'review not found' });
  });
  app.post<{ Params: { id: string } }>('/api/reviews/:id/retry', async (request, reply) => {
    const id = Number(request.params.id);
    if (!queue.get(id)) return reply.code(404).send({ error: 'review not found' });
    queue.requeue(id);
    return reply.send({ requeued: true, jobId: id });
  });
  app.post<{ Params: { id: string } }>('/api/reviews/:id/retry-feishu', async (request, reply) => {
    const id = Number(request.params.id);
    if (!queue.get(id)) return reply.code(404).send({ error: 'review not found' });
    queue.requeue(id);
    return reply.send({ requeued: true, scope: 'full-review', jobId: id });
  });
  app.get<{ Querystring: ReviewListQuery }>('/reviews', { schema: { querystring: reviewListQuerySchema } }, async (request, reply) => {
    const page = queue.listPage(reviewListOptions(request.query));
    return reply.type('text/html; charset=utf-8').send(renderReviewsPage(page, queue.listRepositories(), request.query));
  });
  app.get<{ Params: { id: string } }>('/reviews/:id', async (request, reply) => {
    const job = queue.get(Number(request.params.id));
    return job ? reply.type('text/html; charset=utf-8').send(renderReviewDetail(job)) : reply.code(404).send('审核任务不存在');
  });
}
