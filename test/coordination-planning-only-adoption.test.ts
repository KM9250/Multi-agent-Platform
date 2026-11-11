import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationFixture,content } from './continuation-fixture.ts';
import { executeInput } from './continuation-runner-fixture.ts';
import { RecoveryContinuationCoordinator } from '../services/coordination/durable/recoveryContinuationCoordinator.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
async function artifact(f:ReturnType<typeof continuationFixture>,read=false){
 if(read)f.hook(async r=>({value:r.reads.length?{kind:'plan',artifact:content}:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage,completeness:'COMPLETE'}));
 const p=f.api().createPlan(f.input(read?'PLAN_READ_ONLY':'THINK_ONLY'),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);f.api().recordReview(r.artifact!,'ACCEPTED_FOR_SCOPE',f.credential,r.control.revision);return {p,r};
}
test('P09/I14: artifact acceptance, execution approval and initial dispatch are three separate commands',async t=>{
 const f=continuationFixture(t),{r}=await artifact(f);const x=executeInput(f);x.origin='USER_REQUEST';delete x.resume;x.artifact=r.artifact;
 assert.equal(f.counts.action,0);const p=f.api().createPlan(x,f.credential);assert.equal(f.counts.action,0);await assert.rejects(f.api().startAuthorized(p.planId,f.credential));
 f.api().authorize(p,f.approver);assert.equal(f.counts.action,0);const execution=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(execution.invocation?.status,'COMPLETED',JSON.stringify(execution));assert.equal(execution.counts.actionDispatches,1);assert.equal(execution.counts.modelCalls,2);assert.equal(f.counts.action,1);
});
for(const change of ['resource','policy','provider','executor','version'] as const)test(`P10/A03: ${change} change invalidates the approved execution plan before any business call`,async t=>{
 const f=continuationFixture(t),{r}=await artifact(f,true),x=executeInput(f);x.origin='USER_REQUEST';delete x.resume;x.artifact=r.artifact;
 const p=f.api().createPlan(x,f.credential);f.api().authorize(p,f.approver);
 if(change==='resource')writeFileSync(join(f.dir,'input.txt'),'modified');
 if(change==='policy')f.policy.version='new';
 if(change==='provider')f.provider.capabilities.adapterVersion='new';
 if(change==='executor')f.options.controlledExecutors.get('test')!.executor.execute=async()=>({status:'succeeded',summary:'changed'});
 if(change==='version'){const q=f.api().requestRevision(r.artifact!,f.input(),f.credential);await f.api().startAuthorized(q.planId,f.credential);assert.throws(()=>f.api().recordReview(r.artifact!,'REJECTED',f.credential,r.control.revision));}
 await assert.rejects(f.api().startAuthorized(p.planId,f.credential));assert.equal(f.counts.action,0);assert.equal(f.counts.plan,0);
});
test('P12: independent approved snapshot planning does not resume, spend from, or copy authority from its stopped source',async t=>{
 const f=continuationFixture(t);f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'source-stop'}));const source=f.store.getSnapshot('run');
 f.admin.createWorkflow(executionSeed('DENY','planning',{maxWallTimeMs:Number.MAX_SAFE_INTEGER,maxLlmCalls:2,maxInputTokens:100,maxOutputTokens:100,maxEstimatedCost:1}));
 const lease=f.manager.acquire('planning'),api=new RecoveryContinuationCoordinator(f.db,lease),x=f.input();x.workflowRunId='planning';x.input!.snapshots=[{id:'source-snapshot',sourceWorkflowId:'run',digest:digest(source),revision:String(source.events.length),observedAt:Date.now()}];
 x.input!.text='Consider this explicitly supplied, redacted snapshot. Source is suspended; do not resume it.';
 const p=api.createPlan(x,f.credential),r=await api.startAuthorized(p.planId,f.credential);assert.equal(r.invocation?.status,'COMPLETED');assert.equal(r.artifact?.snapshots[0].sourceWorkflowId,'run');
 assert.deepEqual(f.store.getSnapshot('run'),source);assert.equal(source.run.usage.llmCalls,0);assert.equal(f.admin.getSnapshot('planning').run.usage.llmCalls,1);assert.equal(f.admin.getSnapshot('planning').run.budget.maxLlmCalls,2);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_holds').get()!.n,0);assert.equal(f.counts.action,0);
});
test('P05/A02: missing verifier/role, untrusted read registry, unsupported destination and reasoning fail before reservation',t=>{
 const f=continuationFixture(t);assert.throws(()=>f.api().createPlan(f.input(),{}));assert.throws(()=>f.api().createPlan(f.input(),f.identity.credential('viewer',['RECOVERY_VIEWER'])));
 for(const mutate of [(x:ReturnType<typeof f.input>)=>x.providerId='production-unconnected',(x:ReturnType<typeof f.input>)=>x.input!.destination='https://arbitrary.example',(x:ReturnType<typeof f.input>)=>x.reasoning={effort:'unsupported'}]){const x=f.input();mutate(x);assert.throws(()=>f.api().createPlan(x,f.credential));}
 assert.equal(f.raw.prepare('SELECT count(*) n FROM model_call_ledger').get()!.n,0);assert.equal(f.counts.draft,0);
});
test('A03/I12: a referenced file changed by a model callback is rejected again before Action registration and dispatch',async t=>{
 const {model}=await import('./durable-execution-fixture.ts');const f=continuationFixture(t),{r}=await artifact(f,true),x=executeInput(f);x.origin='USER_REQUEST';delete x.resume;x.artifact=r.artifact;
 const p=f.api().createPlan(x,f.credential);f.api().authorize(p,f.approver);f.planHook(async()=>{writeFileSync(join(f.dir,'input.txt'),'changed during planning');return {...model({kind:'execute' as const,objective:'Goal',action:{executorId:'test',operation:'read',arguments:{}}}),provider:'synthetic'};});
 const out=await f.api().startAuthorized(p.planId,f.credential);assert.notEqual(out.invocation?.status,'COMPLETED');assert.equal(out.counts.actionDispatches,0);assert.equal(f.counts.action,0);assert.equal(Object.keys(f.store.getSnapshot('run').tasks).length,0);
});
