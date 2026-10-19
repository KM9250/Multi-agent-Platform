import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture, fresh, usage } from './durable-fixture.ts';
import { canonicalJson, digest } from '../services/coordination/durable/integrity.ts';
import { nextAnchor } from '../services/coordination/durable/restore.ts';
import { DurableDatabase } from '../services/coordination/durable/index.ts';
import type { CoordinationEvent } from '../services/coordination/types.ts';

function rewrite(raw: DatabaseSync, change: (e: CoordinationEvent) => void) {
  raw.exec('DROP TRIGGER journal_no_update');
  const rows = raw.prepare('SELECT * FROM journal_events ORDER BY sequence').all();
  let anchor = '';
  for (const row of rows) {
    const e = JSON.parse(String(row.payload)); if (row.sequence === 2) change(e);
    raw.prepare('UPDATE journal_events SET event_type=?, event_timestamp=?, payload=?, payload_digest=? WHERE sequence=?')
      .run(e.type, e.timestamp, canonicalJson(e), digest(e), row.sequence);
    anchor = nextAnchor(anchor, e);
  }
  raw.prepare('UPDATE workflow_seeds SET journal_anchor=?').run(anchor);
}
for (const [name, change] of [
  ['unsupported event type', (e: any) => { e.type = 'FutureEvent'; }],
  ['invalid transition', (e: any) => { e.type = 'WorkflowResumed'; e.payload = {}; }],
  ['backwards timestamp', (e: any) => { e.timestamp = 0; }],
  ['foreign workflow', (e: any) => { e.workflowRunId = 'foreign'; }],
  ['duplicate event ID', (e: any) => { e.eventId = 'run:created'; }],
  ['sequence gap', (e: any) => { e.sequence = 7; }],
] as const) {
  test(`Journal ${name} is refused even with recomputed digests, without repair events`, t => {
    const f = fixture(t); f.store.append(usage(fresh())); f.store.createCheckpoint('run');
    const raw = f.raw(); rewrite(raw, change);
    assert.throws(() => f.store.getSnapshot('run'));
    assert.throws(() => f.store.append(usage(fresh(), 'new')));
    assert.equal(raw.prepare('SELECT count(*) AS n FROM journal_events').get()!.n, 2);
  });
}
test('invalid Journal JSON and mismatched event digest fail safely', t => {
  const f = fixture(t); f.store.append(usage(fresh()));
  const raw = f.raw(); raw.exec('DROP TRIGGER journal_no_update');
  raw.prepare('UPDATE journal_events SET payload=? WHERE sequence=2').run('{private-goal');
  assert.throws(() => f.store.getSnapshot('run'), { code: 'INTEGRITY_ERROR', message: 'INTEGRITY_ERROR' });
});
test('missing middle sequence and missing seed creation are refused', t => {
  const f = fixture(t), second = f.store.append(usage(fresh())); f.store.append(usage(second, 'later'));
  const raw = f.raw(); raw.exec('DROP TRIGGER journal_no_delete; DELETE FROM journal_events WHERE sequence=2');
  assert.throws(() => f.store.getSnapshot('run'), { code: 'INTEGRITY_ERROR' });
  raw.exec('DELETE FROM journal_events WHERE sequence=1');
  assert.throws(() => f.store.getSnapshot('run'), { code: 'INTEGRITY_ERROR' });
});
test('policy copy or seed tampering is detected without substitution', t => {
  const f = fixture(t), raw = f.raw(); raw.exec('DROP TRIGGER seed_immutable');
  raw.prepare('UPDATE workflow_seeds SET policy_payload=?').run('{}');
  assert.throws(() => f.store.getSnapshot('run'), { code: 'INTEGRITY_ERROR' });
  raw.prepare('UPDATE workflow_seeds SET policy_payload=?, seed_payload=?').run(canonicalJson(fresh().policy), '{');
  assert.throws(() => f.store.getSnapshot('run'), { code: 'INTEGRITY_ERROR' });
});
test('future database/seed schemas and inconsistent migration ledgers are refused', t => {
  const f = fixture(t), raw = f.raw(); f.db.close();
  raw.exec('PRAGMA user_version=999'); assert.throws(() => f.open(), { code: 'SCHEMA_UNSUPPORTED' });
  raw.exec('PRAGMA user_version=1'); raw.prepare('UPDATE schema_migrations SET migration_id=?').run('future');
  assert.throws(() => f.open(), { code: 'INTEGRITY_ERROR' });
  raw.prepare('UPDATE schema_migrations SET migration_id=?').run('001_durable_coordination');
  raw.exec('DROP TRIGGER seed_immutable; UPDATE workflow_seeds SET schema_version=999');
  assert.throws(() => f.open().store.getSnapshot('run'), { code: 'SCHEMA_UNSUPPORTED' });
});
test('failure after migration DDL rolls back schema and ledger, and a clean retry succeeds', t => {
  const f = fixture(t), path = join(f.dir, 'migration.sqlite');
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) {
    original.call(this, sql);
    if (sql.includes('CREATE TABLE workflow_seeds')) throw new Error('migration failure');
  };
  try { assert.throws(() => new DurableDatabase({ path }), { code: 'DATABASE_ERROR' }); }
  finally { DatabaseSync.prototype.exec = original; }
  const raw = new DatabaseSync(path);
  try {
    assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n, 0);
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 0);
  } finally { raw.close(); }
  const db = new DurableDatabase({ path }); db.close();
});
