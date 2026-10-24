import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ReviewQueuePort } from '../../application/ports.js';
import type { ReviewJob } from '../../domain/review-job.js';

const asRecord = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object') throw new Error('Webhook body must be an object');
  return value as Record<string, any>;
};

const numberId = (value: unknown, name: string): number => {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} is required`);
  return result;
};

export function registerGitLabWebhookRoutes(
  app: FastifyInstance,
  queue: ReviewQueuePort,
  webhookSecret: string,
  onReviewReceived?: (job: ReviewJob) => Promise<void>,
): void {
  app.post('/webhooks/gitlab', async (request, reply) => {
    const supplied = request.headers['x-gitlab-token'];
    if (supplied !== webhookSecret) return reply.code(401).send({ error: 'invalid webhook token' });
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
      queue.recordWebhook({
        provider: 'gitlab', eventId: String(request.headers['x-gitlab-event-uuid'] ?? ''), eventType: String(body.event_type ?? 'merge_request'),
        projectId, mrIid, payloadHash: crypto.createHash('sha256').update(raw).digest('hex'),
      });
      const job = queue.enqueue({ repository, projectId, mrIid, mrUrl, author, sourceSha, targetSha });
      let receiptCommentStatus: 'succeeded' | 'failed' | undefined;
      if (onReviewReceived) {
        try {
          await onReviewReceived(job);
          receiptCommentStatus = 'succeeded';
        } catch {
          // The review is already queued; a receipt comment failure must not discard it.
          receiptCommentStatus = 'failed';
        }
      }
      return reply.code(202).send({ accepted: true, jobId: job.id, receiptCommentStatus });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
