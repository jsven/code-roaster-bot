import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { SqliteDatabase } from '../../src/infrastructure/database/sqlite-database.js';
import { ReviewQueue } from '../../src/infrastructure/database/review-queue.js';

describe('review list pagination and filters', () => {
  let database: SqliteDatabase;
  let queue: ReviewQueue;
  let app: ReturnType<typeof buildApp>;
  let matchingIds: number[];
  let sequence: number;

  const add = (repository: string, timestamp: string): number => {
    const job = queue.enqueue({
      repository, projectId: '42', mrIid: 1, mrUrl: 'https://gitlab.example.com/mr/1',
      author: 'alice', sourceSha: `sha-${sequence++}`, targetSha: 'base',
    });
    database.raw.prepare('UPDATE review_jobs SET created_at = ? WHERE id = ?').run(timestamp, job.id);
    return job.id;
  };

  beforeEach(() => {
    database = new SqliteDatabase(':memory:');
    queue = new ReviewQueue(database);
    app = buildApp({ queue, webhookSecret: 'secret' });
    sequence = 0;
    matchingIds = Array.from({ length: 25 }, () => add('group/demo', '2026-10-23T16:00:00.000Z'));
    matchingIds.push(add('group/demo', '2026-10-24T15:59:59.999Z'));
    add('other/repo', '2026-10-24T04:00:00.000Z');
    add('group/demo', '2026-10-23T15:59:59.999Z');
    add('group/demo', '2026-10-24T16:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('paginates in the database with totals and stable ordering for equal timestamps', async () => {
    const first = await app.inject('/api/reviews');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ total: 29, page: 1, pageSize: 20, totalPages: 2 });
    expect(first.json().items).toHaveLength(20);
    const second = (await app.inject('/api/reviews?page=2')).json();
    expect(second.items).toHaveLength(9);
    const ids = [...first.json().items, ...second.items].map((job: { id: number }) => job.id);
    expect(new Set(ids).size).toBe(29);
    expect(ids).toEqual(queue.list().map((job) => job.id));
  });

  it('combines exact repository matching with inclusive Beijing calendar dates before pagination', async () => {
    const response = await app.inject('/api/reviews?repository=group%2Fdemo&startDate=2026-10-24&endDate=2026-10-24&page=2');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 26, page: 2, pageSize: 20, totalPages: 2 });
    expect(response.json().items.map((job: { id: number }) => job.id)).toEqual([...matchingIds].reverse().slice(20));
    const from = (await app.inject('/api/reviews?startDate=2026-10-25')).json();
    expect(from.total).toBe(1);
    const through = (await app.inject('/api/reviews?endDate=2026-10-23')).json();
    expect(through.total).toBe(1);
  });

  it('clamps pages after filtering, supports page size changes, and handles no matches', async () => {
    const last = (await app.inject('/api/reviews?page=999&pageSize=10')).json();
    expect(last).toMatchObject({ total: 29, page: 3, pageSize: 10, totalPages: 3 });
    expect(last.items).toHaveLength(9);
    const empty = await app.inject('/api/reviews?repository=missing&page=2');
    expect(empty.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 });
    // Repository values are bound as SQL parameters, including quotes and SQL syntax.
    expect((await app.inject(`/api/reviews?repository=${encodeURIComponent("' OR 1=1 --")}`)).json().total).toBe(0);
  });

  it('keeps filters in pagination URLs and offers all repositories regardless of the current filter', async () => {
    const response = await app.inject('/reviews?repository=group%2Fdemo&startDate=2026-10-24&endDate=2026-10-24&page=2');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<option value="group/demo" selected>');
    expect(response.body).toContain('<option value="other/repo">');
    expect(response.body).toContain('name="startDate" value="2026-10-24"');
    expect(response.body).toContain('name="endDate" value="2026-10-24"');
    expect(response.body).toContain('/reviews?page=1&amp;pageSize=20&amp;repository=group%2Fdemo&amp;startDate=2026-10-24&amp;endDate=2026-10-24');
    expect(response.body).toContain('共 26 条，显示第 21–26 条');
    expect(response.body).toContain('第 2 / 2 页');
    expect(response.body).toContain('2026/10/24 00:00:00');
    expect(response.body).toContain('aria-disabled="true">下一页');
    const empty = await app.inject('/reviews?repository=missing');
    expect(empty.body).toContain('暂无符合条件的任务');
    expect(empty.body).toContain('共 0 条，显示第 0–0 条');
    const escaped = await app.inject(`/reviews?repository=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(escaped.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped.body).not.toContain('<script>');
  });

  it.each([
    'page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=9007199254740992',
    'pageSize=0', 'pageSize=101', 'pageSize=1.5',
    'startDate=2026-02-30', 'endDate=2026-13-01', 'startDate=2026-1-1',
    'startDate=0000-01-01', 'startDate=2026-10-25&endDate=2026-10-24',
  ])('rejects invalid query parameters: %s', async (query) => {
    for (const route of ['/api/reviews', '/reviews']) {
      const response = await app.inject(`${route}?${query}`);
      expect(response.statusCode).toBe(400);
    }
  });
});
