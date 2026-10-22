import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, DurableExecutionCoordinator, RecoveryReader } from '../services/coordination/durable/index.ts';
import { executionFixture, executionSeed, registration, record, clock } from './durable-execution-fixture.ts';
import { reader, contents } from './recovery-fixture.ts';
import { fixture, history, saveHistory } from './durable-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';

test('construction, repeated inspection and all four read APIs leave all durable tables and call counts unchanged', t => {
  const f = executionFixture(t); f.register(); f.store.createCheckpoint('run');
  const before = contents(f), calls = { ...f.calls }, r = reader(f);
  for (let i = 0; i < 3; i++) {
    const result = r.inspect('run'); assert.equal(result.nextStep, 'REVALIDATE_PREPARED_ACTION');
    assert.equal(result.executable, false); assert.equal(result.executionAllowed, false);
    assert.equal(result.modelCallCoverage, 'NOT_TRACKED_YET'); assert.equal(result.requiresExplicitAuthorization, true);
    assert.equal(r.inspectAll().length, 1); r.getWorkflowTimeline('run'); r.getActionHistory('run', 'action');
  }
  assert.deepEqual(contents(f), before); assert.deepEqual(f.calls, calls);
});
for (const state of ['PREPARED','DISPATCH_RESERVED','RESULT_RECORDED','FINALIZED','REVIEW_REQUIRED'] as const) test(`validated ${state} is classified without dispatch or mutation`, async t => {
  const f = executionFixture(t), task = f.register();
  if (state === 'DISPATCH_RESERVED') f.coordinator.reserveDispatch('run', task);
  if (['RESULT_RECORDED','FINALIZED'].includes(state)) await f.coordinator.dispatch('run', task);
  if (state === 'FINALIZED') f.coordinator.finalizeResult('run', task);
  if (state === 'REVIEW_REQUIRED') { f.coordinator.reserveDispatch('run', task); f.coordinator.requireReview('run', task, 'RESULT_INTEGRITY_UNAVAILABLE'); }
  const before = contents(f), calls = { ...f.calls }, result = reader(f).inspect('run');
  assert.equal(result.executionStates[0].state, state);
  assert.equal(result.disposition, ['DISPATCH_RESERVED','REVIEW_REQUIRED'].includes(state) ? 'REVIEW_REQUIRED' : 'READY_TO_RESUME');
  assert.equal(result.nextStep, state === 'PREPARED' ? 'REVALIDATE_PREPARED_ACTION' : state === 'RESULT_RECORDED' ? 'REFLECT_RECORDED_RESULT' : state === 'FINALIZED' ? 'CONTINUE_VERIFICATION' : 'REQUIRE_OPERATOR_REVIEW');
  assert.deepEqual(contents(f), before); assert.deepEqual(f.calls, calls);
});
for (const reason of ['EXECUTION_UNCERTAIN','RESULT_INTEGRITY_UNAVAILABLE'] as const) test(`review without Result preserves ${reason} and never fabricates a stop`, t => {
  const f = executionFixture(t), task = f.register(); f.coordinator.reserveDispatch('run', task); f.coordinator.requireReview('run', task, reason);
  const result = reader(f).inspect('run'); assert.equal(result.disposition, 'REVIEW_REQUIRED'); assert.ok(result.reasonCodes.includes(reason));
  assert.equal(result.nextStep, 'REQUIRE_OPERATOR_REVIEW'); assert.equal(f.snapshot().events.length, 3);
});
for (const finalize of [false,true]) test(`uncertain saved Result ${finalize ? 'after' : 'before'} TaskFailed diagnoses incomplete safety stop only`, async t => {
  const f = executionFixture(t), task = f.register(); f.executor.execute = async () => ({ status: 'uncertain', summary: 'private' });
  await f.coordinator.dispatch('run', task); if (finalize) f.coordinator.finalizeResult('run', task);
  const before = contents(f), result = reader(f).inspect('run');
  assert.equal(result.disposition, 'REVIEW_REQUIRED'); assert.equal(result.nextStep, 'COMPLETE_SAFETY_STOP'); assert.deepEqual(contents(f), before);
});
for (const type of ['WorkflowBlocked','WorkflowSuspended','WorkflowCancelled'] as const) test(`${type} remains stopped`, t => {
  const f = executionFixture(t); f.add(type, { reason: 'operator' });
  const result = reader(f).inspect('run'); assert.equal(result.disposition, type === 'WorkflowBlocked' ? 'REVIEW_REQUIRED' : 'INACTIVE');
  assert.equal(result.executable, false);
});
test('RESOLVED is inactive and historical Tasks are not dispatched', t => {
  const f = fixture(t), full = history(); saveHistory(f.store, full);
  assert.equal(new RecoveryReader(f.db, clock).inspect('run').disposition, 'INACTIVE');
});
test('SUSPENDED with a dispatch reservation retains the unresolved outcome diagnosis', t => {
  const f = executionFixture(t), task = f.register(); f.coordinator.reserveDispatch('run', task); f.add('WorkflowSuspended', {});
  const result = reader(f).inspect('run'); assert.equal(result.disposition, 'REVIEW_REQUIRED'); assert.equal(result.workflowStatus, 'SUSPENDED');
});
test('legacy Task without Pending Action/Ledger is reviewable; explicit missing Ledger is corrupt', t => {
  const f = executionFixture(t), request = registration(f.store); f.store.append(request.sessionEvent); f.store.append(request.taskEvent);
  assert.ok(reader(f).inspect('run').reasonCodes.includes('HISTORICAL_EXECUTION_UNTRACKED'));
  const g = executionFixture(t); g.register(); g.raw().exec('PRAGMA foreign_keys=OFF; DROP TRIGGER ledger_no_delete; DELETE FROM execution_ledger');
  assert.equal(reader(g).inspect('run').disposition, 'RECOVERY_FAILED');
});
for (const target of ['journal','result','evidence','owner','state','finalized'] as const) test(`${target} corruption fails closed without repair`, async t => {
  const f = executionFixture(t), task = f.register();
  if (['result','evidence','finalized'].includes(target)) await f.coordinator.dispatch('run', task);
  if (target === 'finalized') f.coordinator.finalizeResult('run', task);
  const raw = f.raw(); raw.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
  if (target === 'journal') raw.exec("DROP TRIGGER journal_no_update; UPDATE journal_events SET payload_digest='broken' WHERE sequence=1");
  if (target === 'result') raw.exec("DROP TRIGGER execution_results_no_update; UPDATE execution_results SET result_digest='broken'");
  if (target === 'evidence') raw.exec("DROP TRIGGER runner_evidence_no_update; UPDATE runner_evidence SET content_digest='broken'");
  if (target === 'owner') raw.exec("DROP TRIGGER ledger_transition; UPDATE execution_ledger SET session_id='foreign'");
  if (target === 'state') raw.exec("DROP TRIGGER ledger_transition; DROP TRIGGER ledger_audit_update; UPDATE execution_ledger SET state='FUTURE'");
  if (target === 'finalized') raw.exec("DROP TRIGGER ledger_transition; DROP TRIGGER ledger_audit_update; UPDATE execution_ledger SET finalized_event_id='missing'");
  const before = contents(f), result = reader(f).inspect('run'); assert.equal(result.disposition, 'RECOVERY_FAILED'); assert.deepEqual(contents(f), before);
});
test('inspectAll isolates corrupt Workflow and same Action ID across Workflows', t => {
  const f = executionFixture(t); f.register(); f.store.createWorkflow(executionSeed('ALLOW', 'second'));
  const other = { ...record, workflowRunId: 'second' }, request = registration(f.store, other);
  f.coordinator.registerAction(other, request.expected, request.sessionEvent, request.taskEvent);
  f.raw().exec("DROP TRIGGER journal_no_update; UPDATE journal_events SET payload_digest='bad' WHERE workflow_run_id='run' AND sequence=1");
  const results = reader(f).inspectAll(); assert.deepEqual(results.map(r => r.disposition), ['RECOVERY_FAILED','READY_TO_RESUME']);
  assert.equal(results[1].journalCursor, 3); assert.equal(results[1].executionStates[0].actionId, 'action');
});
test('one SQLite read transaction prevents a concurrent reservation from mixing with the Journal snapshot', t => {
  const f = executionFixture(t), task = f.register(), second = f.open();
  const coordinator = new DurableExecutionCoordinator(second.store, f.registry, { clock });
  const original = DatabaseSync.prototype.prepare; let interleaved = false, reads = 0;
  const read = f.db.read.bind(f.db); f.db.read = fn => { reads++; return read(fn); };
  DatabaseSync.prototype.prepare = function(sql: string) {
    if (!interleaved && sql.startsWith('SELECT action_id FROM pending_actions')) { interleaved = true; coordinator.reserveDispatch('run', task); }
    return original.call(this, sql);
  };
  try { assert.equal(reader(f).inspect('run').executionStates[0].state, 'PREPARED'); }
  finally { DatabaseSync.prototype.prepare = original; }
  assert.equal(interleaved, true); assert.equal(reads, 1); assert.equal(reader(f).inspect('run').executionStates[0].state, 'DISPATCH_RESERVED');
});
test('database and schema failures propagate fixed errors instead of per-Workflow successes', t => {
  const f = executionFixture(t), r = reader(f); f.raw().exec('DROP TABLE runtime_audit_events');
  assert.throws(() => r.inspectAll(), { code: 'DATABASE_ERROR' });
  const g = executionFixture(t); g.raw().exec("UPDATE schema_migrations SET migration_id='bad' WHERE schema_version=3");
  assert.throws(() => reader(g).inspectAll(), { code: 'SCHEMA_UNSUPPORTED' });
  g.db.close(); assert.throws(() => reader(g).inspect('run'), { code: 'INVALID_TRANSACTION' });
});
test('a missing Workflow reports a fixed diagnostic without leaking the supplied path', t => {
  const f = executionFixture(t); const r = reader(f).inspect('/private/missing'); assert.deepEqual(r.reasonCodes.slice(0, 1), ['WORKFLOW_NOT_FOUND']);
});

