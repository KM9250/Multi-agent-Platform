import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../services/coordination/durable/integrity.ts';
import { prepared } from './durable-execution-fixture.ts';
import { continuationFixture } from './continuation-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import type { ContinuationPlanInput } from '../services/coordination/durable/continuationTypes.ts';
import { hold,executeInput } from './continuation-runner-fixture.ts';
import { DATABASE_NOW_SQL } from '../services/coordination/durable/leaseSchema.ts';
test('I04/I05/I06/I14/R02/H02: a real Runner round uses atomic debits and leaves Hold in place',async t=>{
 const f=continuationFixture(t);hold(f);const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);
 const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.status,'COMPLETED',JSON.stringify(r));assert.deepEqual(r.counts,{rounds:1,modelCalls:2,actionDispatches:1,readCalls:0});
 assert.deepEqual(f.counts,{draft:0,plan:1,verify:1,prepare:1,action:1});assert.equal(r.control.holdState,'HELD');
 assert.equal(f.store.getSnapshot('run').run.usage.rounds,1);assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_invocation_debits').get()!.n,4);
 assert.deepEqual(await f.api().startAuthorized(p.planId,f.credential),r);assert.equal(f.counts.action,1);
});
test('A01/A02/A04: contract digest, self approval, missing approval and revoke remain separate from start',async t=>{
 const f=continuationFixture(t);hold(f);const p=f.api().createPlan(executeInput(f),f.credential);
 assert.throws(()=>f.api().authorize(p,f.credential));await assert.rejects(f.api().startAuthorized(p.planId,f.credential));
 assert.throws(()=>f.api().authorize({...p,planDigest:'c'.repeat(64)},f.approver));
 const grant=f.api().authorize(p,f.approver);f.api().revoke(grant,f.approver);await assert.rejects(f.api().startAuthorized(p.planId,f.credential));
 assert.equal(f.counts.plan,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,0);
});
test('R01: VERIFY_FINALIZED_RESULT evaluates exactly the specified finalized task with zero PLAN/Action',async t=>{
 const {DurableExecutionCoordinator}=await import('../services/coordination/durable/executionCoordinator.ts');
 const {registration,record}=await import('./durable-execution-fixture.ts');
 const f=continuationFixture(t),coordinator=new DurableExecutionCoordinator(f.store,{get:id=>f.options.controlledExecutors.get(id)?.executor});
 const reg=registration(f.store);coordinator.registerAction(record,reg.expected,reg.sessionEvent,reg.taskEvent);
 const task=f.store.getSnapshot('run').tasks.task;await coordinator.dispatch('run',task);coordinator.finalizeResult('run',task);const before=f.counts.action;
 hold(f);const x=executeInput(f);x.start='VERIFY_FINALIZED_RESULT';x.taskId='task';x.limits.maxActionDispatches=0;x.limits.maxModelCalls=1;
 const p=f.api().createPlan(x,f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.status,'COMPLETED',JSON.stringify(r));assert.equal(f.counts.verify,1);assert.equal(f.counts.plan,0);assert.equal(f.counts.action,before);assert.equal(r.counts.actionDispatches,0);
 assert.equal(f.store.getSnapshot('run').sessions.session.state,'RESOLVED');
});
test('T01: synchronous action after its persisted execution deadline records uncertainty without a replacement Action',async t=>{
 const f=continuationFixture(t,{actionTimeoutMs:1000});let returnedLate=false;
 f.actionHook(async()=>{
  const step=f.raw.prepare("SELECT execution_deadline,collection_deadline FROM recovery_invocation_steps WHERE kind='ACTION'").get()!;
  const now=Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
  assert.ok(now<Number(step.execution_deadline),'Executor must enter before its persisted execution deadline');
  const remaining=Number(step.execution_deadline)-now+25;assert.ok(remaining>0&&remaining<=1025);
  const end=performance.now()+remaining;while(performance.now()<end){}
  const late=Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
  assert.ok(late>Number(step.execution_deadline)&&late<Number(step.collection_deadline));returnedLate=true;
  return {status:'succeeded',summary:'late'};
 });
 hold(f);const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(returnedLate,true);assert.equal(f.counts.action,1);assert.equal(f.counts.verify,0);assert.equal(r.invocation?.status,'REVIEW_REQUIRED');
 await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.action,1);
});
test('I11/T02: Executor receives only its evidence sink, never the parent Invocation capability',async t=>{
 const {SqliteRunnerEvidenceStore}=await import('../services/coordination/durable/evidenceStore.ts');
 const f=continuationFixture(t),evidence=new SqliteRunnerEvidenceStore(f.db,f.lease);
 f.actionHook(async context=>{
  assert.equal(f.db.boundedInvocationActive,false);assert.throws(()=>f.store.assertRecoveryExecution('run'));
  const owner={workflowRunId:'run',sessionId:context.sessionId,taskId:context.taskId,actionId:'action-1'};
  const ref=await evidence.withOwner(owner,()=>evidence.put({kind:'synthetic',content:'Bounded evidence',createdAt:Date.now()}));
  await assert.rejects(evidence.withOwner({...owner,taskId:'foreign'},()=>evidence.put({kind:'synthetic',content:'no',createdAt:Date.now()})));
  return {status:'succeeded',summary:'done',evidenceRefs:[ref]};
 });
 hold(f);const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.status,'COMPLETED',JSON.stringify(r));assert.equal(f.counts.action,1);assert.equal(f.counts.verify,1);
});
