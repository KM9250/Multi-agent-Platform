import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync,symlinkSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { continuationFixture,content } from './continuation-fixture.ts';
import { createLocalPlanningReadRegistry } from '../services/coordination/durable/planningReadRegistry.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
for(const path of ['../outside','/etc/passwd','a/../../x','a\\..\\x','C:\\x','//server/share','input.txt:stream','./input.txt'])test(`P04: rejects unsafe local resource ${path}`,t=>{
 const f=continuationFixture(t);assert.throws(()=>createLocalPlanningReadRegistry({root:f.dir,rootId:'test',files:{escape:path}}));
});
test('P04/P05: symbolic links, oversized files and changed references fail closed',t=>{
 const f=continuationFixture(t);symlinkSync(join(f.dir,'input.txt'),join(f.dir,'link'));
 assert.throws(()=>createLocalPlanningReadRegistry({root:f.dir,rootId:'test',files:{escape:'link'}}));
 assert.throws(()=>createLocalPlanningReadRegistry({root:f.dir,rootId:'test',files:{x:'input.txt'},maxBytes:5}));
 const r=f.reads.describe('source')!;writeFileSync(join(f.dir,'input.txt'),'changed');assert.throws(()=>f.reads.read('source',r.digest));
 assert.throws(()=>f.reads.read('https://example.com',r.digest));
});
for(const key of ['maxRounds','maxModelCalls','maxActionDispatches','maxReadCalls','maxInputTokens','maxOutputTokens','maxCostMicros'] as const)test(`I08: ${key} cannot be an unlimited sentinel`,t=>{
 const f=continuationFixture(t);for(const value of [-1,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,undefined]){const x=f.input();(x.limits as any)[key]=value;assert.throws(()=>f.api().createPlan(x,f.credential));}
});
test('I11/I18: Provider reentry and direct stores/SQL cannot inherit invocation authority',async t=>{
 const f=continuationFixture(t);let rejected=0;
 f.hook(async()=>{
  assert.equal(f.db.boundedInvocationActive,false);
  for(const fn of [()=>f.store.assertRecoveryExecution('run'),()=>new ModelCallLedger(f.store).reserve({} as never),
    ()=>f.db.writeWithLease(f.lease,'run',tx=>tx.run("UPDATE recovery_invocations SET status='DRAINING',revision=revision+1 WHERE workflow_run_id='run'")),
    ()=>f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'ProgressRecorded',{outcome:'PROGRESS',summary:'forged'}, {now:Date.now},{nextId:()=> 'forged'}))]){assert.throws(fn);rejected++;}
  return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};
 });
 const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(rejected,4);assert.equal(r.invocation?.outcome,'AWAITING_PLAN_REVIEW');
});
test('I01: independent connections cannot create overlapping active invocations',async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),q=f.api().createPlan(f.input(),f.credential);
 let resolve!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>resolve=r);
 f.hook(async()=>{entered();await pending;return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});
 const a=f.api().startAuthorized(p.planId,f.credential);await ready;
 const second=new DurableDatabase(f.options);try{await assert.rejects(new RecoveryContinuationCoordinator(second,f.lease).startAuthorized(q.planId,f.credential));}
 finally{second.close();resolve();}await a;assert.equal(f.counts.draft,1);
});
test('P09/P10: accepting content never starts execution, and a newer version invalidates the older artifact',async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 f.api().recordReview(r.artifact!,'ACCEPTED_FOR_SCOPE',f.credential);assert.equal(f.counts.action,0);assert.throws(()=>f.store.assertRecoveryExecution('run'));
 const revision=f.api().requestRevision(r.artifact!,f.input(),f.credential),next=await f.api().startAuthorized(revision.planId,f.credential);
 assert.equal(next.artifact?.version,2);assert.notEqual(next.artifact?.artifactId,r.artifact?.artifactId);assert.equal(f.api().inspect(p.planId,f.credential).artifact?.version,1);
 assert.equal(f.counts.draft,2);assert.equal(f.counts.action,0);
});
test('P12/M05: normal planning cannot resume a stopped workflow or inspect another owner',async t=>{
 const f=continuationFixture(t);f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'suspend'}));
 const before=f.store.getSnapshot('run');assert.throws(()=>f.api().createPlan(f.input(),f.credential));assert.deepEqual(f.store.getSnapshot('run'),before);
 const other=f.identity.credential('another',['RECOVERY_OPERATOR']);const x=f.input();x.workflowRunId='missing';assert.throws(()=>f.api().createPlan(x,other));
});
for(const completeness of ['PARTIAL','UNKNOWN'] as const)test(`I09: ${completeness} usage retains the reservation and blocks new IDs`,async t=>{
 const f=continuationFixture(t);f.hook(async()=>({value:{kind:'plan',artifact:content},completeness}));
 const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.status,'REVIEW_REQUIRED');assert.equal(r.artifact,undefined);assert.equal(r.usage.outstanding.inputTokens,20);assert.throws(()=>f.api().createPlan(f.input(),f.credential));
});
test('T01/T03: delayed timers do not admit a synchronous 90ms model response after 25ms; complete usage is settled',async t=>{
 const f=continuationFixture(t,{modelTimeoutMs:25});f.hook(async()=>{const until=performance.now()+90;while(performance.now()<until){}return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});
 const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.invocation?.outcome,'MODEL_TIMEOUT');assert.equal(r.artifact,undefined);assert.equal(r.usage.committed.inputTokens,1);assert.equal(r.usage.outstanding.inputTokens,0);
 assert.equal(f.raw.prepare('SELECT application_status FROM model_call_ledger').get()!.application_status,'NOT_APPLICABLE');
});
test('I15: authenticated stop drains a running model and records its usage without applying a plan',async t=>{
 const f=continuationFixture(t);let entered!:()=>void,finish!:()=>void;const ready=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>finish=r);
 f.hook(async()=>{entered();await pending;return {value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};});
 const p=f.api().createPlan(f.input(),f.credential),run=f.api().startAuthorized(p.planId,f.credential);await ready;f.api().requestStop(p.planId,f.credential);finish();
 const r=await run;assert.equal(r.invocation?.status,'STOPPED');assert.equal(r.usage.committed.inputTokens,1);assert.equal(r.artifact,undefined);assert.equal(f.counts.draft,1);
});
for(const state of ['NOT_SUPPORTED','NOT_STORED','AVAILABLE','NOT_REQUESTED'] as const)test(`P08/M04: reasoning summary status ${state} is explicit`,async t=>{
 const f=continuationFixture(t);if(state==='NOT_SUPPORTED')f.provider.capabilities.summary=false;if(state==='AVAILABLE')f.policy.storeReasoningSummary=true;
 f.hook(async()=>({value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE',summary:'Provider-supplied summary.'}));const x=f.input();if(state==='NOT_REQUESTED')x.requestSummary=false;
 const p=f.api().createPlan(x,f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.artifact?.summary.state,state);assert.equal(r.artifact?.summary.text,state==='AVAILABLE'?'Provider-supplied summary.':undefined);
});
test('P12/A01: USER_REQUEST cannot smuggle WorkflowResumed past a stopped source with no Hold',t=>{
 const f=continuationFixture(t);f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'stop'}));const before=f.store.getSnapshot('run'),x=f.input();x.resume={authorization:{type:'user'}};
 assert.throws(()=>f.api().createPlan(x,f.credential));assert.deepEqual(f.store.getSnapshot('run'),before);assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_holds').get()!.n,0);
});
for(const getter of [false,true])test(`I11: thenable assimilation clears authority; getter output=${getter} is never invoked`,async t=>{
 const f=continuationFixture(t);let seen=0,reads=0;
 f.provider.draftPlan=()=>({then(resolve:(v:unknown)=>void){assert.equal(f.db.boundedInvocationActive,false);seen++;assert.throws(()=>f.store.assertRecoveryExecution('run'));
  const response={value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'};if(getter)Object.defineProperty(response,'value',{get(){reads++;throw Error('must not execute');}});resolve(response);
 }} as never);
 const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);assert.equal(r.invocation?.outcome,getter?'MODEL_REVIEW_REQUIRED':'AWAITING_PLAN_REVIEW');assert.equal(seen,1);assert.equal(reads,0);
});
