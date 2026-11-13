import assert from 'node:assert/strict';
import test from 'node:test';
import { reconciliationFixture as fixture, reconciliationContents, completeClaim } from './reconciliation-fixture.ts';
import { effectiveWorkflowUsage, reconciliationStateDigest } from '../services/coordination/durable/reconciliationAccounting.ts';
import { effectiveModelRows } from '../services/coordination/durable/safeRecoveryModelState.ts';
import { effectiveActionRows } from '../services/coordination/durable/reconciliationEffectiveState.ts';
import { ReconciliationReader } from '../services/coordination/durable/reconciliationReader.ts';
import { RecoveryReader } from '../services/coordination/durable/recoveryReader.ts';
import { assertControlledBudget, controlledState } from '../services/coordination/durable/controlledRecoveryPlanner.ts';
import { record, registration, clock } from './durable-execution-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { canonicalJson, digest } from '../services/coordination/durable/integrity.ts';

test('IN-02 US-18: current accounting is shared by budget, recovery reader and case reader while snapshot stays historical',async t=>{
  const f=fixture(t),m=f.model(),before=f.store.getSnapshot('run'),v=await f.verified(m.target),p=f.plan(m.target,v.verification.verificationId);
  const oldBinding=f.db.read(tx=>controlledState(tx,'run'));
  f.authorize(p);f.execute(p);
  assert.deepEqual(f.store.getSnapshot('run'),before);
  const budget=m.ledger.getBudgetPosition('run'),effective=f.db.read(tx=>effectiveWorkflowUsage(tx,'run'));
  assert.equal(effective.llmCalls,1);assert.equal(effective.inputTokens,budget.committed.inputTokens);assert.equal(effective.outputTokens,budget.committed.outputTokens);
  assert.equal(effective.estimatedCost,budget.committed.costMicros/1_000_000);
  const saved=reconciliationContents(f.raw),calls={...f.counts};
  const recovery=new RecoveryReader(f.db).inspect('run'),inspection=new ReconciliationReader(f.db).inspect(m.target,f.credential);
  assert.deepEqual(recovery.effectiveWorkflowUsage,effective);assert.deepEqual(inspection.effectiveWorkflowUsage,effective);
  assert.equal(recovery.modelCalls!.effectiveUnknownUsage,0);assert.equal(inspection.executionAllowed,false);
  assert.equal(inspection.models[0].accountingState,'RECONCILED_SETTLED');assert.equal(inspection.models[0].responseState,'NOT_APPLICABLE_VERIFIED');
  assert.deepEqual(reconciliationContents(f.raw),saved);assert.deepEqual(f.counts,calls);
  assert.notDeepEqual(f.db.read(tx=>controlledState(tx,'run')),oldBinding);
});

test('IN-01 US-17: response loss remains an independent obligation after reservation and usage are resolved',async t=>{
  const f=fixture(t),m=f.model(),v=await f.verified(m.target,{...completeClaim(),responseState:'UNAVAILABLE_REVIEW_REQUIRED'}),p=f.plan(m.target,v.verification.verificationId);
  f.authorize(p);f.execute(p);
  const state=f.db.read(tx=>effectiveModelRows(tx,'run'))[0];
  assert.equal(state.accountingState,'RECONCILED_SETTLED');assert.equal(state.outstandingReservation,false);assert.equal(state.pendingApplication,true);assert.equal(state.unresolved,true);
  const inspection=new ReconciliationReader(f.db).inspect(m.target,f.credential);
  assert.ok(inspection.obligations.some(item=>item.reason==='RESPONSE_UNAVAILABLE_REVIEW_REQUIRED'));
  assert.equal(inspection.caseReconciled,false);assert.equal(inspection.recoveryReviewEligible,false);
});

test('IN-02 US-05: the controlled budget guard sees reconciled overspend even with zero historical journal usage',async t=>{
  const f=fixture(t),m=f.model(),v=await f.verified(m.target,{...completeClaim(),usage:{llmCalls:1,inputTokens:20000,outputTokens:1,estimatedCost:2}}),p=f.plan(m.target,v.verification.verificationId);
  f.authorize(p);f.execute(p);
  assert.equal(f.store.getSnapshot('run').run.usage.estimatedCost,0);
  assert.throws(()=>f.db.read(tx=>assertControlledBudget(tx,'run')));
  const inspection=new RecoveryReader(f.db).inspect('run');assert.equal(inspection.budgetStatus,'RECORDED_LIMIT_EXHAUSTED');
  assert.equal(inspection.modelCalls!.effectiveBudgetViolations,1);
});

