import test from 'node:test';
import assert from 'node:assert/strict';
import { corruptTable, recoveryExecutionFixture } from './recovery-execution-fixture.ts';

for (const auditKind of ['JOURNAL_APPENDED', 'EXECUTION_CHANGED']) {
  test(`4B receipt rejects a missing ${auditKind} business audit after COMMIT`, async t => {
    const f = recoveryExecutionFixture(t);
    await f.action(); f.held();
    const plan = f.plan('REFLECT_RECORDED_RESULT', 'action'); f.authorize(plan);
    const receipt = f.execute(plan);
    assert.equal(f.calls.execute, 1);
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM runtime_audit_events WHERE event_kind=? AND journal_event_id=?')
      .get(auditKind, receipt.journalEventIds[0])!.n, 1);
    corruptTable(f.raw, 'runtime_audit_events', 'DELETE FROM runtime_audit_events WHERE event_kind=? AND journal_event_id=?',
      auditKind, receipt.journalEventIds[0]);
    assert.throws(() => f.rebind().executor.inspectReceipt(plan.executionPlanId, f.credential), { code: 'INTEGRITY_ERROR' });
    assert.throws(() => f.execute(plan), { code: 'INTEGRITY_ERROR' });
    assert.equal(f.calls.execute, 1);
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM recovery_execution_operations').get()!.n, 1);
  });
}

test('4B receipt rejects a consumed-grant audit with a different runtime generation', async t => {
  const f = recoveryExecutionFixture(t);
  await f.action(); f.held();
  const plan = f.plan('REFLECT_RECORDED_RESULT', 'action'); f.authorize(plan);
  const receipt = f.execute(plan);
  corruptTable(f.raw, 'runtime_audit_events',
    "UPDATE runtime_audit_events SET runtime_generation=runtime_generation+1 WHERE event_kind='RECOVERY_GRANT_CONSUMED' AND recovery_operation_id=?",
    receipt.operationId);
  assert.throws(() => f.rebind().executor.inspectReceipt(plan.executionPlanId, f.credential), { code: 'INTEGRITY_ERROR' });
  assert.equal(f.calls.execute, 1);
});

test('4B receipt revalidates the saved result evidence after COMMIT', async t => {
  const f = recoveryExecutionFixture(t);
  await f.action(); f.held();
  const plan = f.plan('REFLECT_RECORDED_RESULT', 'action'); f.authorize(plan); f.execute(plan);
  corruptTable(f.raw, 'runner_evidence', "UPDATE runner_evidence SET content_digest=? WHERE action_id='action'", '0'.repeat(64));
  assert.throws(() => f.rebind().executor.inspectReceipt(plan.executionPlanId, f.credential), { code: 'INTEGRITY_ERROR' });
  assert.equal(f.calls.execute, 1);
});
