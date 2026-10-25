import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, SqliteCoordinationRunnerStore, RecoveryReader } from '../services/coordination/durable/index.ts';
import { executionFixture, clock } from './durable-execution-fixture.ts';
import { historicalDatabase } from './recovery-migration-fixture.ts';

for (const version of [0,1,2] as const) test(`v${version} -> v3 migration preserves artifacts and invents no Ledger history`, async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task); f.store.createCheckpoint('run');
  const path = join(f.dir, `v${version}.sqlite`);
  const before = version === 0 ? {} : historicalDatabase(f, path, version);
  for (let i = 0; i < 2; i++) {
    const db = new DurableDatabase({ path });
    try {
      const raw = new DatabaseSync(path);
      try {
        assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 4);
        assert.deepEqual(raw.prepare('SELECT schema_version FROM schema_migrations ORDER BY schema_version').all().map(r => r.schema_version), [1,2,3,4]);
        assert.equal(raw.prepare('SELECT count(*) AS n FROM runtime_audit_events').get()!.n, 0);
        for (const [table, rows] of Object.entries(before)) assert.deepEqual(raw.prepare(`SELECT * FROM ${table}`).all(), rows);
      } finally { raw.close(); }
      if (version > 0) {
        assert.deepEqual(new SqliteCoordinationRunnerStore(db).restoreWorkflow('run'), f.snapshot());
        const page = new RecoveryReader(db, clock).getWorkflowTimeline('run');
        assert.equal(page.entries.filter(e => e.source === 'JOURNAL').length, 4);
        assert.equal(page.entries.filter(e => e.source === 'EXECUTION_AUDIT').length, 0);
        if (version === 2) assert.equal(page.entries.at(-1)!.nextState, 'FINALIZED');
      }
    } finally { db.close(); }
  }
});
test('migration DDL exception rolls back all tables/triggers/version records and can retry', t => {
  const f = executionFixture(t); f.register(); const path = join(f.dir, 'rollback.sqlite'); historicalDatabase(f, path, 2);
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) { original.call(this, sql); if (sql.includes('CREATE TABLE runtime_audit_events')) throw Error('injected migration failure'); };
  try { assert.throws(() => new DurableDatabase({ path }), { code: 'DATABASE_ERROR' }); }
  finally { DatabaseSync.prototype.exec = original; }
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 2);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n, 2);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%audit%'").get()!.n, 0);
  const db = new DurableDatabase({ path }); db.close(); assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 4);
});
test('unsupported schema is rejected before schema mutation', t => {
  const f = executionFixture(t); const raw = f.raw(); raw.exec('PRAGMA user_version=999');
  assert.throws(() => new DurableDatabase({ path: f.path }), { code: 'SCHEMA_UNSUPPORTED' });
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 999);
});
