import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { executionFixture, model, clock } from './durable-execution-fixture.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { costMicros } from '../services/coordination/durable/modelBudgetGuard.ts';
import { RecoveryReader } from '../services/coordination/durable/recoveryReader.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
export function request(f:ReturnType<typeof executionFixture>,phase:'PLAN'|'VERIFY'='PLAN',roundKey=randomUUID()) {
 const s=f.snapshot();return {workflowRunId:'run',modelCallId:randomUUID(),attemptId:randomUUID(),providerId:'test',modelId:'test',roundKey,phase,
 requestCursor:s.events.length,requestEventId:s.events.at(-1)!.eventId,
 quote:{providerId:'test',modelId:'test',maxAttempts:1 as const,inputTokens:10,maxOutputTokens:10,maxEstimatedCost:0.001,pricingId:'test-rate',conditions:'test-only',requestDigest:'a'.repeat(64)}};
}
const usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0.000001};
for(const phase of ['PLAN','VERIFY'] as const) test(`${phase}: reservation, intent, atomic settlement and exact retry`,t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f,phase);
 l.reserve(x);assert.equal(l.getBudgetPosition('run').outstanding.llmCalls,1);
 l.markDispatchIntent(x);assert.throws(()=>l.markDispatchIntent(x));
 l.settle(x,usage,true);l.settle(x,usage,true);
 assert.equal(f.snapshot().run.usage.llmCalls,1);assert.equal(l.getBudgetPosition('run').outstanding.llmCalls,0);
 assert.equal(l.inspect('run')[0].application_status,'PENDING_APPLICATION');
 assert.throws(()=>l.settle(x,{...usage,inputTokens:2},true));
 assert.throws(()=>l.reserve(request(f)));
 const r=new RecoveryReader(f.db).inspect('run');assert.equal(r.modelCalls?.pendingApplication,1);assert.equal(r.executionAllowed,false);
 assert.ok(new RecoveryReader(f.db).getWorkflowTimeline('run').entries.some(e=>e.modelCallId===x.modelCallId));
});
test('money decimal rounding, safe range and journal correspondence',()=>{
 assert.equal(costMicros(0.0000001),1);assert.equal(costMicros(0.0000001,'floor'),0);
 assert.equal(costMicros(1.000001),1000001);assert.equal(costMicros(0.1+0.2),300001);
 assert.throws(()=>costMicros(Infinity));assert.throws(()=>costMicros(Number.MAX_SAFE_INTEGER));
});
test('budget rejects excess and sums simultaneous outstanding reservations',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);x.quote.inputTokens=f.snapshot().run.budget.maxInputTokens;
 l.reserve(x);assert.throws(()=>l.reserve(request(f)),{code:'MODEL_BUDGET_EXHAUSTED'});
 l.cancelBeforeDispatch(x);l.reserve(request(f));assert.equal(l.getBudgetPosition('run').outstanding.llmCalls,1);
});
for(const completeness of ['UNKNOWN','PARTIAL'] as const)test(`${completeness} retains reservation and stops new calls`,t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);
 l.markReviewRequired(x,completeness,completeness==='PARTIAL'?{inputTokens:1}:undefined);
 assert.equal(l.getBudgetPosition('run').outstanding.inputTokens,10);assert.equal(f.snapshot().run.usage.llmCalls,0);
 assert.throws(()=>l.reserve(request(f)));assert.throws(()=>l.cancelBeforeDispatch(x));
});
test('actual usage over reservation is retained and future calls are prohibited',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);l.settle(x,{...usage,inputTokens:11},true);
 assert.equal(f.snapshot().run.usage.inputTokens,11);assert.equal(l.inspect('run')[0].budget_violation,1);assert.throws(()=>l.reserve(request(f)));
});
for(const where of ['journal','audit'] as const)test(`${where} failure rolls back usage, ledger and audit together`,t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);
 f.raw().exec(`CREATE TRIGGER fail_model BEFORE INSERT ON ${where==='audit'?'runtime_audit_events':'journal_events'} BEGIN SELECT RAISE(ABORT,'test'); END`);
 assert.throws(()=>l.settle(x,usage,true));assert.equal(l.inspect('run')[0].state,'DISPATCH_INTENT');assert.equal(f.snapshot().run.usage.llmCalls,0);
});
test('stale generation, cross workflow and direct model usage are fenced',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);
 assert.throws(()=>l.settle({...x,workflowRunId:'another'},usage,true));
 assert.throws(()=>f.store.append(createRunnerEvent(f.snapshot(),'UsageRecorded',{...usage,sourceRef:'map.runner.model.call.v1:forged'},{now:()=>10},{nextId:()=>randomUUID()})));
 f.release();f.acquire();assert.throws(()=>l.settle(x,usage,true),{code:'LEASE_FENCED'});
});
test('application and business events rollback together; matching receipt confirms lost ACK',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);l.settle(x,usage,true);
 const n=f.snapshot().events.length,apply=()=>f.add('ProgressRecorded',{outcome:'NO_PROGRESS',summary:'test'});
 assert.throws(()=>l.markApplied(x,n,()=>{apply();throw Error('crash');}));
 assert.equal(f.snapshot().events.length,n);assert.equal(l.inspect('run')[0].application_status,'PENDING_APPLICATION');
 l.markApplied(x,n,apply);assert.equal(l.inspect('run')[0].application_status,'APPLIED');assert.ok(l.inspectApplication(x,f.snapshot().events.slice(n)));
});
test('invalid response can be discarded without losing usage',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);l.settle(x,usage,true);
 l.markDiscarded(x,'INVALID_RESPONSE');l.markDiscarded(x,'INVALID_RESPONSE');assert.equal(f.snapshot().run.usage.llmCalls,1);
});
test('runner settles and applies PLAN and VERIFY, preserving non-model action workflow',async t=>{
 const f=executionFixture(t);const result=await f.runner.runOneRound('run');assert.equal(result.reason,'completed');
 const rows=new ModelCallLedger(f.store,clock).inspect('run');assert.equal(rows.length,2);assert.ok(rows.every(r=>r.application_status==='APPLIED'));
 assert.equal(f.calls.plan,1);assert.equal(f.calls.verify,1);
});
test('settlement lost COMMIT ACK re-queries exact receipt and cannot double count',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);
 const write=f.store.writeWorkflow.bind(f.store);let once=true;f.store.writeWorkflow=(id,fn)=>{const result=write(id,fn);if(once){once=false;throw Error('lost ack');}return result;};
 assert.equal(l.settle(x,usage,true).state,'SETTLED');l.settle(x,usage,true);assert.equal(f.snapshot().run.usage.llmCalls,1);
});
test('application retry is idempotent only for matching saved start and receipt',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);l.settle(x,usage,true);
 const n=f.snapshot().events.length;let invoked=0;const apply=()=>{invoked++;f.add('ProgressRecorded',{outcome:'NO_PROGRESS',summary:'test'});};
 l.markApplied(x,n,apply);l.markApplied(x,n,apply);assert.equal(invoked,1);assert.throws(()=>l.markApplied(x,n+1,apply));
});
test('two independent SQLite connections serialize competing budget reservations',async t=>{
 const f=executionFixture(t),first=new ModelCallLedger(f.store,clock),other=f.open(),second=new ModelCallLedger(other.store,clock),x=request(f),y=request(f);
 x.quote.inputTokens=y.quote.inputTokens=f.snapshot().run.budget.maxInputTokens;
 const results=await Promise.allSettled([Promise.resolve().then(()=>first.reserve(x)),Promise.resolve().then(()=>second.reserve(y))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(first.getBudgetPosition('run').outstanding.inputTokens,x.quote.inputTokens);
});
test('SQLite rejects backward transitions, reservation mutation and second attempt even with a valid lease',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);
 for(const sql of ["UPDATE model_call_ledger SET state='RESERVED'",'UPDATE model_call_ledger SET reserved_input=0',"UPDATE model_call_attempts SET attempt_number=2",'DELETE FROM model_call_ledger'])assert.throws(()=>f.store.writeWorkflow('run',tx=>tx.run(sql)));
});
test('database busy does not authorize a reservation or pretend COMMIT succeeded',t=>{
 const f=executionFixture(t),raw=f.raw(),l=new ModelCallLedger(f.store,clock),x=request(f);raw.exec('BEGIN IMMEDIATE');
 try{assert.throws(()=>l.reserve(x),{code:'DATABASE_BUSY'});}finally{raw.exec('ROLLBACK');}
 assert.equal(l.inspect('run').length,0);
});
test('settlement ownership and provider mismatch are rejected',t=>{
 const f=executionFixture(t),l=new ModelCallLedger(f.store,clock),x=request(f);l.reserve(x);l.markDispatchIntent(x);
 for(const patch of [{attemptId:'other'},{providerId:'other'},{modelId:'other'},{modelCallId:'other'}])assert.throws(()=>l.settle({...x,...patch},usage,true));
 assert.equal(f.snapshot().run.usage.llmCalls,0);
});
test('complete usage and audit contain only allowed metadata, never prompt or response',async t=>{
 const f=executionFixture(t);f.provider.plan=async()=>model({kind:'finish',summary:'SECRET_RESPONSE_BODY'});
 await f.runner.runOneRound('run');
 const saved=f.db.read(tx=>JSON.stringify({ledger:tx.all('SELECT * FROM model_call_ledger'),audit:tx.all("SELECT * FROM runtime_audit_events WHERE event_kind LIKE 'MODEL_%'")}));
 assert.ok(!saved.includes('SECRET_RESPONSE_BODY'));assert.ok(!saved.includes('Original user goal'));
});
