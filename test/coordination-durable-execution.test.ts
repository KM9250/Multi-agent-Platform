import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DurableExecutionCoordinator, createDurableCoordinationRunner } from '../services/coordination/durable/index.ts';
import { executionFixture, clock, model, registration, record } from './durable-execution-fixture.ts';

for (const status of ['succeeded','failed'] as const) test(`${status} Result survives reconnection and finalizes atomically/idempotently without executing again`, async t => {
  const f = executionFixture(t), task = f.register(); f.executor.execute = async () => {f.calls.execute++; return {status,summary:'private-result'};};
  const result = await f.coordinator.dispatch('run',task); assert.ok(result.resultRef);
  assert.equal(f.snapshot().tasks.task.status,'ASSIGNED'); f.db.close();
  const reopened = f.open(), c = new DurableExecutionCoordinator(reopened.store,f.registry,{clock});
  assert.deepEqual(c.getResult('run',task),result); c.finalizeResult('run',task); c.finalizeResult('run',task);
  assert.equal(c.inspectExecution('run','action')!.state,'FINALIZED');
  assert.equal(reopened.store.getSnapshot('run').tasks.task.status,status==='succeeded'?'COMPLETED':'FAILED');
  assert.equal(reopened.store.getSnapshot('run').events.filter(e => e.type === (status==='succeeded'?'TaskCompleted':'TaskFailed')).length,1);
  assert.equal(reopened.store.getSnapshot('run').run.status,'RUNNING'); assert.equal(reopened.store.getSnapshot('run').run.satisfiedCriteria.length,0);
  await c.dispatch('run',task); assert.equal(f.calls.execute,1);
});
for (const where of ['journal','ledger'] as const) test(`Journal reflection rolls back with FINALIZED when ${where} update fails`, async t => {
  const f = executionFixture(t), task = f.register(); await f.coordinator.dispatch('run',task);
  f.raw().exec(where==='journal'
    ? "CREATE TRIGGER fail_finalize BEFORE INSERT ON journal_events BEGIN SELECT RAISE(ABORT,'private'); END"
    : "CREATE TRIGGER fail_finalize BEFORE UPDATE ON execution_ledger WHEN NEW.state='FINALIZED' BEGIN SELECT RAISE(ABORT,'private'); END");
  assert.throws(() => f.coordinator.finalizeResult('run',task));
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'RESULT_RECORDED'); assert.equal(f.snapshot().tasks.task.status,'ASSIGNED');
  assert.equal(f.snapshot().events.length,3); f.raw().exec('DROP TRIGGER fail_finalize');
  f.coordinator.finalizeResult('run',task); assert.equal(f.calls.execute,1);
});
test('COMMIT response loss in reservation forbids a fresh dispatch even when reservation committed', async t => {
  const f = executionFixture(t), task = f.register(), write = f.db.write.bind(f.db);
  let once = true;
  f.db.write = fn => {const value=write(fn); if(once){once=false;throw Error('lost response');}return value;};
  await assert.rejects(f.coordinator.dispatch('run',task));
  assert.equal(f.calls.execute,0); assert.equal(f.coordinator.inspectExecution('run','action')!.state,'DISPATCH_RESERVED');
  await assert.rejects(f.coordinator.dispatch('run',task)); assert.equal(f.calls.execute,0);
});
for (const stage of ['registration','result','finalize'] as const) test(`COMMIT response loss after ${stage} reuses durable identity and never repeats execution`, async t => {
  const f = executionFixture(t);
  const request = stage==='registration' ? registration(f.store) : undefined;
  const register = () => f.coordinator.registerAction(record,request!.expected,request!.sessionEvent,request!.taskEvent);
  let task = stage==='registration' ? undefined : f.register();
  if(stage==='finalize') await f.coordinator.dispatch('run',task!);
  const write=f.db.write.bind(f.db); let lost=false;
  f.db.write = fn => {
    const value=write(fn);
    const count = stage==='registration' ? f.snapshot().events.length===3
      : stage==='result' ? f.coordinator.inspectExecution('run','action')!.state==='RESULT_RECORDED'
      : f.coordinator.inspectExecution('run','action')!.state==='FINALIZED';
    if(!lost&&count){lost=true;throw Error('lost acknowledgement');}return value;
  };
  if(stage==='registration') {assert.throws(register); task=f.snapshot().tasks.task;}
  else if(stage==='result') await assert.rejects(f.coordinator.dispatch('run',task!));
  else assert.throws(() => f.coordinator.finalizeResult('run',task!));
  f.db.write=write;
  if(stage==='registration') {register(); await f.coordinator.dispatch('run',task!);}
  f.coordinator.finalizeResult('run',task!); f.coordinator.finalizeResult('run',task!);
  assert.equal(f.calls.execute,1); assert.equal(f.snapshot().events.filter(e=>e.type==='TaskCompleted').length,1);
});
test('Result save DB failure stops runUntilStop without normal Task failure, new PLAN, or side-effect replay', async t => {
  const f = executionFixture(t);
  f.raw().exec("CREATE TRIGGER fail_result BEFORE INSERT ON execution_results BEGIN SELECT RAISE(ABORT,'private'); END");
  const result=await f.runner.runUntilStop('run'); assert.equal(result.errorCode,'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.equal(f.calls.execute,1); assert.equal(f.calls.plan,1); assert.equal(f.calls.verify,0);
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'DISPATCH_RESERVED');
  assert.equal(Object.values(f.snapshot().tasks)[0].status,'ASSIGNED');
  assert.equal(f.snapshot().events.some(e=>e.type==='TaskFailed'||e.type==='ProgressRecorded'),false);
  f.raw().exec('DROP TRIGGER fail_result'); await f.runner.runUntilStop('run'); assert.equal(f.calls.execute,1);assert.equal(f.calls.plan,1);
});
for (const outcome of ['uncertain','aborted','throw','malformed'] as const) test(`${outcome} preserves uncertainty and blocks instead of VERIFY/another PLAN`, async t => {
  const f=executionFixture(t); f.executor.execute=async()=>{f.calls.execute++;if(outcome==='throw')throw Error('private');return outcome==='malformed'?{} as any:{status:outcome,summary:'raw'};};
  const result=await f.runner.runUntilStop('run');assert.equal(result.reason,'needs_user'); assert.match(f.snapshot().run.statusReason!,/^RUNNER_EXECUTION_UNCERTAIN:/);
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'REVIEW_REQUIRED'); assert.equal(f.calls.verify,0); assert.equal(f.calls.plan,1);
  f.add('WorkflowResumed',{authorization:{type:'user',reference:'manual'}});
  const task=Object.values(f.snapshot().tasks)[0]; await assert.rejects(f.coordinator.dispatch('run',task).then(()=>f.coordinator.reserveDispatch('run',task)));
  assert.equal(f.calls.execute,1);
});
for (const effectState of ['not_dispatched','applied'] as const) test(`Security Hold preserves ${effectState} metadata and first-resume contract`, async t => {
  const f=executionFixture(t); let reviewRef='';
  f.executor.execute=async(_a,c)=>{f.calls.execute++;reviewRef=`map.runner.security-review.v1:run:${c.taskId}:sha256%3A${'a'.repeat(64)}`;
    return {status:'failed',summary:'hold',safetyHold:{kind:'untrusted-content',effectState,reasonCode:'CONTENT_REVIEW_REQUIRED',reviewRef,safeSummary:'Untrusted content requires user review.'}};};
  await f.runner.runOneRound('run'); const ledger=f.coordinator.inspectExecution('run','action')!;
  assert.equal(ledger.state,'REVIEW_REQUIRED');assert.equal(ledger.result!.safetyHold!.effectState,effectState);assert.equal(f.calls.verify,0);
  assert.deepEqual(f.snapshot().events.slice(-4).map(e=>e.type),['TaskFailed','SessionResolved','ProgressRecorded','WorkflowBlocked']);
  f.add('WorkflowResumed',{authorization:{type:'user',reference:'wrong'}}); f.add('WorkflowSuspended',{}); f.add('WorkflowResumed',{authorization:{type:'user',reference:reviewRef}});
  await f.runner.runOneRound('run'); assert.equal(f.calls.plan,1); assert.equal(f.calls.execute,1); assert.equal(f.snapshot().run.status,'BLOCKED');
});
test('exact Security Review first resume allows later planning but never redispatches reviewed Action', async t => {
  const f=executionFixture(t);let reviewRef='';
  f.executor.execute=async(_a,c)=>{f.calls.execute++;reviewRef=`map.runner.security-review.v1:run:${c.taskId}:sha256%3A${'b'.repeat(64)}`;
    return {status:'failed',summary:'hold',safetyHold:{kind:'untrusted-content',effectState:'applied',reasonCode:'CONTENT_REVIEW_REQUIRED',reviewRef,safeSummary:'Untrusted content requires user review.'}};};
  await f.runner.runOneRound('run');f.add('WorkflowResumed',{authorization:{type:'user',reference:reviewRef}});
  f.provider.plan=async()=>{f.calls.plan++;return model({kind:'needs_user',reason:'Next instruction'});};
  await f.runner.runOneRound('run');assert.equal(f.calls.plan,2);assert.equal(f.calls.execute,1);
});
test('FINALIZED still performs VERIFY and Evidence failure uses existing first-resume Evidence Review', async t => {
  const f=executionFixture(t); const get=f.coordinator.getOwnedEvidence.bind(f.coordinator);let unavailable=true;
  f.coordinator.getOwnedEvidence=async(...args)=>{if(unavailable)throw Error('offline');return get(...args);};
  const first=await f.runner.runOneRound('run');assert.equal(first.reason,'needs_user');assert.equal(f.calls.execute,1);assert.equal(f.calls.verify,0);
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'FINALIZED');
  const reason=f.snapshot().run.statusReason!,ref=reason.slice('RUNNER_VERIFY_EVIDENCE_UNAVAILABLE:'.length);
  f.add('WorkflowResumed',{authorization:{type:'user',reference:'wrong'}});f.add('WorkflowSuspended',{});f.add('WorkflowResumed',{authorization:{type:'user',reference:ref}});
  unavailable=false;await f.runner.runOneRound('run');assert.equal(f.calls.verify,0);assert.equal(f.calls.execute,1);assert.equal(f.snapshot().run.statusReason,reason);
});
test('exact Evidence Review first resume retries only VERIFY and closes existing round once', async t => {
  const f=executionFixture(t), get=f.coordinator.getOwnedEvidence.bind(f.coordinator);let fail=true;
  f.coordinator.getOwnedEvidence=async(...args)=>{if(fail)throw Error('offline');return get(...args);};
  await f.runner.runOneRound('run'); const ref=f.snapshot().run.statusReason!.slice('RUNNER_VERIFY_EVIDENCE_UNAVAILABLE:'.length);
  fail=false;f.add('WorkflowResumed',{authorization:{type:'user',reference:ref}});
  assert.equal((await f.runner.runOneRound('run')).reason,'completed');assert.equal(f.calls.execute,1);assert.equal(f.calls.plan,1);assert.equal(f.calls.verify,1);
  assert.equal(f.snapshot().events.filter(e=>e.type==='ProgressRecorded').length,1);
});
test('RESULT_RECORDED remains inspectable during BLOCKED/SUSPENDED and never starts recovery automatically', async t => {
  const f=executionFixture(t),task=f.register();await f.coordinator.dispatch('run',task);f.add('WorkflowSuspended',{});
  const before=f.snapshot(),second=f.open(),c=new DurableExecutionCoordinator(second.store,f.registry,{clock});
  assert.equal(c.inspectExecution('run','action')!.state,'RESULT_RECORDED');assert.throws(()=>c.finalizeResult('run',task));
  const runner=createDurableCoordinationRunner({coordinator:c,supervisorProvider:f.provider,clock});assert.equal((await runner.runUntilStop('run')).reason,'stopped');
  assert.equal(f.calls.execute,1);assert.equal(f.calls.plan,0);assert.deepEqual(f.snapshot(),before);
});

