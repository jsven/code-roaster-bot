import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { projectPath } from '../../config/paths.js';

interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

type AppliedMigration = Omit<Migration, 'sql'>;

export function applyMigrations(database: BetterSqlite3.Database, directory = projectPath('db', 'migrations')): string[] {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.sql'));
  if (files.length === 0) throw new Error(`No database migrations found in ${directory}`);
  const versions = new Set<number>();
  const migrations = files.map((name): Migration => {
    const match = /^(\d{3,})_[a-z0-9_]+\.sql$/.exec(name);
    const version = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid migration filename: ${name}`);
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    const sql = fs.readFileSync(path.join(directory, name), 'utf8');
    return { version, name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  }).sort((a, b) => a.version - b.version);
  const historySql = fs.readFileSync(projectPath('db', 'migration-history.sql'), 'utf8');

  // Lock before reading history so concurrent processes cannot run the same migration twice.
  return database.transaction(() => {
    database.exec(historySql);
    const applied = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as AppliedMigration[];
    const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const record of applied) {
      const migration = byVersion.get(record.version);
      if (!migration) throw new Error(`Applied migration is missing: ${record.name}`);
      if (record.name !== migration.name || record.checksum !== migration.checksum) {
        throw new Error(`Applied migration was modified: ${record.name}`);
      }
    }
    const completed = new Set(applied.map((record) => record.version));
    const latestVersion = applied.at(-1)?.version ?? 0;
    const insert = database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
    const executed: string[] = [];
    for (const migration of migrations) {
      if (completed.has(migration.version)) continue;
      if (migration.version < latestVersion) throw new Error(`Migration must be appended after version ${latestVersion}: ${migration.name}`);
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      executed.push(migration.name);
    }
    return executed;
  }).immediate();
}
