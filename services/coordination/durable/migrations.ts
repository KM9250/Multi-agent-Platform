import type { DatabaseSync } from 'node:sqlite';
import { DurableStoreError, requireIntegrity } from './integrity';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

/** Caller owns BEGIN IMMEDIATE and rollback, including the migration ledger. */
export function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new DurableStoreError('SCHEMA_UNSUPPORTED');
  const ledgerExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!ledgerExists) {
    requireIntegrity(version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0);
    db.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT');
  }
  const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY schema_version').all();
  requireIntegrity(applied.length === version);
  applied.forEach((row, i) => requireIntegrity(row.schema_version === MIGRATIONS[i]?.version && row.migration_id === MIGRATIONS[i]?.id));
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.id, Date.now());
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
}