test('manual Workflow resume after unknown execution does not clear Ledger uncertainty or create another PLAN',async t=>{
  const f=executionFixture(t);f.executor.execute=async()=>{f.calls.execute++;return {status:'uncertain',summary:'unknown'};};
  await f.runner.runOneRound('run');f.add('WorkflowResumed',{authorization:{type:'user',reference:'manual'}});
  const result=await f.runner.runUntilStop('run');assert.equal(result.errorCode,'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.equal(f.calls.execute,1);assert.equal(f.calls.plan,1);assert.equal(f.coordinator.inspectExecution('run','action')!.state,'REVIEW_REQUIRED');
});
test('stored Result digest corruption cannot finalize or trigger dispatch',async t=>{
  const f=executionFixture(t),task=f.register();await f.coordinator.dispatch('run',task);
  f.raw().exec('DROP TRIGGER execution_results_no_update');f.raw().exec("UPDATE execution_results SET result_json='{\"status\":\"failed\",\"summary\":\"changed\"}'");
  assert.throws(()=>f.coordinator.finalizeResult('run',task),{code:'INTEGRITY_ERROR'});
  await assert.rejects(f.coordinator.dispatch('run',task));assert.equal(f.calls.execute,1);assert.equal(f.snapshot().tasks.task.status,'ASSIGNED');
});
