import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { SqliteDatabase } from '../../src/infrastructure/database/sqlite-database.js';
import { ReviewQueue } from '../../src/infrastructure/database/review-queue.js';

const payload = (action = 'open') => ({
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: { username: 'alice', name: 'Alice' },
  project: { id: 42, path_with_namespace: 'group/demo', web_url: 'https://gitlab.example.com/group/demo' },
  object_attributes: {
    action, iid: 7, url: 'https://gitlab.example.com/group/demo/-/merge_requests/7', title: 'Add feature',
    last_commit: { id: 'abc' }, target_branch_sha: 'def',
  },
});

describe('Fastify app', () => {
  it('rejects an invalid GitLab webhook token', async () => {
    const database = new SqliteDatabase(':memory:');
    const onReviewReceived = vi.fn(async () => undefined);
    const app = buildApp({ queue: new ReviewQueue(database), webhookSecret: 'secret', onReviewReceived });
    const response = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: payload(), headers: { 'x-gitlab-token': 'wrong' } });
    expect(response.statusCode).toBe(401);
    expect(onReviewReceived).not.toHaveBeenCalled();
    await app.close();
    database.close();
  });

  it('queues only MR open events and treats duplicate deliveries idempotently', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const app = buildApp({ queue, webhookSecret: 'secret' });
    const headers = { 'x-gitlab-token': 'secret' };
    const ignored = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: payload('update'), headers });
    expect(ignored.statusCode).toBe(202);
    expect(queue.list()).toHaveLength(0);
    const first = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: payload(), headers });
    const duplicate = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: payload(), headers });
    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(queue.list()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/reviews' })).statusCode).toBe(200);
    await app.close();
    database.close();
  });

  it('accepts GitLab create payloads that omit target SHA', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const app = buildApp({ queue, webhookSecret: 'secret' });
    const body = payload();
    delete (body.object_attributes as Record<string, unknown>).target_branch_sha;
    const response = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: body, headers: { 'x-gitlab-token': 'secret' } });
    expect(response.statusCode).toBe(202);
    expect(queue.list()[0]?.targetSha).toBe('unknown');
    await app.close();
    database.close();
  });

  it('does not comment on ignored events or malformed MR creation events', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const onReviewReceived = vi.fn(async () => undefined);
    const app = buildApp({ queue, webhookSecret: 'secret', onReviewReceived });
    try {
      const headers = { 'x-gitlab-token': 'secret' };
      const ignored = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: payload('update'), headers });
      expect(ignored.json().ignored).toBe(true);
      const invalid = payload();
      invalid.object_attributes.iid = 0;
      const rejected = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: invalid, headers });
      expect(rejected.statusCode).toBe(400);
      expect(onReviewReceived).not.toHaveBeenCalled();
      expect(queue.list()).toHaveLength(0);
    } finally {
      await app.close();
      database.close();
    }
  });

  it('keeps the accepted review queued if the immediate comment fails', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const onReviewReceived = vi.fn(async () => { throw new Error('GitLab unavailable'); });
    const app = buildApp({ queue, webhookSecret: 'secret', onReviewReceived });
    try {
      const response = await app.inject({
        method: 'POST', url: '/webhooks/gitlab', payload: payload(), headers: { 'x-gitlab-token': 'secret' },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, receiptCommentStatus: 'failed' });
      expect(onReviewReceived).toHaveBeenCalledOnce();
      expect(queue.get(response.json().jobId)?.status).toBe('queued');
    } finally {
      await app.close();
      database.close();
    }
  });
});
