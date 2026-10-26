import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { executionFixture, record, registration, clock } from './durable-execution-fixture.ts';
import { usage, fresh } from './durable-fixture.ts';
import { contents } from './recovery-fixture.ts';
import { createRuntimeLeaseManager, DurableExecutionCoordinator, RecoveryReader, createDurableCoordinationRunner } from '../services/coordination/durable/index.ts';
import { untilExpired } from './lease-fixture.ts';

const owner = { workflowRunId: 'run', sessionId: 'session', taskId: 'task', actionId: 'action' };
test('Every Coordinator/Store/Evidence mutation is fenced after ownership changes, with no partial state or audit', async t => {
  const f = executionFixture(t), request = registration(f.store), task = f.register();
  await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task); f.store.createCheckpoint('run');
  f.release(); const next = f.manager.acquire('run'), before = contents(f);
  const operations = [
    () => f.store.append(usage(f.snapshot())), () => f.store.createCheckpoint('run'),
    () => f.coordinator.registerAction(record, request.expected, request.sessionEvent, request.taskEvent),
    () => f.coordinator.reserveDispatch('run', task),
    () => f.coordinator.recordResult('run', task, 'old-attempt', { status: 'succeeded', summary: 'private' }),
    () => f.coordinator.requireReview('run', task, 'EXECUTION_UNCERTAIN'),
    () => f.coordinator.finalizeResult('run', task), () => f.coordinator.completeUncertainBlock('run'),
  ];
  for (const operation of operations) { assert.throws(operation, { code: 'LEASE_FENCED' }); assert.deepEqual(contents(f), before); }
  await assert.rejects(f.coordinator.dispatch('run', task), { code: 'LEASE_FENCED' });
  await assert.rejects(f.coordinator.evidenceStore.withOwner(owner, () => f.coordinator.evidenceStore.put({ kind: 'test', content: 'private', createdAt: 10 })), { code: 'LEASE_FENCED' });
  const calls = { ...f.calls }; assert.equal((await f.runner.runOneRound('run')).errorCode, 'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.deepEqual(f.calls, calls); assert.deepEqual(contents(f), before);
  f.manager.assertCurrent(next);
});
test('SQLite itself rejects all protected INSERT paths and Ledger/head UPDATE without a verified scope', async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run', task); f.store.createCheckpoint('run');
  const before = contents(f);
  for (const table of ['journal_events','workflow_checkpoints','pending_actions','execution_ledger','execution_results','runner_evidence','runtime_audit_events']) {
    assert.throws(() => f.db.write(tx => tx.run(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`)), { code: 'LEASE_FENCED' });
    assert.deepEqual(contents(f), before);
  }
  for (const table of ['workflow_seeds','execution_ledger']) {
    assert.throws(() => f.db.write(tx => tx.run(`UPDATE ${table} SET workflow_run_id=workflow_run_id`)), { code: 'LEASE_FENCED' });
  }
  assert.deepEqual(contents(f), before);
});
test('A live handle cannot write a different Workflow inside an authorized transaction; preceding Journal and Audit roll back', t => {
  const f = executionFixture(t); f.store.createWorkflow(fresh('other')); const before = contents(f);
  const event = usage(f.snapshot());
  assert.throws(() => f.store.writeWorkflow('run', tx => {
    f.store.appendInTransaction(tx, event);
    tx.run("UPDATE workflow_seeds SET last_sequence=2 WHERE workflow_run_id='other'");
  }), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before);
});
test('Lease loss while Executor awaits leaves DISPATCH_RESERVED and refuses Result/Evidence without a second effect', async t => {
  const f = executionFixture(t), task = f.register(); let effects = 0;
  let next: import('../services/coordination/durable/index.ts').WorkflowLease;
  f.executor.execute = async () => {
    effects++; f.release(); next = f.manager.acquire('run');
    return { status: 'succeeded', summary: 'effect already happened' };
  };
  await assert.rejects(f.coordinator.dispatch('run', task), { code: 'LEASE_FENCED' });
  assert.equal(effects, 1);
  assert.equal(f.coordinator.inspectExecution('run', 'action')!.state, 'DISPATCH_RESERVED');
  assert.equal(f.snapshot().tasks.task.status, 'ASSIGNED');
  assert.equal(f.db.read(tx => tx.get('SELECT count(*) AS n FROM execution_results')!.n), 0);
  assert.equal(f.db.read(tx => tx.get('SELECT count(*) AS n FROM runner_evidence')!.n), 0);
  assert.equal(new RecoveryReader(f.db, clock).inspect('run').disposition, 'REVIEW_REQUIRED');
  await assert.rejects(f.coordinator.dispatch('run', task), { code: 'LEASE_FENCED' });
  const current = new DurableExecutionCoordinator(f.store.withLease(next!), f.registry, { clock });
  const prior = current.inspectExecution('run', 'action')!;
  await assert.rejects(current.dispatch('run', task), { code: 'EXECUTION_REVIEW_REQUIRED' });
  assert.deepEqual(current.inspectExecution('run', 'action'), prior); assert.equal(effects, 1);
});
for (const phase of ['plan','verify'] as const) test(`Lease loss during ${phase.toUpperCase()} discards the returned response and stops further work`, async t => {
  const f = executionFixture(t), original = f.provider[phase];
  let before: ReturnType<typeof contents> | undefined;
  f.provider[phase] = async (...args: any[]) => {
    const response = await (original as any)(...args);
    f.release(); f.manager.acquire('run'); before = contents(f);
    return response;
  };
  const result = await f.runner.runOneRound('run');
  assert.equal(result.errorCode, 'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.deepEqual(contents(f), before);
  assert.equal(f.calls.plan, 1); assert.equal(f.calls.execute, phase === 'plan' ? 0 : 1);
});
test('Expiration during a transaction rolls back the provisional Journal and Audit at COMMIT', async t => {
  const f = executionFixture(t); f.release(); const manager = createRuntimeLeaseManager(f.db, { ttlMs: 100 });
  const lease = manager.acquire('run'), store = f.store.withLease(lease), event = usage(f.snapshot()), before = contents(f);
  assert.throws(() => store.writeWorkflow('run', tx => {
    store.appendInTransaction(tx, event);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before); await untilExpired(lease.expiresAt);
});
for (const offset of [-60_000, 60_000]) test(`Abnormal database clock shift ${offset} invalidates the handle without mutations`, t => {
  const f = executionFixture(t), before = contents(f), prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes("unixepoch('subsec')") && sql.endsWith('AS now')) {
      const get = statement.get.bind(statement); statement.get = (...params: any[]) => ({ ...get(...params), now: Date.now() + offset });
    }
    return statement;
  };
  try { assert.throws(() => f.manager.assertCurrent(f.lease), { code: 'LEASE_FENCED' }); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.throws(() => f.store.append(usage(f.snapshot())), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before);
});

test('Catching a trigger fencing error cannot commit preceding state or audit changes', t => {
  const f = executionFixture(t); f.store.createWorkflow(fresh('other'));
  const event = usage(f.snapshot()), before = contents(f);
  assert.throws(() => f.store.writeWorkflow('run', tx => {
    f.store.appendInTransaction(tx, event);
    try { tx.run("UPDATE workflow_seeds SET last_sequence=2 WHERE workflow_run_id='other'"); } catch {}
  }), { code: 'LEASE_FENCED' });
  assert.deepEqual(contents(f), before);
});