test('IN-09 AC-04: a separately approved Task application preserves historical raw state and old outcome receipt',async t=>{
  const f=fixture(t),a=f.action(),v=await f.verified(a.target),p=f.plan(a.target,v.verification.verificationId);
  f.authorize(p);const outcome=f.execute(p),raw=f.raw.prepare('SELECT * FROM execution_ledger').all();
  const apply=f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT');f.authorize(apply);f.execute(apply);
  assert.deepEqual(f.raw.prepare('SELECT * FROM execution_ledger').all(),raw);
  assert.deepEqual(f.api().executor.inspectReceipt(p.planId,f.credential),outcome);
  const state=f.db.read(tx=>effectiveActionRows(tx,'run'))[0];assert.equal(state.applicationState,'APPLIED');assert.equal(state.unresolved,false);
  const inspection=new RecoveryReader(f.db).inspect('run');assert.notEqual(inspection.disposition,'RECOVERY_FAILED');
  assert.equal(inspection.executionStates[0].state,'DISPATCH_RESERVED');assert.equal(inspection.executionStates[0].reconciledApplication,'APPLIED');
  assert.equal(a.coordinator.getResult('run',a.task)?.status,'succeeded');assert.equal(f.counts.action,0);
});

test('AU-10 IN-12: case inspection requires current VIEW_CASE for every disclosed workflow target',async t=>{
  const f=fixture(t),first=f.model('first'),v=await f.verified(first.target),p=f.plan(first.target,v.verification.verificationId);f.authorize(p);f.execute(p);
  // A second call has its own target ACL even in the same workflow.
  f.model('second');f.policy.canAccess=(_actor,target,permission)=>permission!=='VIEW_CASE'||target.targetId!=='second';
  const before=reconciliationContents(f.raw),counts={...f.counts};
  assert.throws(()=>new ReconciliationReader(f.db).inspect(first.target,f.credential));
  assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,counts);
});

test('AU-08: candidate submission alone leaves current reconciliation state binding unchanged',async t=>{
  const f=fixture(t),m=f.model(),before=f.db.read(tx=>reconciliationStateDigest(tx,'run'));
  f.submit(m.target);assert.equal(f.db.read(tx=>reconciliationStateDigest(tx,'run')),before);
});

test('AC-09: a new Action ID cannot replay the same exact reconciled effect; a different payload can register',async t=>{
  const f=fixture(t),a=f.action(),v=await f.verified(a.target),p=f.plan(a.target,v.verification.verificationId);f.authorize(p);f.execute(p);
  const apply=f.plan(a.target,v.verification.verificationId,'APPLY_RECONCILED_ACTION_RESULT');f.authorize(apply);f.execute(apply);
  f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'SessionResolved',{outcome:'SUCCEEDED'},clock,{nextId:()=> 'synthetic-resolve-original'},{sessionId:'session'}));
  const replay={...record,sessionId:'new-session',taskId:'new-task',action:{...record.action,actionId:'new-action',retrySafety:'safe' as const}};
  const request=registration(f.store,replay,'new-round'),before=reconciliationContents(f.raw),calls={...f.counts};
  assert.throws(()=>a.coordinator.registerAction(replay,request.expected,request.sessionEvent,request.taskEvent));
  assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,calls);
  assert.equal(f.db.read(tx=>tx.get('SELECT map_reconciliation_duplicate_action(?,?) duplicate','run',canonicalJson(replay.action))!.duplicate),1);
  // The same exact row cannot bypass the coordinator through a lease-fenced
  // SQL participant. Catching its refusal must still poison the transaction.
  assert.throws(()=>f.store.writeWorkflow('run',tx=>{
    try{tx.run('INSERT INTO pending_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)','run',replay.sessionId,replay.taskId,replay.action.actionId,replay.action.executorId,replay.action.operation,replay.action.actionClass,replay.action.fingerprint,replay.action.retrySafety,canonicalJson(replay.action),digest(replay.action),1,clock.now(),'map.runner.v1:new-round',digest([replay,request.expected.events.at(-1),request.expected.policy,request.sessionEvent,request.taskEvent]));}catch{}
  }));
  assert.deepEqual(reconciliationContents(f.raw),before);assert.deepEqual(f.counts,calls);
  const distinct={...replay,action:{...replay.action,payload:{query:'a distinct synthetic resource'}}},good=registration(f.store,distinct,'new-round');
  assert.equal(f.db.read(tx=>tx.get('SELECT map_reconciliation_duplicate_action(?,?) duplicate','run',canonicalJson(distinct.action))!.duplicate),0);
  a.coordinator.registerAction(distinct,good.expected,good.sessionEvent,good.taskEvent);
  assert.equal(f.store.getSnapshot('run').tasks['new-task'].status,'ASSIGNED');assert.equal(f.counts.action,0);
});
