import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => reply.send({ ok: true }));
  app.get('/ready', async (_request, reply) => reply.send({ ok: true, queue: true }));
}
