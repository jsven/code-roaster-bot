import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { projectPath } from '../../config/paths.js';

export function registerAssetRoutes(app: FastifyInstance): void {
  const stylesheet = fs.readFileSync(projectPath('public', 'styles.css'), 'utf8');
  app.get('/assets/styles.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(stylesheet));
}
