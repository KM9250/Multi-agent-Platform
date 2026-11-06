import assert from 'node:assert/strict';
import test from 'node:test';
import { executionFixture, model, clock } from './durable-execution-fixture.ts';
import { testModel } from './model-call-fixture.ts';
import { createDurableCoordinationRunner } from '../services/coordination/durable/durableRunner.ts';
import { DurableModelCallCoordinator } from '../services/coordination/durable/modelCallCoordinator.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { runnerPlanRequest } from '../services/coordination/runner/context.ts';
import { RequestScheduler } from '../services/scheduler/requestScheduler.ts';
import { RecoveryReader } from '../services/coordination/durable/recoveryReader.ts';
const input=(f:ReturnType<typeof executionFixture>,signal=new AbortController().signal)=>({workflowRunId:'run',roundKey:'round',phase:'PLAN' as const,requestCursor:f.snapshot().events.length,requestEventId:f.snapshot().events.at(-1)!.eventId,request:runnerPlanRequest(f.snapshot(),10,signal)});
for(const completeness of ['COMPLETE','PARTIAL','UNKNOWN'] as const)test(`API error receipt ${completeness} never inferred from usage alone`,async t=>{
 const f=executionFixture(t);f.provider.plan=async()=>{f.calls.plan++;throw {usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},testUsageCompleteness:completeness};};
 const c=new DurableModelCallCoordinator(f.store,testModel(f.provider),clock);
 await assert.rejects(c.call(input(f)));
 const r=c.ledger.inspect('run')[0];assert.equal(r.state,completeness==='COMPLETE'?'SETTLED':'REVIEW_REQUIRED');
 assert.equal(r.application_status,'NOT_APPLICABLE');assert.equal(f.snapshot().run.usage.llmCalls,completeness==='COMPLETE'?1:0);
 assert.equal(c.ledger.getBudgetPosition('run').outstanding.llmCalls,completeness==='COMPLETE'?0:1);assert.equal(f.calls.plan,1);
});
test('uncertified adapter cannot claim compatibility or run hidden retries',async t=>{
 const f=executionFixture(t),c=new DurableModelCallCoordinator(f.store,Object.assign(f.provider,{durable:{maxAttempts:1}}));
 await assert.rejects(c.call(input(f)),{code:'MODEL_ADAPTER_UNSUPPORTED'});assert.equal(f.calls.plan,0);assert.equal(c.ledger.inspect('run').length,0);
});
test('scheduler transient error never replays a durable job',async t=>{
 const f=executionFixture(t);f.provider.plan=async()=>{f.calls.plan++;throw {status:503};};f.provider.scheduling={provider:'test',model:'test'};
 const scheduler=new RequestScheduler({retry:{baseDelayMs:0,maxDelayMs:0,maxAttempts:3}});
 const runner=createDurableCoordinationRunner({coordinator:f.coordinator,supervisorProvider:testModel(f.provider),scheduler,clock});
 await runner.runUntilStop('run');assert.equal(f.calls.plan,1);assert.equal(new ModelCallLedger(f.store).inspect('run').length,1);
});
test('queue abort creates no reservation and makes no model call',async t=>{
 const f=executionFixture(t),scheduler=new RequestScheduler({defaultConcurrencyPerModel:1});f.provider.scheduling={provider:'test',model:'test'};
 let release!:()=>void;const held=scheduler.schedule({provider:'test',model:'test',kind:'coordination',execute:()=>new Promise<void>(r=>release=r)});
 const abort=new AbortController(),runner=createDurableCoordinationRunner({coordinator:f.coordinator,supervisorProvider:testModel(f.provider),scheduler,clock});
 const waiting=runner.runOneRound('run',{signal:abort.signal});abort.abort();await waiting;release();await held;
 assert.equal(f.calls.plan,0);assert.equal(new ModelCallLedger(f.store).inspect('run').length,0);
});
test('abort after intent retains reservation without provider dispatch',async t=>{
 const f=executionFixture(t),c=new DurableModelCallCoordinator(f.store,testModel(f.provider),clock),abort=new AbortController();
 const mark=c.ledger.markDispatchIntent.bind(c.ledger);c.ledger.markDispatchIntent=x=>{mark(x);abort.abort();};
 await assert.rejects(c.call(input(f,abort.signal)));assert.equal(f.calls.plan,0);assert.equal(c.ledger.inspect('run')[0].state,'REVIEW_REQUIRED');assert.equal(c.ledger.getBudgetPosition('run').outstanding.llmCalls,1);
});
test('usage received after lease loss cannot settle or transfer generation',async t=>{
 const f=executionFixture(t),c=new DurableModelCallCoordinator(f.store,testModel(f.provider),clock);
 f.provider.plan=async()=>{f.release();f.acquire();return model({kind:'finish',summary:'done'});};
 await assert.rejects(c.call(input(f)),{code:'LEASE_FENCED'});assert.equal(c.ledger.inspect('run')[0].state,'DISPATCH_INTENT');assert.equal(f.snapshot().run.usage.llmCalls,0);
});
test('invalid PLAN retains settled usage with discarded response and no action',async t=>{
 const f=executionFixture(t);f.provider.plan=async()=>model({kind:'invalid'} as any);await f.runner.runOneRound('run');
 const r=new ModelCallLedger(f.store).inspect('run')[0];assert.equal(r.state,'SETTLED');assert.equal(r.application_status,'DISCARDED');assert.equal(f.calls.execute,0);
});
test('pending application refuses automatic replan under a fresh round id',async t=>{
 const f=executionFixture(t),c=new DurableModelCallCoordinator(f.store,testModel(f.provider),clock);await c.call(input(f));
 await assert.rejects(c.call({...input(f),roundKey:'different'}));assert.equal(f.calls.plan,1);
});
test('PLAN needs_user and finish create atomic application receipts',async t=>{
 for(const kind of ['needs_user','finish'] as const){const f=executionFixture(t);f.provider.plan=async()=>model(kind==='finish'?{kind,summary:'finished'}:{kind,reason:'question'});
 await f.runner.runOneRound('run');assert.equal(new ModelCallLedger(f.store).inspect('run')[0].application_status,'APPLIED');assert.notEqual(new RecoveryReader(f.db).inspect('run').disposition,'RECOVERY_FAILED');}
});
test('VERIFY event failure rolls back evaluation, criteria, session, progress and application',async t=>{
 const f=executionFixture(t);f.provider.verify=async()=>{
  f.raw().exec("CREATE TRIGGER fail_criterion BEFORE INSERT ON journal_events WHEN NEW.event_type='AcceptanceCriterionEvaluated' BEGIN SELECT RAISE(ABORT,'fault'); END");
  return model({taskOutcome:'PASS',summary:'done',criteria:[{criterion:'done',outcome:'SATISFIED'}]});
 };
 await f.runner.runOneRound('run');const rows=new ModelCallLedger(f.store).inspect('run');assert.equal(rows.find(r=>r.phase==='VERIFY')?.application_status,'PENDING_APPLICATION');
 assert.equal(f.snapshot().events.filter(e=>e.type==='EvaluationAdded').length,0);assert.equal(f.snapshot().run.usage.llmCalls,2);
});
for(const stage of ['reserve','markDispatchIntent'] as const)for(const committed of [false,true])test(`${stage} ${committed?'lost COMMIT ACK':'write failure'} cannot authorize external call`,async t=>{
 const f=executionFixture(t),c=new DurableModelCallCoordinator(f.store,testModel(f.provider),clock),original=c.ledger[stage].bind(c.ledger);
 (c.ledger as any)[stage]=(x:any)=>{if(committed)original(x);throw Error('write acknowledgement unavailable');};
 await assert.rejects(c.call(input(f)));assert.equal(f.calls.plan,0);
 if(committed)assert.equal(c.ledger.inspect('run')[0].state,stage==='reserve'?'RESERVED':'DISPATCH_INTENT');
});
test('invalid complete usage fails closed into review with no zero settlement',async t=>{
 const f=executionFixture(t);f.provider.plan=async()=>({...model({kind:'finish',summary:'done'}),usage:undefined as any});
 const c=new DurableModelCallCoordinator(f.store,testModel(f.provider),clock);await assert.rejects(c.call(input(f)));
 assert.equal(c.ledger.inspect('run')[0].state,'REVIEW_REQUIRED');assert.equal(f.snapshot().run.usage.llmCalls,0);
});
test('scheduler queue wait rechecks elapsed budget before reservation',async t=>{
 const f=executionFixture(t),scheduler=new RequestScheduler({defaultConcurrencyPerModel:1});f.provider.scheduling={provider:'test',model:'test'};
 let release!:()=>void;const held=scheduler.schedule({provider:'test',model:'test',kind:'coordination',execute:()=>new Promise<void>(r=>release=r)});
 let now=10;const runner=createDurableCoordinationRunner({coordinator:f.coordinator,supervisorProvider:testModel(f.provider),scheduler,clock:{now:()=>now}});
 const waiting=runner.runOneRound('run');now=f.snapshot().run.budget.maxWallTimeMs+100;release();await held;await waiting;
 assert.equal(f.calls.plan,0);assert.equal(new ModelCallLedger(f.store).inspect('run').length,0);
});
