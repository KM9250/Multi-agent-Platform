import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationFixture,content } from './continuation-fixture.ts';
import { hold,executeInput } from './continuation-runner-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { executionSeed,registration,record } from './durable-execution-fixture.ts';
import { DurableExecutionCoordinator } from '../services/coordination/durable/executionCoordinator.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { RecoveryContinuationReader } from '../services/coordination/durable/recoveryContinuationReader.ts';
import { runnerPendingApproval } from '../services/coordination/runner/policyGuard.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
test('A02: two verified approvers are required; a viewer cannot start an approved recovery plan',async t=>{
 const f=continuationFixture(t);f.policy.recoveryApprovals.minimumApprovers=2;hold(f);const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);
 await assert.rejects(f.api().startAuthorized(p.planId,f.credential));f.api().authorize(p,f.identity.credential('second',['RECOVERY_APPROVER']));
 await assert.rejects(f.api().startAuthorized(p.planId,f.identity.credential('viewer',['RECOVERY_VIEWER'])));assert.equal(f.counts.plan,0);assert.equal((await f.api().startAuthorized(p.planId,f.credential)).invocation?.status,'COMPLETED');
});
test('A04/I15: acknowledged start wins revocation race, STOP drains the existing step, and grants never return',async t=>{
 const f=continuationFixture(t);let entered!:()=>void,done!:()=>void;const ready=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>done=r);f.hook(async()=>{entered();await pending;return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});
 const p=f.api().createPlan(f.input(),f.credential),grant=String(f.raw.prepare('SELECT grant_id FROM recovery_continuation_grants').get()!.grant_id),run=f.api().startAuthorized(p.planId,f.credential);await ready;
 assert.throws(()=>f.api().revoke(grant,f.credential));f.api().requestStop(p.planId,f.credential);assert.equal(f.raw.prepare('SELECT status FROM recovery_invocations').get()!.status,'DRAINING');assert.equal(JSON.parse(String(f.raw.prepare("SELECT receipt_json FROM recovery_continuation_receipts WHERE kind='STOP'").get()!.receipt_json)).actor,'operator');assert.throws(()=>f.api().createPlan(f.input(),f.credential));done();const r=await run;
 assert.equal(r.invocation?.status,'STOPPED');assert.equal(f.raw.prepare('SELECT status FROM recovery_continuation_grants').get()!.status,'CONSUMED');
});
test('I16/R02/R03: NEEDS_USER requires the original concrete Action reference in the first authorized Resume',async t=>{
 const f=continuationFixture(t);f.admin.createWorkflow(executionSeed('NEEDS_USER','review',{maxWallTimeMs:Number.MAX_SAFE_INTEGER,maxLlmCalls:10,maxInputTokens:1000,maxOutputTokens:1000,maxEstimatedCost:1}));const lease=f.manager.acquire('review'),store=f.admin.withLease(lease),api=new RecoveryContinuationCoordinator(f.db,lease);
 const action={...record,workflowRunId:'review'},coordinator=new DurableExecutionCoordinator(store,{get:id=>f.options.controlledExecutors.get(id)?.executor}),r=registration(store,action);coordinator.registerAction(action,r.expected,r.sessionEvent,r.taskEvent);
 const ref=runnerPendingApproval('review',action.action).approvalRef;store.append(createRunnerEvent(store.getSnapshot('review'),'WorkflowBlocked',{reason:`RUNNER_NEEDS_USER:${ref}`},{now:Date.now},{nextId:()=> 'needs-user'}));assert.throws(()=>store.assertRecoveryExecution('review'));
 const input=executeInput(f);input.workflowRunId='review';input.start='RESUME_PREPARED';input.taskId='task';input.actionId='action';input.limits.maxModelCalls=1;input.resume={authorization:{type:'user',reference:'wrong'}};
 assert.throws(()=>api.createPlan(input,f.credential));input.resume={authorization:{type:'user',reference:ref}};const p=api.createPlan(input,f.credential);api.authorize(p,f.approver);const out=await api.startAuthorized(p.planId,f.credential);
 assert.equal(out.invocation?.status,'COMPLETED',JSON.stringify(out));assert.equal(f.counts.plan,0);assert.equal(f.counts.action,1);assert.equal(f.counts.verify,1);assert.equal(store.getSnapshot('review').events.filter(e=>e.type==='WorkflowResumed').length,1);
});
test('R04: a terminal Workflow cannot be revived by planning, continuation or release',t=>{
 const f=continuationFixture(t);f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowCancelled',{}, {now:Date.now},{nextId:()=> 'cancel'}));assert.throws(()=>f.store.assertRecoveryExecution('run'));
 for(const x of [f.input(),executeInput(f),{operation:'RELEASE_RECOVERY_HOLD',origin:'RECOVERY',workflowRunId:'run',requestId:'release',resume:{authorization:{type:'user'}},limits:{maxRounds:0,maxModelCalls:0,maxActionDispatches:0,maxReadCalls:0,maxInputTokens:0,maxOutputTokens:0,maxCostMicros:0}}])assert.throws(()=>f.api().createPlan(x as ReturnType<typeof f.input>,f.credential));assert.equal(f.counts.draft+f.counts.plan+f.counts.action,0);
});
test('T05: start expiry consumes nothing; admission expiry allows settlement but prevents a new Read intent',async t=>{
 const expired=continuationFixture(t,{startTtlMs:5}),p=expired.api().createPlan(expired.input(),expired.credential);await new Promise(r=>setTimeout(r,20));await assert.rejects(expired.api().startAuthorized(p.planId,expired.credential));assert.equal(expired.raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,0);
 const f=continuationFixture(t,{admissionMs:50});f.hook(async()=>{await new Promise(r=>setTimeout(r,80));return {value:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'};});const q=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential),out=await f.api().startAuthorized(q.planId,f.credential);
 assert.equal(out.usage.committed.inputTokens,1);assert.equal(out.counts.readCalls,0);assert.equal(out.invocation?.status,'STOPPED');assert.equal(f.counts.draft,1);
});
test('A01/A02/P05: absent Identity and unvalidated network-style Read adapters fail closed before reservation',t=>{
 const f=continuationFixture(t),db=new DurableDatabase({...f.options,recoveryIdentityVerifier:undefined});try{assert.throws(()=>new RecoveryContinuationCoordinator(db).preview(f.input(),f.credential));}finally{db.close();}
 const original=f.options.bounded.reads;f.options.bounded.reads={contract:'LOCAL_PINNED_READ:1',describe:()=>({resourceId:'source',digest:'a'.repeat(64),revision:'1',rootId:'net',sizeBytes:1}),assertCurrent(){},read(){throw Error('not called');}};
 try{assert.throws(()=>f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential));}finally{f.options.bounded.reads=original;}
 assert.equal(f.raw.prepare('SELECT count(*) n FROM model_call_ledger').get()!.n,0);
});
test('M04/M05: authenticated timeline and DTO reflect ledger facts without disclosing prompt or leaking another operator',async t=>{
 const f=continuationFixture(t),x=f.input();x.input!.text='private planning request 4902';const p=f.api().createPlan(x,f.credential),r=await f.api().startAuthorized(p.planId,f.credential),reader=new RecoveryContinuationReader(f.db),timeline=reader.timeline(p.planId,f.credential);
 assert.ok(timeline.some(e=>e.kind==='MODEL_RESPONSE_APPLIED'));assert.ok(timeline.some(e=>e.kind==='planning_artifacts:INSERT'));assert.ok(!JSON.stringify(timeline).includes(x.input!.text));
 assert.equal(r.remaining.modelCalls,0);assert.deepEqual(r.performed,{businessActionDispatches:0,localReadCalls:0,modelCalls:1,internalPersistence:true});assert.equal(r.review.state,'UNREVIEWED');
 assert.throws(()=>reader.timeline(p.planId,f.identity.credential('foreign',['RECOVERY_OPERATOR'])));
});
