import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { continuationFixture,content } from './continuation-fixture.ts';
import { hold,executeInput } from './continuation-runner-fixture.ts';
import { registration,record,model,executionSeed } from './durable-execution-fixture.ts';
import { DurableExecutionCoordinator } from '../services/coordination/durable/executionCoordinator.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { SqliteRunnerEvidenceStore } from '../services/coordination/durable/evidenceStore.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { runnerPendingApproval } from '../services/coordination/runner/policyGuard.ts';
import { DATABASE_NOW_SQL } from '../services/coordination/durable/leaseSchema.ts';
const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
for(const resolution of ['CANCELLED_PRE_DISPATCH','DISCARDED','RECOVERY_DISCARDED','UNKNOWN'] as const)test(`I13: prior VERIFY ${resolution} requires a durable resolution lineage before a new call`,async t=>{
 const f=continuationFixture(t),coordinator=new DurableExecutionCoordinator(f.store,{get:id=>f.options.controlledExecutors.get(id)?.executor});const reg=registration(f.store);coordinator.registerAction(record,reg.expected,reg.sessionEvent,reg.taskEvent);const task=f.store.getSnapshot('run').tasks.task;await coordinator.dispatch('run',task);coordinator.finalizeResult('run',task);
 const s=f.store.getSnapshot('run'),x={workflowRunId:'run',modelCallId:'old-verify',attemptId:'old-attempt',providerId:'synthetic',modelId:'test',roundKey:'round',phase:'VERIFY' as const,requestCursor:s.events.length,requestEventId:s.events.at(-1)!.eventId,quote:{...f.provider.capabilities.quote,maxAttempts:1 as const,requestDigest:'c'.repeat(64)}};
 const ledger=new ModelCallLedger(f.store);ledger.reserve(x);if(resolution==='CANCELLED_PRE_DISPATCH')ledger.cancelBeforeDispatch(x);else {ledger.markDispatchIntent(x);if(resolution==='UNKNOWN')ledger.markReviewRequired(x,'UNKNOWN');else {ledger.settle(x,usage,true);if(resolution==='DISCARDED')ledger.markDiscarded(x,'ABORTED');}}
 if(resolution==='RECOVERY_DISCARDED'){
  const {SafeRecoveryPlanner,SafeRecoveryAuthorizer,SafeRecoveryExecutor}=await import('../services/coordination/durable/safeRecoveryExecutor.ts');const {executionScopeOf}=await import('../services/coordination/durable/safeRecoveryStore.ts');
  assert.throws(()=>f.store.assertRecoveryExecution('run'));const oldPlan=new SafeRecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'DISCARD_SETTLED_RESPONSE',targetId:x.modelCallId},f.credential);
  new SafeRecoveryAuthorizer(f.db,f.lease).authorize(oldPlan.executionPlanId,executionScopeOf(oldPlan),f.approver);new SafeRecoveryExecutor(f.db,f.lease).executeAuthorized(oldPlan.executionPlanId,f.credential);
 } else hold(f);
 const input=executeInput(f);if(resolution==='RECOVERY_DISCARDED')delete input.resume;input.start='VERIFY_FINALIZED_RESULT';input.taskId='task';input.limits.maxActionDispatches=0;input.limits.maxModelCalls=1;
 if(resolution==='UNKNOWN'){assert.throws(()=>f.api().createPlan(input,f.credential));assert.equal(f.counts.verify,0);return;}
 const p=f.api().createPlan(input,f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.invocation?.status,'COMPLETED',JSON.stringify(r));
 const link=f.raw.prepare('SELECT * FROM recovery_model_lineage').get()!;assert.equal(link.supersedes_model_call_id,'old-verify');assert.notEqual(link.model_call_id,'old-verify');assert.ok(link.resolution_id);assert.equal(r.usage.committed.inputTokens,1);assert.equal(f.counts.verify,1);
});
for(const limit of ['maxModelCalls','maxActionDispatches'] as const)test(`I04-I06: ${limit} exhaustion never returns a slot or creates an unauthorized next step`,async t=>{
 const f=continuationFixture(t);hold(f);const x=executeInput(f);x.limits[limit]=limit==='maxModelCalls'?1:0;const p=f.api().createPlan(x,f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.counts.rounds,1);assert.equal(r.counts.modelCalls,1);assert.equal(r.counts.actionDispatches,limit==='maxModelCalls'?1:0);assert.notEqual(r.invocation?.status,'COMPLETED');
 if(limit==='maxActionDispatches')assert.equal(Object.keys(f.store.getSnapshot('run').tasks).length,0);
 await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.plan,1);
});
for(const dimension of ['inputTokens','outputTokens','costMicros'] as const)test(`I08: Invocation ${dimension} bound rejects reservation with no partial debit`,async t=>{
 const f=continuationFixture(t),x=f.input();if(dimension==='costMicros'){f.provider.capabilities.quote.maxEstimatedCost=0.000001;x.limits.maxCostMicros=0;}else x.limits[dimension==='inputTokens'?'maxInputTokens':'maxOutputTokens']=19;
 const p=f.api().createPlan(x,f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.counts.modelCalls,0);assert.equal(f.counts.draft,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM model_call_ledger').get()!.n,0);
});
test('I08/I09: output including reasoning is charged once, over-quote Usage is retained and no artifact is applied',async t=>{
 const f=continuationFixture(t);f.hook(async()=>({value:{kind:'plan',artifact:content},usage:{...usage,outputTokens:21},completeness:'COMPLETE'}));const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.usage.committed.outputTokens,21);assert.equal(r.artifact,undefined);assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.throws(()=>f.api().createPlan(f.input(),f.credential));
});
test('I10: a new planning Invocation cannot reset original Workflow elapsed time',t=>{
 const f=continuationFixture(t);f.admin.createWorkflow(executionSeed('ALLOW','expired',{maxWallTimeMs:1}));const lease=f.manager.acquire('expired'),api=new RecoveryContinuationCoordinator(f.db,lease),x=f.input();x.workflowRunId='expired';assert.throws(()=>api.createPlan(x,f.credential));assert.equal(f.counts.draft,0);
});
test('T01: synchronous local Read crossing its persisted execution deadline remains timed out with no artifact',async t=>{
 const f=continuationFixture(t,{readTimeoutMs:500}),original=fs.readSync;let entered=false;
 f.hook(async()=>({value:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'}));
 fs.readSync=((fd,...args:any[])=>{
  if(!entered&&fs.readlinkSync(`/proc/self/fd/${fd}`)===join(f.dir,'input.txt')){
   const step=f.raw.prepare("SELECT execution_deadline FROM recovery_invocation_steps WHERE kind='READ'").get()!;
   const now=Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
   assert.ok(now<Number(step.execution_deadline),'Actual local Read must enter before its persisted deadline');entered=true;
   const remaining=Number(step.execution_deadline)-now+25;assert.ok(remaining>0&&remaining<=525);
   const until=performance.now()+remaining;while(performance.now()<until){}
  }
  return (original as any)(fd,...args);
 }) as typeof fs.readSync;syncBuiltinESMExports();
 try{const p=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.ok(entered);assert.equal(r.counts.readCalls,1);assert.equal(r.artifact,undefined);assert.equal(f.raw.prepare('SELECT state FROM planning_read_calls').get()!.state,'TIMED_OUT');assert.equal(f.counts.draft,1);}
 finally{fs.readSync=original;syncBuiltinESMExports();}
});
test('T02: late Executor evidence is denied while the coordinator records an uncertain result within grace',async t=>{
 const f=continuationFixture(t,{actionTimeoutMs:500}),evidence=new SqliteRunnerEvidenceStore(f.db,f.lease);let rejected=false;
 f.actionHook(async ctx=>{
  const step=f.raw.prepare("SELECT execution_deadline,collection_deadline FROM recovery_invocation_steps WHERE kind='ACTION'").get()!;
  const now=Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
  assert.ok(now<Number(step.execution_deadline),'Executor must enter before its persisted execution deadline');
  const remaining=Number(step.execution_deadline)-now+25;assert.ok(remaining>0&&remaining<=525);
  const until=performance.now()+remaining;while(performance.now()<until){}
  const late=Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
  assert.ok(late>Number(step.execution_deadline)&&late<Number(step.collection_deadline));
  await assert.rejects(evidence.withOwner({workflowRunId:'run',sessionId:ctx.sessionId,taskId:ctx.taskId,actionId:'action-1'},()=>evidence.put({kind:'late',content:'denied',createdAt:Date.now()})));rejected=true;return {status:'succeeded',summary:'late'};
 });
 hold(f);const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);assert.ok(rejected);assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(f.raw.prepare("SELECT count(*) n FROM runner_evidence WHERE kind='late'").get()!.n,0);assert.equal(f.raw.prepare('SELECT count(*) n FROM execution_results').get()!.n,1);
});
test('T04: generation loss during model execution rejects old-generation Usage and never regenerates the response',async t=>{
 const f=continuationFixture(t);f.hook(async()=>{f.reacquire();return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(r.invocation?.outcome,'LEASE_LOST');assert.equal(r.usage.committed.inputTokens,0);assert.equal(r.usage.outstanding.inputTokens,20);assert.equal(r.artifact,undefined);await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.draft,1);
});
test('T03/T05: after the collection deadline even complete late Usage stays unresolved and no replacement is sent',async t=>{
 // First reach the real Provider boundary. A 25ms step budget could expire during
 // reservation/Intent validation under parallel suites, testing pre-send refusal instead.
 const f=continuationFixture(t,{modelTimeoutMs:500,collectionGraceMs:25,finalizationMs:25});let returnedCompleteUsage=false;
 f.hook(async()=>{
  const step=f.raw.prepare("SELECT execution_deadline,collection_deadline FROM recovery_invocation_steps WHERE kind='MODEL'").get()!;
  const now=Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now);
  assert.ok(now<Number(step.execution_deadline),'Provider must enter before its persisted execution deadline');
  const remaining=Number(step.collection_deadline)-now+25;
  assert.ok(remaining>0&&remaining<=550,'The deliberate event-loop stall is finite and tied to the stored collection deadline');
  const until=performance.now()+remaining;while(performance.now()<until){}
  assert.ok(Number(f.raw.prepare(`SELECT ${DATABASE_NOW_SQL} AS now`).get()!.now)>Number(step.collection_deadline));
  returnedCompleteUsage=true;return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};
 });
 const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(r.usage.committed.inputTokens,0);assert.equal(r.usage.outstanding.inputTokens,20);assert.equal(f.counts.draft,1);
 assert.ok(returnedCompleteUsage);assert.equal(r.artifact,undefined);
 const repeated=await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.draft,1);assert.deepEqual(repeated.usage,r.usage);assert.equal(repeated.artifact,undefined);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM model_call_ledger').get()!.n,1);
});
for(const start of ['RESUME_PREPARED','VERIFY_FINALIZED_RESULT'] as const)test(`R03/R04: ${start} refuses nonexistent task, unresolved Review and terminal resurrection`,t=>{
 const f=continuationFixture(t);hold(f);const x=executeInput(f);x.start=start;x.taskId='foreign';x.actionId='foreign';if(start==='VERIFY_FINALIZED_RESULT'){x.limits.maxActionDispatches=0;x.limits.maxModelCalls=1;}assert.throws(()=>f.api().createPlan(x,f.credential));assert.equal(f.counts.plan,0);
});
for(const dimension of ['inputTokens','outputTokens','cost'] as const)test(`I08: Workflow ${dimension} ceiling and Invocation ceiling are both checked at reservation`,async t=>{
 const f=continuationFixture(t),limits={maxWallTimeMs:Number.MAX_SAFE_INTEGER,maxLlmCalls:10,maxInputTokens:1000,maxOutputTokens:1000,maxEstimatedCost:1};if(dimension==='cost'){limits.maxEstimatedCost=0.000001;f.provider.capabilities.quote.maxEstimatedCost=0.000002;}else limits[dimension==='inputTokens'?'maxInputTokens':'maxOutputTokens']=19;
 f.admin.createWorkflow(executionSeed('ALLOW','tight',limits));const lease=f.manager.acquire('tight'),api=new RecoveryContinuationCoordinator(f.db,lease),x=f.input();x.workflowRunId='tight';const p=api.createPlan(x,f.credential),r=await api.startAuthorized(p.planId,f.credential);
 assert.equal(f.counts.draft,0);assert.equal(r.counts.modelCalls,0);assert.equal(f.raw.prepare("SELECT count(*) n FROM model_call_ledger WHERE workflow_run_id='tight'").get()!.n,0);
});
test('I06: maxActionDispatches=1 prevents a second action in a two-round Invocation',async t=>{
 const f=continuationFixture(t);f.verifyHook(async()=>({...model({taskOutcome:'PASS' as const,summary:'Still missing acceptance',criteria:[{criterion:'done',outcome:'UNSATISFIED' as const}]}),provider:'synthetic'}));hold(f);const x=executeInput(f);x.limits.maxRounds=2;x.limits.maxModelCalls=4;const p=f.api().createPlan(x,f.credential);f.api().authorize(p,f.approver);const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.counts.rounds,2);assert.equal(r.counts.actionDispatches,1);assert.equal(f.counts.action,1);assert.notEqual(r.invocation?.status,'COMPLETED');assert.equal(f.raw.prepare('SELECT count(*) n FROM pending_actions').get()!.n,1);
});
