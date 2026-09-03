import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Agents write concurrently from timers; without this a slow write throws
  // SQLITE_BUSY instead of waiting for the lock.
  db.pragma('busy_timeout = 5000');

  const sql = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run('001_initial');
  return db;
}
