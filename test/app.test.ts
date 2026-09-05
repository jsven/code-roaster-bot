import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SqliteDatabase } from '../src/db.js';
import { ReviewQueue } from '../src/queue.js';

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
    const app = buildApp({ queue: new ReviewQueue(database), webhookSecret: 'secret' });
    const response = await app.inject({ method: 'POST', url: '/webhooks/gitlab', payload: payload(), headers: { 'x-gitlab-token': 'wrong' } });
    expect(response.statusCode).toBe(401);
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
});
