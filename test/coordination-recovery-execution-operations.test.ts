import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryReader, DurableExecutionCoordinator, ModelCallLedger, DurableModelCallCoordinator, createDurableCoordinationRunner } from '../services/coordination/durable/index.ts';
import { recoveryExecutionFixture as fixture, recoveryContents, corruptTable } from './recovery-execution-fixture.ts';
import { clock, model, registration, record } from './durable-execution-fixture.ts';
import { testModel } from './model-call-fixture.ts';
import { formatSecurityHoldReason } from '../services/coordination/runner/securityHold.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';

for (const result of ['succeeded','failed'] as const) test(`reflect saved ${result} Result atomically without a new executor call or attempt`,async t=>{
  const f=fixture(t);await f.action(result);f.reacquire();const p=f.plan('REFLECT_RECORDED_RESULT','action');f.authorize(p);
  const before=f.raw.prepare('SELECT * FROM execution_ledger').get()!,saved=f.raw.prepare('SELECT * FROM execution_results').all(),evidence=f.raw.prepare('SELECT * FROM runner_evidence').all();
  const hold=f.raw.prepare('SELECT * FROM recovery_holds').all(),receipt=f.execute(p),after=f.raw.prepare('SELECT * FROM execution_ledger').get()!;
  assert.equal(receipt.status,'COMMITTED');assert.equal(after.state,'FINALIZED');assert.equal(after.attempt_id,before.attempt_id);assert.equal(after.result_ref,before.result_ref);
  assert.deepEqual(f.raw.prepare('SELECT * FROM execution_results').all(),saved);assert.deepEqual(f.raw.prepare('SELECT * FROM runner_evidence').all(),evidence);assert.deepEqual(f.raw.prepare('SELECT * FROM recovery_holds').all(),hold);
  assert.equal(f.store.getSnapshot('run').tasks.task.status,result==='succeeded'?'COMPLETED':'FAILED');assert.equal(f.calls.execute,1);
  const contents=recoveryContents(f.raw);assert.deepEqual(f.execute(p),receipt);assert.deepEqual(recoveryContents(f.raw),contents);
});
for(const fault of ['result-digest','evidence','action-owner','attempt-owner','task-owner'] as const)test(`saved Result ${fault} corruption cannot be planned or reflected`,async t=>{
  const f=fixture(t);await f.action();f.reacquire();const p=f.plan('REFLECT_RECORDED_RESULT','action');f.authorize(p);
  if(fault==='result-digest')corruptTable(f.raw,'execution_results',"UPDATE execution_results SET result_digest=?",'0'.repeat(64));
  if(fault==='evidence')corruptTable(f.raw,'runner_evidence',"UPDATE runner_evidence SET content_digest=?",'0'.repeat(64));
  if(fault==='action-owner')corruptTable(f.raw,'execution_results',"UPDATE execution_results SET action_id='other'");
  if(fault==='attempt-owner')corruptTable(f.raw,'execution_results',"UPDATE execution_results SET attempt_id='other'");
  if(fault==='task-owner')corruptTable(f.raw,'execution_results',"UPDATE execution_results SET task_id='other'");
  const before=recoveryContents(f.raw);assert.throws(()=>f.execute(p));assert.deepEqual(recoveryContents(f.raw),before);assert.equal(f.calls.execute,1);
});
test('cross-workflow Plan target cannot reuse another workflow Result',async t=>{
  const f=fixture(t);await f.action();f.reacquire();
  assert.throws(()=>f.rebind().planner.createPlan({workflowRunId:'other',operationKind:'REFLECT_RECORDED_RESULT',targetId:'action'},f.credential));assert.equal(f.calls.execute,1);
});
test('already reflected TaskCompleted cannot become a second result-reflection operation',async t=>{
  const f=fixture(t);await f.action('succeeded',1);f.reacquire();const before=recoveryContents(f.raw);
  assert.throws(()=>f.plan('REFLECT_RECORDED_RESULT','action'));assert.deepEqual(recoveryContents(f.raw),before);assert.equal(f.calls.execute,1);
});
for(const status of ['WorkflowBlocked','WorkflowSuspended'] as const)test(`${status} never gets implicitly resumed for Result reflection`,async t=>{
  const f=fixture(t);await f.action();f.store.append(createRunnerEvent(f.store.getSnapshot('run'),status,status==='WorkflowBlocked'?{reason:'operator stop'}:{},clock,{nextId:()=>status}));f.held();
  const before=recoveryContents(f.raw);assert.throws(()=>f.plan('REFLECT_RECORDED_RESULT','action'));assert.deepEqual(recoveryContents(f.raw),before);
});
for(const table of ['journal_events','execution_ledger'])test(`result reflection ${table} failure rolls back all execution records`,async t=>{
  const f=fixture(t);await f.action();f.reacquire();const p=f.plan('REFLECT_RECORDED_RESULT','action');f.authorize(p);const before=recoveryContents(f.raw);
  f.raw.exec(`CREATE TRIGGER reject_result BEFORE ${table==='journal_events'?'INSERT':'UPDATE'} ON ${table} BEGIN SELECT RAISE(ABORT,'fault'); END`);
  assert.throws(()=>f.execute(p));assert.deepEqual(recoveryContents(f.raw),before);
});
test('cancel unsent reservation preserves old-generation Ledger and recovers precisely its effective budget once',t=>{
  const f=fixture(t),x=f.reserve(),old=f.lease.generation;const ledgerRows=f.raw.prepare('SELECT * FROM model_call_ledger').all(),attempts=f.raw.prepare('SELECT * FROM model_call_attempts').all();
  const budgetBefore=new ModelCallLedger(f.store,clock).getBudgetPosition('run');assert.deepEqual(budgetBefore.outstanding,{llmCalls:1,inputTokens:5,outputTokens:7,costMicros:11});
  f.reacquire();assert.notEqual(f.lease.generation,old);const p=f.plan();f.authorize(p);f.execute(p);
  assert.deepEqual(f.raw.prepare('SELECT * FROM model_call_ledger').all(),ledgerRows);assert.deepEqual(f.raw.prepare('SELECT * FROM model_call_attempts').all(),attempts);
  const resolution=f.raw.prepare('SELECT * FROM recovery_model_resolutions WHERE model_call_id=?').get(x.modelCallId)!;assert.equal(resolution.resolution_kind,'CANCELLED_UNSENT');
  const budgetAfter=new ModelCallLedger(f.store,clock).getBudgetPosition('run');assert.deepEqual(budgetAfter.outstanding,{llmCalls:0,inputTokens:0,outputTokens:0,costMicros:0});assert.deepEqual(budgetAfter.committed,budgetBefore.committed);
  assert.throws(()=>f.plan());f.execute(p);assert.deepEqual(new ModelCallLedger(f.store,clock).getBudgetPosition('run'),budgetAfter);
  const inspection=new RecoveryReader(f.db).inspect('run');assert.notEqual(inspection.disposition,'RECOVERY_FAILED');assert.equal(inspection.executionAllowed,false);assert.equal(inspection.executable,false);
});
for(const state of ['DISPATCH_INTENT','REVIEW_REQUIRED'] as const)test(`model ${state} cannot have its reservation cancelled`,t=>{
  const f=fixture(t),x=f.reserve(),ledger=new ModelCallLedger(f.store,clock);ledger.markDispatchIntent(x);if(state==='REVIEW_REQUIRED')ledger.markReviewRequired(x,'UNKNOWN');f.reacquire();
  const before=recoveryContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(recoveryContents(f.raw),before);assert.equal(new ModelCallLedger(f.store,clock).getBudgetPosition('run').outstanding.llmCalls,1);
});
for(const mutation of ["UPDATE model_call_attempts SET dispatch_intent_at=1","UPDATE model_call_attempts SET attempt_number=2","UPDATE model_call_attempts SET attempt_id='wrong'"])test(`reserved model with inconsistent attempt is not cancelable: ${mutation}`,t=>{
  const f=fixture(t);f.reserve();f.reacquire();corruptTable(f.raw,'model_call_attempts',mutation);const before=recoveryContents(f.raw);assert.throws(()=>f.plan());assert.deepEqual(recoveryContents(f.raw),before);
});
test('discard settled response preserves COMPLETE Usage and pending historical Ledger, prevents same-generation application',t=>{
  const f=fixture(t),x=f.settled();f.held();const original=f.raw.prepare('SELECT * FROM model_call_ledger').all(),attempts=f.raw.prepare('SELECT * FROM model_call_attempts').all();
  const usage=f.raw.prepare("SELECT * FROM journal_events WHERE event_type='UsageRecorded'").all(),budget=new ModelCallLedger(f.store,clock).getBudgetPosition('run');
  const p=f.plan('DISCARD_SETTLED_RESPONSE','model');f.authorize(p);f.execute(p);
  assert.deepEqual(f.raw.prepare('SELECT * FROM model_call_ledger').all(),original);assert.deepEqual(f.raw.prepare('SELECT * FROM model_call_attempts').all(),attempts);assert.deepEqual(f.raw.prepare("SELECT * FROM journal_events WHERE event_type='UsageRecorded'").all(),usage);
  assert.equal(f.raw.prepare('SELECT resolution_kind FROM recovery_model_resolutions').get()!.resolution_kind,'DISCARDED_BY_RECOVERY');assert.deepEqual(new ModelCallLedger(f.store,clock).getBudgetPosition('run'),budget);
  let applied=0;const apply=()=>{applied++;};const ledger=new ModelCallLedger(f.store,clock),cursor=f.store.getSnapshot('run').events.length;
  assert.throws(()=>ledger.markApplied(x,cursor,apply));assert.throws(()=>f.store.atomicApplication('run',tx=>f.db.commitModelApplication(tx,x,cursor,apply)));assert.equal(applied,0);
  assert.equal(f.raw.prepare('SELECT application_status FROM model_call_ledger').get()!.application_status,'PENDING_APPLICATION');
  assert.equal(new RecoveryReader(f.db).inspect('run').executionAllowed,false);
});
test('discard cannot erase a response with business events after settlement or an application receipt',t=>{
  const f=fixture(t);f.settled();f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'ProgressRecorded',{outcome:'ERROR',summary:'interleaved change'},clock,{nextId:()=> 'partial-application'}));f.held();
  assert.throws(()=>f.plan('DISCARD_SETTLED_RESPONSE','model'));assert.equal(f.raw.prepare('SELECT count(*) AS n FROM recovery_model_resolutions').get()!.n,0);
});
for(const prefix of [0,1,2,3])test(`complete uncertain safety stop from ${prefix} existing prefix events without claiming known external outcome`,async t=>{
  const f=fixture(t);await f.action('uncertain',prefix);f.reacquire();const original=f.raw.prepare('SELECT * FROM execution_results').all(),ledger=f.raw.prepare('SELECT * FROM execution_ledger').get()!;
  const p=f.plan('COMPLETE_SAFETY_STOP','action');f.authorize(p);const before=f.store.getSnapshot('run').events.length;const receipt=f.execute(p),snapshot=f.store.getSnapshot('run');
  assert.equal(snapshot.events.length-before,4-prefix);assert.equal(snapshot.tasks.task.status,'FAILED');assert.equal(snapshot.tasks.task.failureReason,'EXECUTION_UNCERTAIN');
  assert.equal(snapshot.sessions.session.state,'RESOLVED');assert.equal(snapshot.run.status,'BLOCKED');assert.equal(snapshot.run.statusReason,'RUNNER_EXECUTION_UNCERTAIN:action');
  assert.deepEqual(f.raw.prepare('SELECT * FROM execution_results').all(),original);assert.equal(f.raw.prepare('SELECT state FROM execution_ledger').get()!.state,'REVIEW_REQUIRED');
  assert.equal(f.raw.prepare('SELECT attempt_id FROM execution_ledger').get()!.attempt_id,ledger.attempt_id);assert.equal(f.calls.execute,1);
  const saved=recoveryContents(f.raw);assert.deepEqual(f.execute(p),receipt);assert.deepEqual(recoveryContents(f.raw),saved);assert.throws(()=>f.store.assertRecoveryExecution('run'),{code:'RECOVERY_HELD'});
});
test('a fully committed uncertain stop is not offered or recorded twice',async t=>{
  const f=fixture(t);await f.action('uncertain',4);f.reacquire();const before=recoveryContents(f.raw);assert.throws(()=>f.plan('COMPLETE_SAFETY_STOP','action'));assert.deepEqual(recoveryContents(f.raw),before);
});
test('uncertain stop refuses conflicting journal suffix instead of filling an ambiguous prefix',async t=>{
  const f=fixture(t);await f.action('uncertain',1);f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'ProgressRecorded',{outcome:'ERROR',summary:'unrelated'},clock,{nextId:()=> 'unrelated'}));f.reacquire();
  assert.throws(()=>f.plan('COMPLETE_SAFETY_STOP','action'));assert.equal(f.calls.execute,1);
});
test('Security Review cannot masquerade as a generic uncertain-safety-stop candidate',async t=>{
  const f=fixture(t);await f.action('uncertain');f.reacquire();corruptTable(f.raw,'execution_ledger',"UPDATE execution_ledger SET review_reason='SECURITY_REVIEW_REQUIRED'");
  const before=recoveryContents(f.raw);assert.throws(()=>f.plan('COMPLETE_SAFETY_STOP','action'));assert.deepEqual(recoveryContents(f.raw),before);
});
test('resolved model reservation never resumes Runner, calls a model, or permits direct Action dispatch',async t=>{
  const f=fixture(t),x=f.reserve();f.reacquire();const p=f.plan();f.authorize(p);f.execute(p);let modelCalls=0;
  const provider=testModel({plan:async()=>{modelCalls++;return model({kind:'needs_user',reason:'unexpected'});},verify:async()=>{modelCalls++;return model({taskOutcome:'FAIL',summary:'unexpected',criteria:[]});}});
  const coordinator=new DurableExecutionCoordinator(f.store,{get:()=>undefined},{clock});assert.throws(()=>coordinator.reserveDispatch('run',{} as never),{code:'RECOVERY_HELD'});
  assert.throws(()=>new ModelCallLedger(f.store,clock).markDispatchIntent(x));
  const modelCoordinator=new DurableModelCallCoordinator(f.store,provider,clock);await assert.rejects(modelCoordinator.call({workflowRunId:'run',roundKey:'new',phase:'PLAN',requestCursor:1,requestEventId:'x',request:{} as never}));
  const runner=createDurableCoordinationRunner({coordinator,supervisorProvider:provider,clock}),before=f.store.getSnapshot('run');await runner.runOneRound('run');await runner.runUntilStop('run');
  assert.equal(modelCalls,0);assert.deepEqual(f.store.getSnapshot('run'),before);
});

