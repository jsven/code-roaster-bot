import { describe, expect, it, vi } from 'vitest';
import { SqliteDatabase } from '../../src/infrastructure/database/sqlite-database.js';
import { ReviewOrchestrator } from '../../src/application/review-orchestrator.js';
import { ReviewQueue } from '../../src/infrastructure/database/review-queue.js';

const jobInput = {
  repository: 'group/demo', projectId: '42', mrIid: 7,
  mrUrl: 'https://gitlab/mr/7', author: 'alice', sourceSha: 'abc', targetSha: 'def',
};
const raw = JSON.stringify({ summary: '发现问题', findings: [{
  severity: 'medium', title: '中问题', description: '说明', file: 'a.ts', line_start: 1, line_end: 1,
  code: 'input();', recommendation: '校验输入',
}] });

describe('ReviewOrchestrator', () => {
  it('posts the GitLab note and sends a Feishu notification for medium findings', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const job = queue.enqueue(jobInput);
    const gitlab = {
      getChanges: vi.fn(async () => ({ files: new Set(['a.ts']), diff: 'diff' })),
      hasRunNote: vi.fn(async () => false),
      createNote: vi.fn(async () => ({ id: '99' })),
    };
    const codex = { run: vi.fn(async () => raw) };
    const feishu = { sendSummary: vi.fn(async () => undefined) };
    const orchestrator = new ReviewOrchestrator(queue, gitlab, codex, feishu, 'medium');

    await orchestrator.execute(job);

    expect(gitlab.createNote).toHaveBeenCalledOnce();
    expect(feishu.sendSummary).toHaveBeenCalledOnce();
    expect(queue.get(job.id)).toMatchObject({ status: 'succeeded', commentStatus: 'succeeded', feishuStatus: 'succeeded' });
    database.close();
  });

  it('keeps the review succeeded when Feishu delivery fails', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const job = queue.enqueue(jobInput);
    const gitlab = {
      getChanges: vi.fn(async () => ({ files: new Set(['a.ts']), diff: 'diff' })),
      hasRunNote: vi.fn(async () => false),
      createNote: vi.fn(async () => ({ id: '99' })),
    };
    const codex = { run: vi.fn(async () => raw) };
    const feishu = { sendSummary: vi.fn(async () => { throw new Error('network'); }) };
    const orchestrator = new ReviewOrchestrator(queue, gitlab, codex, feishu, 'medium');

    await orchestrator.execute(job);

    expect(queue.get(job.id)).toMatchObject({ status: 'succeeded', feishuStatus: 'failed', feishuError: 'network' });
    database.close();
  });

  it('retries Feishu without posting a duplicate GitLab note', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const created = queue.enqueue(jobInput);
    queue.markSucceeded(created.id, '99');
    queue.setFeishuStatus(created.id, 'failed', 'network');
    queue.requeue(created.id);
    const job = queue.claimNext()!;
    const gitlab = {
      getChanges: vi.fn(async () => ({ files: new Set(['a.ts']), diff: 'diff' })),
      hasRunNote: vi.fn(async () => true),
      createNote: vi.fn(async () => ({ id: 'should-not-be-used' })),
    };
    const codex = { run: vi.fn(async () => raw) };
    const feishu = { sendSummary: vi.fn(async () => undefined) };
    const orchestrator = new ReviewOrchestrator(queue, gitlab, codex, feishu, 'medium');

    await orchestrator.execute(job);

    expect(gitlab.createNote).not.toHaveBeenCalled();
    expect(feishu.sendSummary).toHaveBeenCalledOnce();
    expect(queue.get(created.id)).toMatchObject({ status: 'succeeded', feishuStatus: 'succeeded' });
    database.close();
  });

  it('marks Feishu as skipped when the notifier is disabled', async () => {
    const database = new SqliteDatabase(':memory:');
    const queue = new ReviewQueue(database);
    const job = queue.enqueue(jobInput);
    const gitlab = {
      getChanges: vi.fn(async () => ({ files: new Set(['a.ts']), diff: 'diff' })),
      hasRunNote: vi.fn(async () => false),
      createNote: vi.fn(async () => ({ id: '99' })),
    };
    const codex = { run: vi.fn(async () => raw) };
    const feishu = { enabled: false, sendSummary: vi.fn(async () => undefined) };
    const orchestrator = new ReviewOrchestrator(queue, gitlab, codex, feishu, 'medium');

    await orchestrator.execute(job);

    expect(feishu.sendSummary).not.toHaveBeenCalled();
    expect(queue.get(job.id)?.feishuStatus).toBe('skipped');
    database.close();
  });
});
