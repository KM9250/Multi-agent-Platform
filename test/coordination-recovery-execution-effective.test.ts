import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCallLedger, RecoveryReader } from '../services/coordination/durable/index.ts';
import { digest, canonicalJson } from '../services/coordination/durable/integrity.ts';
import { recoveryExecutionFixture as fixture, corruptTable } from './recovery-execution-fixture.ts';

test('effective reservation cancels exactly one original reservation and never changes committed usage', t => {
  const f = fixture(t); f.reserve('first'); f.reserve('second'); f.reacquire();
  const ledger = new ModelCallLedger(f.store), historical = ledger.inspect('run');
  const before = ledger.getBudgetPosition('run');
  assert.deepEqual(before.outstanding, {llmCalls:2,inputTokens:10,outputTokens:14,costMicros:22});
  const p = f.plan('CANCEL_UNSENT_MODEL','first'); f.authorize(p); f.execute(p);
  const after = ledger.getBudgetPosition('run');
  assert.deepEqual(after.outstanding, {llmCalls:1,inputTokens:5,outputTokens:7,costMicros:11});
  assert.deepEqual(after.committed,before.committed); assert.deepEqual(ledger.inspect('run'),historical);
  f.execute(p); assert.deepEqual(ledger.getBudgetPosition('run'),after);
  const inspection = new RecoveryReader(f.db).inspect('run');
  assert.equal(inspection.modelCalls?.reserved,2); assert.equal(inspection.modelCalls?.effectiveReserved,1);
  assert.equal(inspection.modelCalls?.recoveryResolutions.length,1);
  assert.equal(inspection.disposition,'REVIEW_REQUIRED'); assert.equal(inspection.executionAllowed,false);
});

test('reader and timeline expose preserved history, effective resolution, separate 4B IDs and held continuation review', t => {
  const f = fixture(t,{},undefined,{maxWallTimeMs:Number.MAX_SAFE_INTEGER}); f.reserve(); f.reacquire(); const p=f.plan(),g=f.authorize(p),receipt=f.execute(p);
  const reader = new RecoveryReader(f.db), inspection = reader.inspect('run');
  assert.equal(inspection.modelCalls?.reserved,1); assert.equal(inspection.modelCalls?.effectiveReserved,0);
  assert.equal(inspection.modelCalls?.recoveryResolutions[0].historicalState,'RESERVED');
  assert.equal(inspection.modelCalls?.recoveryResolutions[0].resolutionKind,'CANCELLED_UNSENT');
  assert.deepEqual(inspection.modelCalls?.outstandingReservation,{llmCalls:0,inputTokens:0,outputTokens:0,costMicros:0});
  assert.equal(inspection.safeRecovery?.holdRevision,2); assert.equal(inspection.safeRecovery?.executionAllowed,false);
  assert.equal(inspection.disposition,'READY_FOR_CONTINUATION_REVIEW'); assert.equal(inspection.executable,false);
  const timeline=reader.getWorkflowTimeline('run').entries;
  const committed=timeline.find(e=>e.eventKind==='RECOVERY_OPERATION_COMMITTED')!;
  assert.equal(committed.executionPlanId,p.executionPlanId); assert.equal(committed.recoveryOperationId,receipt.operationId);
  assert.equal(committed.recoveryPlanId,undefined); assert.equal(committed.authorizationId,undefined);
  const consumed=timeline.find(e=>e.eventKind==='RECOVERY_GRANT_CONSUMED')!;
  assert.equal(consumed.executionAuthorizationId,g.authorizationId); assert.equal(consumed.recoveryOperationId,receipt.operationId);
  assert.throws(()=>f.store.assertRecoveryExecution('run'),{code:'RECOVERY_HELD'});
});

test('settled response discard leaves recorded usage charged and distinguishes historical application from effective resolution', t => {
  const f=fixture(t),x=f.settled(); f.held();
  const ledger=new ModelCallLedger(f.store),before=ledger.getBudgetPosition('run'),rows=ledger.inspect('run');
  const usage=f.store.getSnapshot('run').events.filter(e=>e.type==='UsageRecorded');
  const p=f.plan('DISCARD_SETTLED_RESPONSE'); f.authorize(p); f.execute(p);
  assert.deepEqual(ledger.getBudgetPosition('run'),before); assert.deepEqual(ledger.inspect('run'),rows);
  assert.deepEqual(f.store.getSnapshot('run').events.filter(e=>e.type==='UsageRecorded'),usage);
  const summary=new RecoveryReader(f.db).inspect('run').modelCalls!;
  assert.equal(summary.pendingApplication,1); assert.equal(summary.effectivePendingApplication,0);
  assert.equal(summary.recoveryResolutions[0].historicalApplication,'PENDING_APPLICATION');
  assert.equal(summary.recoveryResolutions[0].effectiveApplication,'RESOLVED');
  assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run("UPDATE model_call_ledger SET application_status='DISCARDED',reason_code='STALE_RESPONSE' WHERE model_call_id=?",x.modelCallId)));
  assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run('UPDATE model_call_attempts SET completeness=completeness WHERE attempt_id=?',x.attemptId)));
  assert.deepEqual(ledger.inspect('run'),rows);
});

for (const corruption of ['source','reservation','audit','receipt'] as const) test(`unverified ${corruption} cannot release effective budget`, t => {
  const f=fixture(t); f.reserve(); f.reacquire(); const p=f.plan(); f.authorize(p); f.execute(p);
  if(corruption==='source') {
    const resolution=f.raw.prepare('SELECT * FROM recovery_model_resolutions').get()!;
    const source=JSON.parse(String(resolution.source_json)); source.attempt.dispatch_intent_at=123;
    corruptTable(f.raw,'recovery_model_resolutions','UPDATE recovery_model_resolutions SET source_json=?,source_digest=?',canonicalJson(source),digest(source));
  } else if(corruption==='reservation') corruptTable(f.raw,'recovery_model_resolutions',"UPDATE recovery_model_resolutions SET reservation_json='{}'");
  else if(corruption==='audit') corruptTable(f.raw,'runtime_audit_events',"DELETE FROM runtime_audit_events WHERE event_kind='RECOVERY_GRANT_CONSUMED'");
  else {
    const operation=f.raw.prepare('SELECT * FROM recovery_execution_operations').get()!;
    const receipt=JSON.parse(String(operation.receipt_json)); receipt.targetId='another-model';
    corruptTable(f.raw,'recovery_execution_operations','UPDATE recovery_execution_operations SET receipt_json=?,receipt_digest=?',canonicalJson(receipt),digest(receipt));
  }
  assert.throws(()=>new ModelCallLedger(f.store).getBudgetPosition('run'));
  assert.equal(new RecoveryReader(f.db).inspect('run').disposition,'RECOVERY_FAILED');
});
