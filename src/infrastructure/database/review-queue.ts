import type BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from './sqlite-database.js';

import type { ReviewJob, ReviewJobInput, ReviewJobStatus, ReviewListOptions, ReviewJobPage, WebhookEventInput } from '../../domain/review-job.js';
import type { ReviewQueuePort } from '../../application/ports.js';

type JobRow = {
  id: number;
  repository: string;
  project_id: string;
  mr_iid: number;
  mr_url: string;
  author: string;
  target_sha: string;
  source_sha: string;
  status: ReviewJobStatus;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  comment_status: string;
  comment_id: string | null;
  feishu_status: string;
  feishu_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

const now = (): string => new Date().toISOString();

export class ReviewQueue implements ReviewQueuePort {
  private readonly db: BetterSqlite3.Database;

  constructor(database: SqliteDatabase) {
    this.db = database.raw;
  }

  enqueue(input: ReviewJobInput): ReviewJob {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO review_jobs
        (repository, project_id, mr_iid, mr_url, author, target_sha, source_sha, created_at, updated_at)
      VALUES
        (@repository, @projectId, @mrIid, @mrUrl, @author, @targetSha, @sourceSha, @createdAt, @updatedAt)
      ON CONFLICT(project_id, mr_iid, source_sha) DO NOTHING
    `).run({ ...input, createdAt: timestamp, updatedAt: timestamp });

    const row = this.db.prepare(
      'SELECT * FROM review_jobs WHERE project_id = ? AND mr_iid = ? AND source_sha = ?',
    ).get(input.projectId, input.mrIid, input.sourceSha) as JobRow;
    return this.map(row);
  }

  recordWebhook(input: WebhookEventInput): void {
    this.db.prepare(`
      INSERT INTO webhook_events
        (provider, event_id, event_type, project_id, mr_iid, payload_hash, received_at)
      VALUES
        (@provider, @eventId, @eventType, @projectId, @mrIid, @payloadHash, @receivedAt)
    `).run({ ...input, receivedAt: now(), eventId: input.eventId ?? null });
  }

  claimNext(): ReviewJob | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM review_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1",
      ).get() as JobRow | undefined;
      if (!row) return undefined;
      const timestamp = now();
      this.db.prepare(
        "UPDATE review_jobs SET status = 'running', attempt = attempt + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      ).run(timestamp, timestamp, row.id);
      return this.db.prepare('SELECT * FROM review_jobs WHERE id = ?').get(row.id) as JobRow;
    })();
    return claim ? this.map(claim) : undefined;
  }

  get(id: number): ReviewJob | undefined {
    const row = this.db.prepare('SELECT * FROM review_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? this.map(row) : undefined;
  }

  list(): ReviewJob[] {
    const rows = this.db.prepare('SELECT * FROM review_jobs ORDER BY created_at DESC, id DESC').all() as JobRow[];
    return rows.map((row) => this.map(row));
  }

  listPage(options: ReviewListOptions = {}): ReviewJobPage {
    const pageSize = options.pageSize ?? 20;
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (options.repository) {
      conditions.push('repository = @repository');
      params.repository = options.repository;
    }
    if (options.createdFrom) {
      conditions.push('created_at >= @createdFrom');
      params.createdFrom = options.createdFrom;
    }
    if (options.createdBefore) {
      conditions.push('created_at < @createdBefore');
      params.createdBefore = options.createdBefore;
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db.transaction(() => {
      const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM review_jobs${where}`).get(params) as { total: number };
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(options.page ?? 1, totalPages);
      const rows = this.db.prepare(
        `SELECT * FROM review_jobs${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
      ).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as JobRow[];
      return { items: rows.map((row) => this.map(row)), total, page, pageSize, totalPages };
    })();
  }

  listRepositories(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT repository FROM review_jobs ORDER BY repository COLLATE NOCASE, repository',
    ).all() as Array<{ repository: string }>;
    return rows.map((row) => row.repository);
  }

  markCommenting(id: number): void {
    this.update(id, { status: 'commenting', commentStatus: 'sending' });
  }

  markSucceeded(id: number, commentId: string): void {
    this.update(id, { status: 'succeeded', commentStatus: 'succeeded', commentId, finishedAt: now() });
  }

  markFailed(id: number, errorCode: string, errorMessage?: string): void {
    this.update(id, { status: 'failed', errorCode, errorMessage, finishedAt: now() });
  }

  markCommentFailed(id: number, errorMessage: string): void {
    this.update(id, { commentStatus: 'failed', errorMessage, finishedAt: now(), status: 'failed' });
  }

  setFeishuStatus(id: number, status: string, error?: string): void {
    this.update(id, { feishuStatus: status, feishuError: error });
  }

  requeue(id: number): void {
    this.update(id, { status: 'queued', errorCode: undefined, errorMessage: undefined, finishedAt: undefined });
  }

  requeueStale(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const timestamp = now();
    const result = this.db.prepare(
      "UPDATE review_jobs SET status = 'queued', error_code = 'worker_recovered', updated_at = ?, finished_at = NULL WHERE status IN ('running', 'commenting') AND updated_at <= ?",
    ).run(timestamp, cutoff);
    return result.changes;
  }

  private update(id: number, values: Record<string, unknown>): void {
    const columns: Record<string, string> = {
      status: 'status', errorCode: 'error_code', errorMessage: 'error_message', commentStatus: 'comment_status',
      commentId: 'comment_id', feishuStatus: 'feishu_status', feishuError: 'feishu_error',
      finishedAt: 'finished_at',
    };
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: now() };
    for (const [key, value] of Object.entries(values)) {
      const column = columns[key];
      if (!column) continue;
      assignments.push(`${column} = @${key}`);
      params[key] = value ?? null;
    }
    assignments.push('updated_at = @updatedAt');
    this.db.prepare(`UPDATE review_jobs SET ${assignments.join(', ')} WHERE id = @id`).run(params);
  }

  private map(row: JobRow): ReviewJob {
    return {
      id: row.id, repository: row.repository, projectId: row.project_id, mrIid: row.mr_iid,
      mrUrl: row.mr_url, author: row.author, targetSha: row.target_sha, sourceSha: row.source_sha,
      status: row.status, attempt: row.attempt, errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined, commentStatus: row.comment_status,
      commentId: row.comment_id ?? undefined, feishuStatus: row.feishu_status,
      feishuError: row.feishu_error ?? undefined, createdAt: row.created_at,
      startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }
}