for(const effectState of ['not_dispatched','applied'] as const)test(`a genuine Security Review (${effectState}) remains required and is never a safety-stop candidate`,async t=>{
  const f=fixture(t),reviewRef=`map.runner.security-review.v1:run:task:sha256%3A${'a'.repeat(64)}`;let calls=0;
  const coordinator=new DurableExecutionCoordinator(f.store,{get:()=>({id:'test',prepare:async()=>record.action,execute:async()=>{calls++;return {status:'failed' as const,summary:'content requires review',safetyHold:{kind:'untrusted-content' as const,effectState,reasonCode:'CONTENT_REVIEW_REQUIRED',reviewRef,safeSummary:'Untrusted content requires user review.'}};}})},{clock});
  const request=registration(f.store);coordinator.registerAction(record,request.expected,request.sessionEvent,request.taskEvent);const task=f.store.getSnapshot('run').tasks.task;
  await coordinator.dispatch('run',task);coordinator.finalizeResult('run',task);
  f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'SessionResolved',{outcome:'FAILED'},clock,{nextId:()=> 'security-resolved'},{sessionId:'session'}));
  f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'ProgressRecorded',{outcome:'ERROR',summary:'Runner round error.'},clock,{nextId:()=> 'security-progress'}));
  f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowBlocked',{reason:formatSecurityHoldReason({reviewRef,effectState})},clock,{nextId:()=> 'security-block'}));
  f.reacquire();const before=recoveryContents(f.raw);
  const inspection=new RecoveryReader(f.db,clock).inspect('run');assert.ok(inspection.authorizationRequirements.some(r=>r.kind==='SECURITY_REVIEW'&&!r.satisfied));
  assert.throws(()=>f.plan('COMPLETE_SAFETY_STOP','action'));assert.throws(()=>f.plan('REFLECT_RECORDED_RESULT','action'));assert.deepEqual(recoveryContents(f.raw),before);assert.equal(calls,1);
});
