import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPath } from '../../../src/config/paths.js';
import { applyMigrations } from '../../../src/infrastructure/database/migrations.js';
import { SqliteDatabase } from '../../../src/infrastructure/database/sqlite-database.js';

describe('database migrations', () => {
  let directory: string;
  let migrationsDirectory: string;
  let database: BetterSqlite3.Database | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-migrations-'));
    migrationsDirectory = path.join(directory, 'migrations');
    fs.cpSync(projectPath('db', 'migrations'), migrationsDirectory, { recursive: true });
  });

  afterEach(() => {
    if (database?.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('initializes a fresh database and skips previously applied scripts after reopening', () => {
    const filename = path.join(directory, 'reviews.db');
    const first = new SqliteDatabase(filename, migrationsDirectory);
    const history = first.raw.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    expect(history).toHaveLength(2);
    first.close();

    const reopened = new SqliteDatabase(filename, migrationsDirectory);
    database = reopened.raw;
    expect(applyMigrations(database, migrationsDirectory)).toEqual([]);
    expect(database.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(history);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(expect.arrayContaining([
      { name: 'review_jobs' }, { name: 'review_comments' }, { name: 'webhook_events' },
    ]));
  });

  it('adopts the pre-migration schema while preserving jobs and adding list indexes', () => {
    const filename = path.join(directory, 'legacy.db');
    const legacy = new BetterSqlite3(filename);
    legacy.exec(fs.readFileSync(path.join(migrationsDirectory, '001_initial_schema.sql'), 'utf8'));
    legacy.prepare(`INSERT INTO review_jobs
      (repository, project_id, mr_iid, mr_url, author, target_sha, source_sha, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('group/existing', '42', 7, 'https://gitlab/mr/7', 'alice', 'base', 'head', 'succeeded', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z');
    const job = legacy.prepare('SELECT * FROM review_jobs').get();
    legacy.close();

    const upgraded = new SqliteDatabase(filename, migrationsDirectory);
    database = upgraded.raw;
    expect(database.prepare('SELECT * FROM review_jobs').get()).toEqual(job);
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual(expect.arrayContaining([
      { name: 'idx_review_jobs_created_id' }, { name: 'idx_review_jobs_repository_created_id' },
    ]));
  });

  it('applies an appended migration once without replaying earlier scripts', () => {
    database = new SqliteDatabase(':memory:', migrationsDirectory).raw;
    const history = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    fs.writeFileSync(path.join(migrationsDirectory, '003_review_label.sql'), 'ALTER TABLE review_jobs ADD COLUMN label TEXT;');
    expect(applyMigrations(database, migrationsDirectory)).toEqual(['003_review_label.sql']);
    expect(applyMigrations(database, migrationsDirectory)).toEqual([]);
    expect(database.prepare('SELECT * FROM schema_migrations ORDER BY version').all().slice(0, 2)).toEqual(history);
    expect(database.prepare('PRAGMA table_info(review_jobs)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'label' })]));
  });

  it('rolls back all pending schema changes and their history when a later script fails', () => {
    database = new SqliteDatabase(':memory:', migrationsDirectory).raw;
    fs.writeFileSync(path.join(migrationsDirectory, '003_review_label.sql'), 'ALTER TABLE review_jobs ADD COLUMN label TEXT;');
    fs.writeFileSync(path.join(migrationsDirectory, '004_invalid.sql'), 'INSERT INTO missing_table VALUES (1);');
    expect(() => applyMigrations(database!, migrationsDirectory)).toThrow();
    expect(database.prepare('PRAGMA table_info(review_jobs)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'label' })]));
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    fs.writeFileSync(path.join(migrationsDirectory, '004_invalid.sql'), 'ALTER TABLE review_jobs ADD COLUMN reference TEXT;');
    expect(applyMigrations(database, migrationsDirectory)).toEqual(['003_review_label.sql', '004_invalid.sql']);
  });

  it.each(['modified', 'deleted'])('rejects %s history scripts instead of silently changing migration history', (change) => {
    database = new SqliteDatabase(':memory:', migrationsDirectory).raw;
    const filename = path.join(migrationsDirectory, '001_initial_schema.sql');
    if (change === 'modified') fs.appendFileSync(filename, '\n-- edited after deployment\n');
    else fs.unlinkSync(filename);
    expect(() => applyMigrations(database!, migrationsDirectory)).toThrow(change === 'modified' ? /modified/ : /missing/);
    expect(database.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get()).toEqual({ total: 2 });
  });
});
