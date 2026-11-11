import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationFixture,content } from './continuation-fixture.ts';

test('P01/P07/P08/P11: THINK_ONLY publishes a durable plan and ends normally without recovery hold or business work',async t=>{
 const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);
 const r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.status,'COMPLETED',JSON.stringify(r));assert.equal(r.invocation?.outcome,'AWAITING_PLAN_REVIEW');assert.deepEqual(r.artifact?.content,content);
 assert.equal(r.control.holdState,'NONE');assert.equal(r.control.planningReviewPending,true);assert.equal(r.artifact?.summary.state,'NOT_RETURNED');
 assert.deepEqual(f.counts,{draft:1,plan:0,verify:0,action:0,prepare:0});assert.deepEqual(r.counts,{rounds:0,modelCalls:1,actionDispatches:0,readCalls:0});
 assert.deepEqual(f.api().inspect(p.planId,f.credential).artifact,r.artifact);
 assert.throws(()=>f.store.assertRecoveryExecution('run'));assert.equal(f.raw.prepare('SELECT count(*) n FROM recovery_holds').get()!.n,0);
 assert.deepEqual(await f.api().startAuthorized(p.planId,f.credential),r);assert.equal(f.counts.draft,1);
 assert.equal(f.raw.prepare('SELECT count(*) n FROM pending_actions').get()!.n,0);
});
test('P03/P06: allowlisted local read is a separately charged intent and untrusted text cannot change mode',async t=>{
 const f=continuationFixture(t),original=readFileSync(join(f.dir,'input.txt'),'utf8');
 f.hook(async r=>({value:r.reads.length?{kind:'plan',artifact:content}:{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
 const p=f.api().createPlan(f.input('PLAN_READ_ONLY'),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.outcome,'AWAITING_PLAN_REVIEW',JSON.stringify(r));assert.equal(r.counts.readCalls,1);assert.equal(r.counts.modelCalls,2);
 assert.equal(readFileSync(join(f.dir,'input.txt'),'utf8'),original);assert.equal(f.counts.action,0);
});
test('P02/P13: execute output and read requests in THINK_ONLY produce PLAN_INCOMPLETE with no action preparation',async t=>{
 for(const value of [{kind:'execute',action:{executorId:'test'}},{kind:'read_requests',requests:[{resourceId:'source',digest:'a'.repeat(64)}]}]){
 const f=continuationFixture(t);f.hook(async()=>({value:value as never,usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
 const p=f.api().createPlan(f.input(),f.credential),r=await f.api().startAuthorized(p.planId,f.credential);
 assert.equal(r.invocation?.outcome,'PLAN_INCOMPLETE',JSON.stringify(r));assert.equal(r.artifact,undefined);assert.equal(f.counts.prepare,0);assert.equal(f.counts.action,0);
 }
});
