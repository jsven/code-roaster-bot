import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../../../src/infrastructure/database/sqlite-database.js';
import { ReviewQueue } from '../../../src/infrastructure/database/review-queue.js';

const input = {
  repository: 'group/demo',
  projectId: '42',
  mrIid: 7,
  mrUrl: 'https://gitlab.example.com/group/demo/-/merge_requests/7',
  author: 'alice',
  sourceSha: 'source-sha',
  targetSha: 'target-sha',
};

describe('ReviewQueue', () => {
  it('persists and claims one queued job idempotently', () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);

    const first = queue.enqueue(input);
    const duplicate = queue.enqueue(input);

    expect(duplicate.id).toBe(first.id);
    expect(queue.claimNext()?.id).toBe(first.id);
    expect(queue.claimNext()).toBeUndefined();
    expect(queue.get(first.id)?.status).toBe('running');

    database.close();
  });

  it('records failure and requeues stale work without storing finding content', () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const job = queue.enqueue(input);

    queue.claimNext();
    queue.markFailed(job.id, 'codex_timeout');
    expect(queue.get(job.id)?.status).toBe('failed');
    queue.requeue(job.id);
    expect(queue.get(job.id)?.status).toBe('queued');
    queue.claimNext();
    queue.requeueStale(0);
    expect(queue.get(job.id)?.status).toBe('queued');

    const columns = database.raw.prepare('PRAGMA table_info(review_jobs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('description');
    expect(columns.map((column) => column.name)).not.toContain('code_snippet');
    database.close();
  });
});
