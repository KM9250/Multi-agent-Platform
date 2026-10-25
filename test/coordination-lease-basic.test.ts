import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect as inspectObject } from 'node:util';
import { fixture, fresh, usage } from './durable-fixture.ts';
import { createRuntimeLeaseManager, RecoveryReader, SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
import { untilExpired, delay } from './lease-fixture.ts';

const contents = (f: ReturnType<typeof fixture>) => f.db.read(tx => Object.fromEntries(['runtime_leases','runtime_audit_events','workflow_seeds','journal_events'].map(table => [table, tx.all(`SELECT * FROM ${table} ORDER BY rowid`)])));
test('Acquire, renew, release, reacquire retain monotonic generation and immutable metadata-only handles', t => {
  const f = fixture(t), { manager, lease } = f;
  assert.equal(manager.inspect('run')!.state, 'ACTIVE'); assert.equal(lease.generation, 1);
  assert.notEqual(lease.runtimeInstanceId, 'supervisor');
  assert.throws(() => manager.acquire('run'), { code: 'LEASE_HELD' });
  const count = contents(f).runtime_audit_events.length;
  assert.equal(manager.renew(lease), lease); assert.equal(lease.generation, 1);
  assert.equal(contents(f).runtime_audit_events.length, count);
  manager.release(lease);
  assert.equal(manager.inspect('run')!.state, 'RELEASED');
  assert.throws(() => f.store.append(usage(fresh())), { code: 'LEASE_FENCED' });
  const next = manager.acquire('run'); assert.equal(next.generation, 2);
  assert.equal(next.runtimeInstanceId, lease.runtimeInstanceId);
  assert.throws(() => manager.release(lease), { code: 'LEASE_FENCED' });
  assert.throws(() => manager.renew(lease), { code: 'LEASE_FENCED' });
  f.store.withLease(next).append(usage(fresh()));
  assert.equal(manager.inspect('run')!.generation, 2);
  const events = new RecoveryReader(f.db).getWorkflowTimeline('run').entries.filter(e => e.eventKind.startsWith('LEASE_'));
  assert.deepEqual(events.map(e => [e.eventKind, e.generation]), [['LEASE_ACQUIRED',1],['LEASE_RELEASED',1],['LEASE_ACQUIRED',2]]);
  assert.equal(events[2].reasonCode, 'REACQUIRE_AFTER_RELEASE');
});
test('Expiry cannot be renewed; read-only inspection never generates an expiration event or takes ownership', async t => {
  const f = fixture(t); f.release();
  const manager = createRuntimeLeaseManager(f.db, { ttlMs: 100 });
  const lease = manager.acquire('run'), before = contents(f);
  await untilExpired(lease.expiresAt);
  assert.equal(manager.inspect('run')!.state, 'EXPIRED');
  assert.deepEqual(contents(f), before);
  assert.throws(() => manager.renew(lease), { code: 'LEASE_FENCED' });
  const next = manager.acquire('run'); assert.equal(next.generation, lease.generation + 1);
  assert.equal(new RecoveryReader(f.db).inspect('run').executionAllowed, false);
  assert.equal(new RecoveryReader(f.db).inspect('run').executable, false);
  const events = new RecoveryReader(f.db).getWorkflowTimeline('run').entries;
  assert.equal(events.at(-1)!.eventKind, 'LEASE_TAKEN_OVER');
  assert.equal(events.at(-1)!.previousState, 'EXPIRED');
});
test('DTO copies, forged identity, and a different Workflow cannot authorize writes', t => {
  const f = fixture(t); f.store.createWorkflow(fresh('other'));
  const before = contents(f);
  for (const lease of [{ ...f.lease }, JSON.parse(JSON.stringify(f.lease)), { ...f.lease, generation: 9000 }]) {
    assert.throws(() => f.db.writeWithLease(lease, 'run', () => {}), { code: 'LEASE_FENCED' });
  }
  assert.throws(() => f.db.writeWithLease(f.lease, 'other', () => {}), { code: 'LEASE_FENCED' });
  assert.throws(() => f.store.append(usage(fresh('other'))), { code: 'LEASE_FENCED' });
  assert.throws(() => new SqliteCoordinationRunnerStore(f.db).append(usage(fresh())), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before);
  const json = JSON.stringify([f.lease, f.manager.inspect('run'), new RecoveryReader(f.db).getWorkflowTimeline('run')]);
  assert.doesNotMatch(json + inspectObject(f.lease), /capability|lease_capability_hash/i);
});
test('Bootstrap cannot update an existing Workflow or create extra artifacts', t => {
  const f = fixture(t), before = contents(f);
  assert.throws(() => f.db.bootstrapWorkflow('run', tx => tx.run('UPDATE workflow_seeds SET last_sequence=2')), { code: 'WORKFLOW_EXISTS' });
  assert.throws(() => f.db.bootstrapWorkflow('new', tx => tx.run('UPDATE workflow_seeds SET last_sequence=2')), { code: 'LEASE_FENCED' });
  assert.throws(() => f.db.bootstrapWorkflow('new', () => {}), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before);
});
test('SQLite triggers reject direct old-runtime writes and unfenced transactions with fixed public errors', t => {
  const f = fixture(t), raw = f.raw(), before = contents(f);
  assert.throws(() => raw.exec('UPDATE workflow_seeds SET last_sequence=2'));
  assert.throws(() => raw.exec("UPDATE runtime_leases SET lease_state='RELEASED'"));
  assert.throws(() => raw.exec('DELETE FROM runtime_leases'));
  assert.throws(() => raw.exec('UPDATE runtime_fencing_boundary SET legacy_audit_sequence=9999'));
  assert.throws(() => raw.exec('DELETE FROM runtime_fencing_boundary'));
  assert.throws(() => raw.exec('INSERT OR REPLACE INTO runtime_fencing_boundary VALUES (1,9999)'));
  assert.throws(() => f.db.write(tx => tx.run('UPDATE workflow_seeds SET last_sequence=2')), { code: 'LEASE_FENCED', message: 'LEASE_FENCED' });
  // Context is cleared after both a successful and a failed scope.
  f.store.writeWorkflow('run', tx => tx.get('SELECT workflow_run_id FROM workflow_seeds'));
  assert.throws(() => f.db.write(tx => tx.run('UPDATE workflow_seeds SET last_sequence=2')), { code: 'LEASE_FENCED' });
  assert.throws(() => f.store.writeWorkflow('run', () => { throw Error('private'); }), { code: 'DATABASE_ERROR' });
  assert.throws(() => f.db.write(tx => tx.run('UPDATE workflow_seeds SET last_sequence=2')), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before);
});
test('Audit failure rolls back both initial acquisition and release, leaving generation unchanged', t => {
  const f = fixture(t); f.store.createWorkflow(fresh('other'));
  const before = contents(f);
  f.raw().exec("CREATE TRIGGER fail_lease_audit BEFORE INSERT ON runtime_audit_events WHEN NEW.event_kind LIKE 'LEASE_%' BEGIN SELECT RAISE(ABORT,'private'); END");
  assert.throws(() => f.manager.acquire('other'), { code: 'DATABASE_ERROR', message: 'DATABASE_ERROR' });
  assert.equal(f.manager.inspect('other'), undefined);
  assert.throws(() => f.manager.release(f.lease), { code: 'DATABASE_ERROR' });
  assert.deepEqual(contents(f), before);
});
test('Explicit heartbeat lifecycle is quiet on success and stops permanently after failure', async t => {
  const f = fixture(t); f.release();
  const manager = createRuntimeLeaseManager(f.db, { ttlMs: 250, heartbeatIntervalMs: 20 }), lease = manager.acquire('run');
  const count = contents(f).runtime_audit_events.length;
  let code = '';
  const stop = manager.startHeartbeat(lease, reason => { code = reason; });
  await delay(75); assert.ok(lease.expiresAt > lease.acquiredAt + 250);
  assert.equal(contents(f).runtime_audit_events.length, count);
  f.raw().exec("CREATE TRIGGER fail_renew BEFORE UPDATE ON runtime_leases BEGIN SELECT RAISE(ABORT,'private'); END");
  await delay(60); assert.equal(code, 'DATABASE_ERROR');
  assert.throws(() => f.store.withLease(lease).append(usage(fresh())), { code: 'LEASE_FENCED' });
  stop();
});
test('Generation overflow fails closed without replacing the retained row or audit', t => {
  const f = fixture(t); f.release(); const raw = f.raw();
  // Explicit hostile/corruption setup, never a supported generation reset API.
  raw.exec('DROP TRIGGER leases_update; DROP TRIGGER lease_audit_update');
  raw.exec('UPDATE runtime_leases SET generation=9007199254740991');
  const before = contents(f);
  assert.throws(() => f.manager.acquire('run'), { code: 'LEASE_GENERATION_EXHAUSTED' });
  assert.deepEqual(contents(f), before);
});

test('A zero-row heartbeat never reports success and rolls back any provisional changes', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture(t), before = contents(f), prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === 'SELECT changes() AS n') statement.get = () => ({ n: 0 });
    return statement;
  };
  try { assert.throws(() => f.manager.renew(f.lease), { code: 'LEASE_FENCED' }); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.deepEqual(contents(f), before);
  assert.throws(() => f.manager.assertCurrent(f.lease), { code: 'LEASE_FENCED' });
});
test('Audit failure during expired takeover rolls ownership and generation back atomically', async t => {
  const f = fixture(t); f.release(); const manager = createRuntimeLeaseManager(f.db, { ttlMs: 100 });
  const lease = manager.acquire('run'); await untilExpired(lease.expiresAt); const before = contents(f);
  f.raw().exec("CREATE TRIGGER fail_takeover BEFORE INSERT ON runtime_audit_events WHEN NEW.event_kind='LEASE_TAKEN_OVER' BEGIN SELECT RAISE(ABORT,'private'); END");
  assert.throws(() => manager.acquire('run'), { code: 'DATABASE_ERROR' });
  assert.deepEqual(contents(f), before);
});
