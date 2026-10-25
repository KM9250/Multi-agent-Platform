import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRuntimeAuditInTransaction } from '../services/coordination/durable/recoveryAudit.ts';
import { executionFixture, registration, record } from './durable-execution-fixture.ts';
import { reader, contents } from './recovery-fixture.ts';

test('Ledger transitions and Journal INSERTs share one ordered audit sequence with actual Agent subject and verified Runtime', async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task);
  const rows = f.db.read(tx => tx.all('SELECT * FROM runtime_audit_events ORDER BY audit_sequence'));
  const ledger = rows.filter(r => r.event_kind === 'EXECUTION_CHANGED');
  assert.deepEqual(ledger.map(r => r.next_state), ['PREPARED','DISPATCH_RESERVED','RESULT_RECORDED','FINALIZED']);
  assert.deepEqual(ledger.map(r => r.previous_state), [null,'PREPARED','DISPATCH_RESERVED','RESULT_RECORDED']);
  assert.ok(ledger.every(r => r.subject_agent_id === 'supervisor' && r.actor_agent_id === null && r.runtime_instance_id === f.lease.runtimeInstanceId && r.runtime_generation === f.lease.generation));
  assert.ok(ledger.slice(1).every(r => r.attempt_id === ledger[1].attempt_id));
  assert.equal(ledger.at(-1)!.journal_event_id, f.snapshot().events.at(-1)!.eventId);
  for (const row of rows.filter(r => r.event_kind === 'JOURNAL_APPENDED')) {
    const event = f.snapshot().events[Number(row.journal_sequence) - 1]; assert.equal(row.journal_event_id, event.eventId);
  }
  const before = contents(f); f.coordinator.finalizeResult('run', task); reader(f).inspect('run');
  assert.deepEqual(contents(f), before);
});
test('REVIEW_REQUIRED changes record review reasons; same-state no-op UPDATE adds no audit', t => {
  const f = executionFixture(t), task = f.register(); f.coordinator.reserveDispatch('run', task); f.coordinator.requireReview('run', task, 'EXECUTION_UNCERTAIN');
  const count = () => f.db.read(tx => tx.get('SELECT count(*) AS n FROM runtime_audit_events')!.n);
  const initial = count(); f.store.writeWorkflow('run', tx => tx.run("UPDATE execution_ledger SET updated_at=20 WHERE action_id='action'")); assert.equal(count(), initial);
  f.store.writeWorkflow('run', tx => tx.run("UPDATE execution_ledger SET review_reason='RESULT_INTEGRITY_UNAVAILABLE' WHERE action_id='action'")); assert.equal(count(), Number(initial) + 1);
  assert.equal(reader(f).inspect('run').executionStates[0].reviewReason, 'RESULT_INTEGRITY_UNAVAILABLE');
});
test('direct UPDATE, DELETE, duplicate IDs and invalid references/transitions are rejected', t => {
  const f = executionFixture(t); f.register(); const raw = f.raw();
  for (const sql of ["UPDATE runtime_audit_events SET reason_code='MODIFIED'", 'DELETE FROM runtime_audit_events',
    'DELETE FROM workflow_seeds',
    'INSERT INTO runtime_audit_events SELECT * FROM runtime_audit_events LIMIT 1']) assert.throws(() => raw.exec(sql));
  const saved = raw.prepare("SELECT * FROM runtime_audit_events WHERE event_kind='EXECUTION_CHANGED' LIMIT 1").get()!;
  const columns = Object.keys(saved).filter(k => k !== 'audit_sequence');
  for (const mutation of [{ workflow_run_id: 'foreign' }, { journal_event_id: 'missing', journal_sequence: 1 }, { previous_state: 'FINALIZED' }, { schema_version: 99 }]) {
    const row = { ...saved, audit_event_id: `invalid-${Object.keys(mutation)[0]}`, ...mutation };
    assert.throws(() => raw.prepare(`INSERT INTO runtime_audit_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(k => row[k])));
  }
});
test('audit insertion failure rolls Ledger and Journal changes back together', t => {
  const f = executionFixture(t), task = f.register(), before = contents(f);
  f.raw().exec("CREATE TRIGGER reject_audit BEFORE INSERT ON runtime_audit_events BEGIN SELECT RAISE(ABORT,'sensitive internal error'); END");
  assert.throws(() => f.coordinator.reserveDispatch('run', task), { code: 'DATABASE_ERROR' });
  assert.deepEqual(contents(f), before);
  assert.throws(() => f.add('UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }), { code: 'DATABASE_ERROR' });
  assert.deepEqual(contents(f), before);
});
test('registration and Event retransmission preserve idempotency without duplicate audits', t => {
  const f = executionFixture(t), request = registration(f.store);
  f.coordinator.registerAction(record, request.expected, request.sessionEvent, request.taskEvent); const before = contents(f);
  f.coordinator.registerAction(record, request.expected, request.sessionEvent, request.taskEvent);
  f.store.append({ ...request.taskEvent, sequence: 999, timestamp: 999 }); assert.deepEqual(contents(f), before);
});
for (const mutation of ["schema_version=99", "previous_state='FINALIZED'", "audit_sequence=0", "journal_sequence=999"])
  test(`reader detects tampered audit ${mutation}`, t => {
    const f = executionFixture(t); f.register(); const raw = f.raw(); raw.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; DROP TRIGGER audit_no_update');
    raw.exec(`UPDATE runtime_audit_events SET ${mutation} WHERE event_kind='EXECUTION_CHANGED'`);
    assert.equal(reader(f).inspect('run').disposition, 'RECOVERY_FAILED');
  });
test('internal Audit Writer validates a strict metadata-only contract inside the caller transaction', t => {
  const f = executionFixture(t), input = { workflowRunId: 'run', entityKind: 'WORKFLOW' as const, entityId: 'run', eventKind: 'RUNTIME_OBSERVATION', reasonCode: 'OBSERVED', occurredAt: 10 };
  f.store.writeWorkflow('run', tx => appendRuntimeAuditInTransaction(f.db, tx, input));
  const entries = reader(f).getWorkflowTimeline('run').entries; assert.equal(entries.at(-1)!.source, 'RUNTIME_AUDIT');
  assert.equal(entries.at(-1)!.actorAgentId, undefined); assert.equal(entries.at(-1)!.runtimeInstanceId, f.lease.runtimeInstanceId);
  assert.throws(() => f.db.read(tx => appendRuntimeAuditInTransaction(f.db, tx, input)), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => f.store.writeWorkflow('run', tx => appendRuntimeAuditInTransaction(f.db, tx, { ...input, payload: 'secret' } as any)));
  assert.throws(() => f.store.writeWorkflow('run', tx => appendRuntimeAuditInTransaction(f.db, tx, { ...input, eventKind: 'EXECUTION_CHANGED' })));
  const before = contents(f); assert.throws(() => f.store.writeWorkflow('run', tx => { appendRuntimeAuditInTransaction(f.db, tx, input); throw Error('rollback'); }));
  assert.deepEqual(contents(f), before);
});