for (const firstCorrect of [false,true]) test(`security Review retains first-resume semantics (${firstCorrect ? 'correct' : 'wrong'} first authorization)`, async t => {
  const f = executionFixture(t); let reviewRef = '';
  f.executor.execute = async (_action, context) => {
    reviewRef = `map.runner.security-review.v1:run:${context.taskId}:sha256%3A${'a'.repeat(64)}`;
    return { status: 'failed', summary: 'safe', safetyHold: { kind: 'untrusted-content', effectState: 'applied',
      reasonCode: 'CONTENT_REVIEW_REQUIRED', reviewRef, safeSummary: 'Untrusted content requires user review.' } };
  };
  await f.runner.runOneRound('run'); assert.equal(reader(f).inspect('run').disposition, 'REVIEW_REQUIRED');
  f.add('WorkflowResumed', { authorization: { type: 'user', reference: firstCorrect ? reviewRef : 'wrong' } });
  if (!firstCorrect) { f.add('WorkflowSuspended', {}); f.add('WorkflowResumed', { authorization: { type: 'user', reference: reviewRef } }); }
  const before = contents(f), calls = { ...f.calls }, result = reader(f).inspect('run');
  assert.equal(result.disposition, firstCorrect ? 'READY_TO_RESUME' : 'REVIEW_REQUIRED', JSON.stringify(result)); assert.deepEqual(contents(f), before); assert.deepEqual(f.calls, calls);
  assert.deepEqual(result.authorizationRequirements.find(requirement => requirement.kind === 'SECURITY_REVIEW'),
    { kind: 'SECURITY_REVIEW', reference: reviewRef, effectState: 'applied', satisfied: firstCorrect });
});
test('Action approval diagnostics expose the existing bound approval reference without authorizing execution', async t => {
  const f = executionFixture(t, 'NEEDS_USER'); await f.runner.runOneRound('run');
  const r = reader(f), result = r.inspect('run'), approval = result.authorizationRequirements.find(requirement => requirement.kind === 'ACTION_APPROVAL');
  assert.ok(approval?.reference?.startsWith('map.runner.approval.v1:')); assert.equal(approval.satisfied, false); assert.ok(result.stopJournalEventId);
  f.add('WorkflowResumed', { authorization: { type: 'user', reference: approval.reference } });
  const resumed = r.inspect('run'); assert.equal(resumed.authorizationRequirements.find(requirement => requirement.kind === 'ACTION_APPROVAL')!.satisfied, true);
  assert.equal(resumed.executable, false);
});
test('a mismatched Security Review reason cannot disguise a persisted unknown execution as a resumable candidate', async t => {
  const f = executionFixture(t), task = f.register(); f.executor.execute = async () => ({ status: 'uncertain', summary: 'unknown' });
  await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task); f.coordinator.completeUncertainBlock('run');
  f.add('WorkflowResumed', { authorization: { type: 'user', reference: 'manual' } });
  f.db.write(tx => tx.run("UPDATE execution_ledger SET review_reason='SECURITY_REVIEW_REQUIRED' WHERE action_id='action'"));
  const before = contents(f); assert.equal(reader(f).inspect('run').disposition, 'RECOVERY_FAILED'); assert.deepEqual(contents(f), before);
});
test('all Actions contribute to a Workflow classification, including historical FINALIZED work', async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task);
  f.store.append(createRunnerEvent(f.snapshot(), 'SessionResolved', { outcome: 'SUCCEEDED' }, clock, { nextId: () => 'first-resolved' }, { sessionId: 'session' }));
  const second = { ...record, sessionId: 'session2', taskId: 'task2', action: { ...record.action, actionId: 'action2' } };
  const request = registration(f.store, second, 'round2'); f.coordinator.registerAction(second, request.expected, request.sessionEvent, request.taskEvent);
  f.coordinator.reserveDispatch('run', f.snapshot().tasks.task2);
  const result = reader(f).inspect('run'); assert.equal(result.disposition, 'REVIEW_REQUIRED');
  assert.deepEqual(result.executionStates.map(e => e.state), ['FINALIZED','DISPATCH_RESERVED']);
});
for (const dispatched of [false,true]) test(`cancellation after ${dispatched ? 'recording a Result' : 'reserving dispatch'} respects both Workflow status and uncertainty`, async t => {
  const f = executionFixture(t), task = f.register();
  if (dispatched) await f.coordinator.dispatch('run', task); else f.coordinator.reserveDispatch('run', task);
  f.add('WorkflowCancelled', {}); const result = reader(f).inspect('run');
  assert.equal(result.disposition, dispatched ? 'INACTIVE' : 'REVIEW_REQUIRED');
});
