import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationFixture } from './continuation-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import type { ContinuationPlanInput } from '../services/coordination/durable/continuationTypes.ts';
function releaseInput():ContinuationPlanInput {return {operation:'RELEASE_RECOVERY_HOLD',origin:'RECOVERY',workflowRunId:'run',requestId:'release',
 resume:{authorization:{type:'user'},reason:'Explicit recovery release'},limits:{maxRounds:0,maxModelCalls:0,maxActionDispatches:0,maxReadCalls:0,maxInputTokens:0,maxOutputTokens:0,maxCostMicros:0}};}
test('H01/H04/H05/H06: release is an atomic DB-only operation; subsequent generation atomically reholds',async t=>{
 const f=continuationFixture(t);
 f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'suspend'}));assert.throws(()=>f.store.assertRecoveryExecution('run'));
 const original=f.raw.prepare('SELECT * FROM recovery_holds').all(),p=f.api().createPlan(releaseInput(),f.credential);f.api().authorize(p,f.approver);
 const r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.control.holdState,'RELEASED');assert.deepEqual(f.counts,{draft:0,plan:0,verify:0,prepare:0,action:0});
 assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),original);f.store.assertRecoveryExecution('run');
 f.manager.renew(f.lease);assert.equal(f.api().inspect(p.planId,f.credential).control.holdEpoch,1);
 f.reacquire();const c=f.api().inspect(p.planId,f.credential).control;assert.equal(c.holdState,'HELD');assert.equal(c.holdEpoch,2);
 assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),original);
 assert.equal((await f.api().startAuthorized(p.planId,f.credential)).control.holdState,'HELD');
});
test('H03: completed planning review cannot be used to release or start the normal runner',async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 f.api().recordReview(r.artifact!,'ACCEPTED_FOR_SCOPE',f.credential);assert.throws(()=>f.store.assertRecoveryExecution('run'));
 assert.throws(()=>f.api().createPlan(releaseInput(),f.credential));assert.equal(f.counts.action,0);
});
test('H01/H03: a new safety stop after release reholds with a new epoch and preserves the original Hold',async t=>{
 const f=continuationFixture(t);f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'first-stop'}));assert.throws(()=>f.store.assertRecoveryExecution('run'));
 const original=f.raw.prepare('SELECT * FROM recovery_holds').all(),p=f.api().createPlan(releaseInput(),f.credential);f.api().authorize(p,f.approver);await f.api().startAuthorized(p.planId,f.credential);
 f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'second-stop'}));assert.throws(()=>f.store.assertRecoveryExecution('run'));
 const control=f.api().inspect(p.planId,f.credential).control;assert.equal(control.holdState,'HELD');assert.equal(control.holdEpoch,2);assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),original);
 assert.throws(()=>f.db.writeWithLease(f.lease,'run',tx=>tx.run("UPDATE recovery_workflow_control SET hold_state='RELEASED',control_revision=control_revision+1 WHERE workflow_run_id='run'")));
});
