import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fixture, fresh, usage } from './durable-fixture.ts';
import type { DurableTransaction } from '../services/coordination/durable/db.ts';
import type { CoordinationSnapshot } from '../services/coordination/types.ts';
import { canonicalJson, digest } from '../services/coordination/durable/integrity.ts';
import { nextAnchor } from '../services/coordination/durable/restore.ts';
import { DurableDatabase, SqliteCoordinationRunnerStore, createRuntimeLeaseManager, RecoveryReader } from '../services/coordination/durable/index.ts';

const contents = (db: DurableDatabase) => db.read(tx => Object.fromEntries(
  ['workflow_seeds','journal_events','runtime_audit_events','runtime_leases'].map(table => [table, tx.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
function insertSeed(tx: DurableTransaction, seed: CoordinationSnapshot): void {
  tx.run('INSERT INTO workflow_seeds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', seed.run.runId, 1,
    canonicalJson(seed), canonicalJson(seed.policy), digest(seed), digest(seed.policy), seed.run.createdAt, 1, nextAnchor('', seed.events[0]));
}
function insertCreation(tx: DurableTransaction, seed: CoordinationSnapshot): void {
  const event = seed.events[0];
  tx.run('INSERT INTO journal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', event.workflowRunId, event.sequence,
    event.eventId, event.type, event.sessionId ?? null, event.actorAgentId ?? null, event.timestamp,
    event.idempotencyKey || null, canonicalJson(event), digest(event));
}
for (const withSeed of [false, true]) test(`F-01 Bootstrap phase calls cannot replace persisted artifacts (seed=${withSeed})`, t => {
  const f = fixture(t), seed = fresh('new'), before = contents(f.db);
  assert.throws(() => f.db.bootstrapWorkflow('new', tx => {
    if (withSeed) insertSeed(tx, seed);
    else assert.equal(tx.get("SELECT map_bootstrap('new','SEED') AS n")!.n, 1);
    assert.equal(tx.get("SELECT map_bootstrap('new','JOURNAL') AS n")!.n, 1);
    assert.equal(tx.get("SELECT map_bootstrap('new','AUDIT') AS n")!.n, 1);
  }), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f.db), before);
});
test('F-01 A caught initial Journal failure rolls back the Seed even after every phase was consumed', t => {
  const f = fixture(t), seed = fresh('new'), before = contents(f.db);
  // The creation INSERT reaches its Audit trigger, then the entire statement aborts.
  f.raw().exec("CREATE TRIGGER fail_creation AFTER INSERT ON runtime_audit_events WHEN NEW.workflow_run_id='new' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  let caught = false;
  assert.throws(() => f.db.bootstrapWorkflow('new', tx => {
    insertSeed(tx, seed);
    try { insertCreation(tx, seed); } catch { caught = true; }
    for (const phase of ['SEED','JOURNAL','AUDIT']) assert.equal(tx.get('SELECT map_bootstrap(?,?) AS n', 'new', phase)!.n, 0);
    assert.equal(tx.get("SELECT count(*) AS n FROM workflow_seeds WHERE workflow_run_id='new'")!.n, 1);
    assert.equal(tx.get("SELECT count(*) AS n FROM journal_events WHERE workflow_run_id='new'")!.n, 0);
    assert.equal(tx.get("SELECT count(*) AS n FROM runtime_audit_events WHERE workflow_run_id='new'")!.n, 0);
  }), { code: 'LEASE_FENCED' });
  assert.equal(caught, true); assert.deepEqual(contents(f.db), before);
  f.raw().exec('DROP TRIGGER fail_creation');
  f.store.createWorkflow(seed); // Rollback also cleared the Bootstrap context.
  assert.deepEqual(f.store.restoreWorkflow('new'), seed);
  assert.equal(new RecoveryReader(f.db).inspect('new').executionAllowed, false);
});
for (const mutation of ['seed','journal','audit']) test(`F-01 Pre-COMMIT validation rejects mismatched ${mutation} linkage`, t => {
  const f = fixture(t), seed = fresh('new'), before = contents(f.db);
  if (mutation === 'audit') {
    // Deliberately alter a trigger so SQL constraints alone permit incorrect entity linkage.
    const raw = f.raw(), sql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name='journal_audit_insert'").get()!.sql);
    raw.exec('DROP TRIGGER journal_audit_insert');
    raw.exec(sql.replace('coalesce(NEW.session_id, NEW.workflow_run_id)', "'foreign-workflow'"));
  }
  assert.throws(() => f.db.bootstrapWorkflow('new', tx => {
    insertSeed(tx, mutation === 'seed' ? { ...seed, run: { ...seed.run, goal: 'wrong seed' } } : seed);
    insertCreation(tx, mutation === 'journal' ? { ...seed, events: [{ ...seed.events[0], eventId: 'wrong-creation' }] } : seed);
  }), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f.db), before);
});
test('F-02 An ACTIVE-lease backup cannot use the original handle through any authorization API', t => {
  let copy: DurableDatabase;
  // Close the extra connection before fixture() removes its directory on Windows.
  t.after(() => copy?.close());
  const f = fixture(t), path = join(f.dir, 'copy.sqlite'); f.db.backup(path);
  copy = new DurableDatabase({ path });
  const leases = createRuntimeLeaseManager(copy), before = contents(copy);
  assert.equal(leases.inspect('run')!.state, 'ACTIVE');
  for (const operation of [
    () => copy.writeWithLease(f.lease, 'run', () => {}),
    () => new SqliteCoordinationRunnerStore(copy, f.lease).append(usage(fresh())),
    () => leases.assertCurrent(f.lease), () => leases.renew(f.lease), () => leases.release(f.lease),
    () => leases.startHeartbeat(f.lease, () => assert.fail('unexpected heartbeat')),
  ]) assert.throws(operation, { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(copy), before);
  f.manager.assertCurrent(f.lease); f.store.append(usage(fresh()));
});
test('F-02 Explicit original-handle sharing works across connections to the same physical database', t => {
  let other: DurableDatabase;
  t.after(() => other?.close());
  const f = fixture(t); other = new DurableDatabase({ path: f.path });
  const leases = createRuntimeLeaseManager(other), store = new SqliteCoordinationRunnerStore(other, f.lease);
  leases.assertCurrent(f.lease); leases.renew(f.lease);
  assert.equal(store.append(usage(fresh())).events.length, 2);
  f.manager.assertCurrent(f.lease);
  assert.deepEqual(store.restoreWorkflow('run'), f.store.restoreWorkflow('run'));
});
test('F-03 All installed Journal/Ledger audit triggers have explicit Runtime metadata columns and values', t => {
  const f = fixture(t), rows = f.db.read(tx => tx.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('journal_audit_insert','ledger_audit_insert','ledger_audit_update')"));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const sql = String(row.sql);
    assert.match(sql, /runtime_instance_id\s*,\s*runtime_generation/);
    assert.match(sql, /map_runtime_id\(\)\s*,\s*map_runtime_generation\(\)/);
    assert.equal(sql.match(/INSERT INTO runtime_audit_events/g)?.length, 1);
  }
});
