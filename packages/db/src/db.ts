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
  migrate(db);
  return db;
}

/**
 * Column additions for databases that already exist.
 *
 * schema.sql is replayed in full on every open, which CREATE TABLE IF NOT
 * EXISTS tolerates and ALTER TABLE does not — a bare ALTER would throw
 * "duplicate column name" on the second start and take the daemon down with
 * it. Each addition is therefore checked first and recorded, so it runs once
 * and a fresh database is identical to a migrated one.
 */
function migrate(db: Db): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );

  const additions: { name: string; table: string; column: string; type: string }[] = [
    // Spend stopped being the constraint once it was clear Claude Code draws
    // from the same plan allowance as chat. The real ceiling is the plan's
    // usage limit, and it announces itself by failing a call.
    { name: '002_pause_until', table: 'budget_cycles', column: 'paused_until', type: 'TEXT' },
    { name: '002_pause_reason', table: 'budget_cycles', column: 'pause_reason', type: 'TEXT' },
  ];

  for (const a of additions) {
    if (columns(a.table).has(a.column)) continue;
    db.exec(`ALTER TABLE ${a.table} ADD COLUMN ${a.column} ${a.type}`);
    db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(a.name);
  }
}
