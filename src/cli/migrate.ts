import 'dotenv/config';
import path from 'node:path';
import { SqliteDatabase } from '../infrastructure/database/sqlite-database.js';

// Database maintenance does not require GitLab or Codex credentials.
const database = new SqliteDatabase(path.resolve(process.env.DATABASE_PATH?.trim() || './data/reviews.db'));
try {
  console.log('数据库迁移完成');
} finally {
  database.close();
}
