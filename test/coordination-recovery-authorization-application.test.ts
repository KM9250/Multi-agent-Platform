import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { appendEvent } from '../services/coordination/kernel.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { canonicalJson, digest } from '../services/coordination/durable/integrity.ts';
import { SqliteCoordinationRunnerStore } from '../services/coordination/durable/durableCoordinationStore.ts';
import { executionFixture, registration, record, clock } from './durable-execution-fixture.ts';

const tables = ['workflow_seeds','journal_events','pending_actions','execution_ledger','execution_results',
  'runner_evidence','model_call_ledger','model_call_attempts','recovery_holds','runtime_audit_events'];
function settled(t: TestContext, phase: 'PLAN' | 'VERIFY' = 'PLAN', existingSession = false) {
  const f = executionFixture(t), raw = f.raw(), ledger = new ModelCallLedger(f.store, clock);
  let task = registration(f.store).taskEvent;
  if (existingSession) f.store.append(registration(f.store).sessionEvent);
  const s = f.snapshot(), identity = { workflowRunId: 'run', modelCallId: 'application-model', attemptId: 'application-attempt', providerId: 'test', modelId: 'test' };
  const request = { ...identity, phase, roundKey: 'round', requestCursor: s.events.length, requestEventId: s.events.at(-1)!.eventId,
    quote: { providerId: 'test', modelId: 'test', maxAttempts: 1 as const, inputTokens: 1, maxOutputTokens: 1, maxEstimatedCost: 0,
      pricingId: 'fixture', conditions: 'fixture', requestDigest: 'a'.repeat(64) } };
  ledger.reserve(request); ledger.markDispatchIntent(identity);
  ledger.settle(identity, { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 }, true);
  const cursor = f.snapshot().events.length, reg = registration(f.store);
  task = { ...task, sequence: cursor + 1 };
  const snapshot = () => Object.fromEntries(tables.map(table => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const register = (round = 'round') => {
    const r = registration(f.store, record, round);
    return f.coordinator.registerAction(record, r.expected, r.sessionEvent, r.taskEvent);
  };
  const insertAction = (tx: Parameters<Parameters<typeof f.store.writeWorkflow>[1]>[0]) => {
    const a = record.action;
    tx.run('INSERT INTO pending_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 'run', record.sessionId, record.taskId,
      a.actionId, a.executorId, a.operation, a.actionClass, a.fingerprint, a.retrySafety, canonicalJson(a), digest(a), 1, 10,
      'map.runner.v1:round', digest([record, reg.expected.events.at(-1), reg.expected.policy, reg.sessionEvent, reg.taskEvent]));
  };
  assert.equal(ledger.inspect('run')[0].state, 'SETTLED');
  assert.equal(ledger.inspect('run')[0].application_status, 'PENDING_APPLICATION');
  return { ...f, rawConnection: raw, ledger, identity, request, cursor, reg, task, snapshotAll: snapshot, registerBound: register, insertAction };
}

test('F-01 bypass A: atomicApplication alone cannot register an Action during pending PLAN', t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.store.atomicApplication('run', () => f.registerBound()), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before);
});
for (const kind of ['SessionStarted','TaskAssigned'] as const) test(`F-01 bypass B: direct ${kind} transaction cannot use a pending response`, t => {
  const f = settled(t, 'PLAN', kind === 'TaskAssigned'), event = kind === 'SessionStarted' ? f.reg.sessionEvent : f.task;
  assert.doesNotThrow(() => appendEvent(f.snapshot(), event)); // The event itself is valid.
  const before = f.snapshotAll();
  assert.throws(() => f.store.writeWorkflow('run', tx => f.store.appendInTransaction(tx, event)), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 bypass C: lease-fenced direct SQL cannot insert a Pending Action during pending PLAN', t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.store.writeWorkflow('run', f.insertAction), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before);
});
for (const route of ['coordinator','journal','sql'] as const) test(`F-01 caught ${route} rejection poisons the whole transaction`, t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.store.atomicApplication('run', tx => {
    assert.throws(() => route === 'coordinator' ? f.registerBound() : route === 'journal'
      ? f.store.appendInTransaction(tx, f.reg.sessionEvent) : f.insertAction(tx), { code: 'RECOVERY_HELD' });
    f.add('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'must roll back' });
  }), { code: 'RECOVERY_UNAUTHORIZED' });
  assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 SQL observations and a forged scope DTO do not create PLAN application authority', t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.store.atomicApplication('run', tx => {
    const forged = JSON.stringify({ ...f.request, startCursor: f.cursor, verified: true, phase: 'PLAN' });
    assert.equal(tx.get("SELECT map_recovery_start('run','REGISTER',?) n", forged)!.n, 0);
    f.insertAction(tx);
  }), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 legitimate PLAN commits registration and APPLIED together; independent readers never see the prefix', t => {
  const f = settled(t), before = f.snapshotAll(); let callbacks = 0;
  const apply = () => { callbacks++; f.registerBound(); assert.deepEqual(f.snapshotAll(), before); return 'applied'; };
  const result = f.ledger.markApplied(f.identity, f.cursor, apply);
  assert.equal(result.status, 'APPLIED');
  assert.equal(f.snapshot().events.filter(e => e.type === 'SessionStarted').length, 1);
  assert.equal(f.snapshot().events.filter(e => e.type === 'TaskAssigned').length, 1);
  assert.equal(f.coordinator.inspectExecution('run', 'action')!.state, 'PREPARED');
  const row = f.ledger.inspect('run')[0];
  assert.equal(row.application_status, 'APPLIED'); assert.equal(row.application_start_cursor, f.cursor);
  assert.equal(row.application_digest, digest(f.snapshot().events.slice(f.cursor)));
  assert.equal(row.application_event_id, f.snapshot().events.at(-1)!.eventId);
  assert.equal(f.rawConnection.prepare("SELECT count(*) n FROM runtime_audit_events WHERE event_kind='MODEL_RESPONSE_APPLIED'").get()!.n, 1);
  const saved = f.snapshotAll();
  assert.equal(f.ledger.markApplied(f.identity, f.cursor, apply).status, 'ALREADY_APPLIED');
  assert.equal(callbacks, 1); assert.deepEqual(f.snapshotAll(), saved);
});
for (const boundary of ['session','task','ledger','receipt','audit','callback'] as const) test(`F-01 failure after ${boundary} rolls back all registration and receipt state`, t => {
  const f = settled(t), before = f.snapshotAll();
  if (boundary === 'session' || boundary === 'task') {
    const append = f.store.appendInTransaction.bind(f.store);
    f.store.appendInTransaction = (tx, e) => { const result = append(tx, e);
      if (e.type === (boundary === 'session' ? 'SessionStarted' : 'TaskAssigned')) throw Error('injected application failure');
      return result; };
  }
  if (boundary === 'ledger') f.rawConnection.exec("CREATE TRIGGER fail_application AFTER INSERT ON execution_ledger BEGIN SELECT RAISE(ABORT,'injected'); END");
  if (boundary === 'receipt') f.rawConnection.exec("CREATE TRIGGER fail_application AFTER UPDATE ON model_call_ledger WHEN NEW.application_status='APPLIED' BEGIN SELECT RAISE(ABORT,'injected'); END");
  if (boundary === 'audit') f.rawConnection.exec("CREATE TRIGGER fail_application AFTER INSERT ON runtime_audit_events WHEN NEW.event_kind='MODEL_RESPONSE_APPLIED' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => f.ledger.markApplied(f.identity, f.cursor, () => { f.registerBound(); if (boundary === 'callback') throw Error('injected application failure'); }));
  assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 caught SQL trigger failure inside a legitimate PLAN cannot commit even with a complete registration', t => {
  const f = settled(t), before = f.snapshotAll();
  f.rawConnection.exec("CREATE TRIGGER fail_extra BEFORE INSERT ON journal_events WHEN NEW.event_type='ProgressRecorded' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => f.ledger.markApplied(f.identity, f.cursor, () => {
    f.registerBound();
    assert.throws(() => f.add('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'rejected' }));
  }), { code: 'RECOVERY_UNAUTHORIZED' });
  assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 pending VERIFY cannot grant PLAN registration, including a claimed PLAN phase', t => {
  const f = settled(t, 'VERIFY'), before = f.snapshotAll();
  assert.throws(() => f.ledger.markApplied({ ...f.identity, phase: 'PLAN' } as typeof f.identity, f.cursor, () => f.registerBound()), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before);
});
for (const route of ['coordinator','sql'] as const) test(`F-01 verified PLAN scope cannot authorize ${route} dispatch before its receipt`, t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.store.atomicApplication('run', tx => f.db.commitModelApplication(tx, f.identity, f.cursor, () => {
    f.registerBound();
    if (route === 'coordinator') f.coordinator.reserveDispatch('run', f.snapshot().tasks.task);
    else tx.run("UPDATE execution_ledger SET state='DISPATCH_RESERVED',attempt_id='forged',reserved_at=10,updated_at=10 WHERE action_id='action'");
  })), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before); assert.equal(f.calls.execute, 0);
});
test('F-01 incomplete registration cannot produce APPLIED even when the participant error is caught', t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.store.atomicApplication('run', tx => {
    assert.throws(() => f.db.commitModelApplication(tx, f.identity, f.cursor, () => f.store.append(f.reg.sessionEvent)));
  }), { code: 'RECOVERY_UNAUTHORIZED' });
  assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 existing durable Hold defeats an otherwise valid current PLAN application', t => {
  const f = settled(t);
  assert.throws(() => f.store.assertRecoveryExecution('run'), { code: 'RECOVERY_HELD' });
  const before = f.snapshotAll(); let callbacks = 0;
  assert.throws(() => f.ledger.markApplied(f.identity, f.cursor, () => { callbacks++; f.registerBound(); }), { code: 'RECOVERY_HELD' });
  assert.equal(callbacks, 0); assert.deepEqual(f.snapshotAll(), before);
});
for (const field of ['workflowRunId','modelCallId','attemptId','providerId','modelId'] as const) test(`F-01 application identity mismatch ${field} never invokes registration`, t => {
  const f = settled(t), before = f.snapshotAll(); let callbacks = 0;
  assert.throws(() => f.ledger.markApplied({ ...f.identity, [field]: 'other' }, f.cursor, () => { callbacks++; f.registerBound(); }));
  assert.equal(callbacks, 0); assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 wrong Round fails the complete application; the private scope does not survive rollback', t => {
  const f = settled(t), before = f.snapshotAll();
  assert.throws(() => f.ledger.markApplied(f.identity, f.cursor, () => f.registerBound('wrong-round')));
  assert.deepEqual(f.snapshotAll(), before);
  assert.throws(() => f.store.atomicApplication('run', () => f.registerBound()), { code: 'RECOVERY_HELD' });
  assert.deepEqual(f.snapshotAll(), before);
  assert.equal(f.ledger.markApplied(f.identity, f.cursor, () => f.registerBound()).status, 'APPLIED');
});
for (const drift of ['cursor','journal-before-settlement','journal-after-settlement'] as const) test(`F-01 ${drift} does not bind stale application state`, t => {
  const f = settled(t); let cursor = f.cursor;
  if (drift === 'cursor') cursor++;
  if (drift === 'journal-after-settlement') f.add('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'intervening event' });
  if (drift === 'journal-before-settlement') {
    // Construct the same stale response through a fresh, ordinary call lifecycle.
    f.ledger.markDiscarded(f.identity, 'STALE_RESPONSE');
    const s = f.snapshot(), x = { ...f.request, modelCallId: 'second', attemptId: 'second', roundKey: 'second', requestCursor: s.events.length, requestEventId: s.events.at(-1)!.eventId };
    f.ledger.reserve(x); f.ledger.markDispatchIntent(x);
    f.add('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'intervening event' });
    f.ledger.settle(x, { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 }, true);
    f.identity = x; cursor = f.snapshot().events.length;
  }
  const before = f.snapshotAll(); let callbacks = 0;
  assert.throws(() => f.ledger.markApplied(f.identity, cursor, () => { callbacks++; f.registerBound(); }));
  assert.equal(callbacks, 0); assert.deepEqual(f.snapshotAll(), before);
});
test('F-01 a new Lease generation cannot apply a settled response owned by the old generation', t => {
  const f = settled(t); f.release(); const lease = f.acquire(), store = new SqliteCoordinationRunnerStore(f.db, lease), ledger = new ModelCallLedger(store, clock);
  const before = f.snapshotAll(); let callbacks = 0;
  assert.throws(() => ledger.markApplied(f.identity, f.cursor, () => { callbacks++; }), { code: 'LEASE_FENCED' });
  assert.equal(callbacks, 0); assert.deepEqual(f.snapshotAll(), before);
});
