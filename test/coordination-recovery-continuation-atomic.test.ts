import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationFixture } from './continuation-fixture.ts';
import { hold,executeInput } from './continuation-runner-fixture.ts';
import { fault } from './continuation-fault-fixture.ts';
for(const when of ['BEFORE','ACK'] as const)test(`I06/I17: action result ${when} retains the reserved attempt and never dispatches twice`,async t=>{
 const f=continuationFixture(t);hold(f);const p=f.api().createPlan(executeInput(f),f.credential);f.api().authorize(p,f.approver);await fault('INSERT INTO execution_results',when,()=>f.api().startAuthorized(p.planId,f.credential));
 assert.equal(f.counts.action,1);assert.equal(f.raw.prepare('SELECT count(*) n FROM execution_results').get()!.n,when==='ACK'?1:0);await f.api().startAuthorized(p.planId,f.credential);assert.equal(f.counts.action,1);
});
for(const when of ['BEFORE','ACK'] as const)test(`H04/C04: release ${when} is atomic and idempotent with zero external calls`,async t=>{
 const f=continuationFixture(t);hold(f);const p=f.api().createPlan({operation:'RELEASE_RECOVERY_HOLD',origin:'RECOVERY',workflowRunId:'run',requestId:'release',resume:{authorization:{type:'user'}},limits:{maxRounds:0,maxModelCalls:0,maxActionDispatches:0,maxReadCalls:0,maxInputTokens:0,maxOutputTokens:0,maxCostMicros:0}},f.credential);f.api().authorize(p,f.approver);
 await fault('INSERT INTO recovery_hold_lifecycle',when,async()=>{if(when==='BEFORE')await assert.rejects(f.api().startAuthorized(p.planId,f.credential));else await f.api().startAuthorized(p.planId,f.credential);});
 assert.equal(f.api().inspect(p.planId,f.credential).control.holdState,when==='ACK'?'RELEASED':'HELD');assert.equal(f.raw.prepare('SELECT status FROM recovery_continuation_grants').get()!.status,when==='ACK'?'CONSUMED':'AUTHORIZED');assert.equal(f.store.getSnapshot('run').run.status,when==='ACK'?'RUNNING':'SUSPENDED');assert.deepEqual(f.counts,{draft:0,plan:0,verify:0,action:0,prepare:0});
});
