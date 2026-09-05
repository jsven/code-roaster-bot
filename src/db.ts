import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

export class SqliteDatabase {
  readonly raw: BetterSqlite3.Database;

  constructor(filename: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.raw = new BetterSqlite3(filename);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        event_id TEXT,
        event_type TEXT NOT NULL,
        project_id TEXT NOT NULL,
        mr_iid INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'received'
      );

      CREATE TABLE IF NOT EXISTS review_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        project_id TEXT NOT NULL,
        mr_iid INTEGER NOT NULL,
        mr_url TEXT NOT NULL,
        author TEXT NOT NULL,
        target_sha TEXT NOT NULL,
        source_sha TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        comment_status TEXT NOT NULL DEFAULT 'pending',
        comment_id TEXT,
        feishu_status TEXT NOT NULL DEFAULT 'skipped',
        feishu_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, mr_iid, source_sha)
      );

      CREATE TABLE IF NOT EXISTS review_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
        external_comment_id TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_jobs_status_created
        ON review_jobs(status, created_at);
    `);
  }

  close(): void {
    this.raw.close();
  }
}
