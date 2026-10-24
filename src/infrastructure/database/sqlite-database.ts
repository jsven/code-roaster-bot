import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from './migrations.js';

export class SqliteDatabase {
  readonly raw: BetterSqlite3.Database;

  constructor(filename: string, migrationsDirectory?: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.raw = new BetterSqlite3(filename);
    try {
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('foreign_keys = ON');
      applyMigrations(this.raw, migrationsDirectory);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}
