import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import type { executionFixture } from './durable-execution-fixture.ts';
import { tables } from './recovery-fixture.ts';
export function historicalDatabase(f: ReturnType<typeof executionFixture>, path: string, version: 1 | 2) {
  const raw = new DatabaseSync(path); raw.exec('PRAGMA foreign_keys=OFF');
  raw.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY,migration_id TEXT NOT NULL UNIQUE,applied_at INTEGER NOT NULL) STRICT');
  for (const migration of MIGRATIONS.slice(0, version)) {
    raw.exec(migration.sql); raw.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version, migration.id, 1);
  }
  raw.exec(`PRAGMA user_version=${version}`);
  const before = f.db.read(tx => Object.fromEntries(tables.slice(0, version === 1 ? 3 : 7).map(table => [table, tx.all(`SELECT * FROM ${table}`)])));
  for (const [table, rows] of Object.entries(before)) for (const row of rows) raw.prepare(`INSERT INTO ${table} VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  raw.close(); return before;
}
