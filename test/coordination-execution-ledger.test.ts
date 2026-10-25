import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinationRunner } from '../services/coordination/index.ts';
import { DurableExecutionCoordinator, createDurableCoordinationRunner } from '../services/coordination/durable/index.ts';
import { runnerPendingApproval } from '../services/coordination/runner/policyGuard.ts';
import { executionFixture, prepared, clock, record } from './durable-execution-fixture.ts';

test('only acknowledged reservation allows Executor dispatch and no Action can be reserved twice', async t => {
  const f = executionFixture(t), task = f.register();
  f.executor.execute = async () => { f.calls.execute++; assert.equal(f.coordinator.inspectExecution('run','action')!.state,'DISPATCH_RESERVED'); return { status:'succeeded',summary:'done' }; };
  await f.coordinator.dispatch('run',task);
  assert.equal(f.calls.execute,1); assert.equal(f.coordinator.inspectExecution('run','action')!.state,'RESULT_RECORDED');
  assert.throws(() => f.coordinator.reserveDispatch('run',task));
  await f.coordinator.dispatch('run',task); assert.equal(f.calls.execute,1);
});
test('reservation rollback prevents dispatch and leaves Journal and PREPARED unchanged', async t => {
  const f = executionFixture(t), task = f.register(), before = f.snapshot();
  f.raw().exec("CREATE TRIGGER fail_reserve BEFORE UPDATE ON execution_ledger BEGIN SELECT RAISE(ABORT,'raw'); END");
  await assert.rejects(f.coordinator.dispatch('run',task)); assert.equal(f.calls.execute,0);
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'PREPARED'); assert.deepEqual(f.snapshot(),before);
});
for (const risk of ['DENY','NEEDS_USER'] as const) test(`${risk} cannot reserve without matching authorization`, t => {
  const f = executionFixture(t,risk), task = f.register(); assert.throws(() => f.coordinator.reserveDispatch('run',task));
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'PREPARED'); assert.equal(f.calls.execute,0);
});
for (const type of ['WorkflowBlocked','WorkflowSuspended','WorkflowCancelled'] as const) test(`${type} prevents dispatch`, t => {
  const f = executionFixture(t), task = f.register(); f.add(type, type === 'WorkflowBlocked' ? { reason:'manual' } : {});
  assert.throws(() => f.coordinator.reserveDispatch('run',task)); assert.equal(f.calls.execute,0);
});
test('reservation uses exact latest Action Approval ref and rejects unrelated later resume', async t => {
  const f = executionFixture(t,'NEEDS_USER'), task = f.register(), approval = runnerPendingApproval('run',prepared);
  f.add('WorkflowBlocked',{reason:`RUNNER_NEEDS_USER:${approval.approvalRef}`});
  f.add('WorkflowResumed',{authorization:{type:'user',reference:'wrong'}});
  assert.throws(() => f.coordinator.reserveDispatch('run',task));
  f.add('WorkflowSuspended',{}); f.add('WorkflowResumed',{authorization:{type:'user',reference:approval.approvalRef}});
  const reservation = f.coordinator.reserveDispatch('run',task); assert.ok(reservation.attemptId);
  const snapshot = f.snapshot();
  assert.throws(() => f.store.writeWorkflow('run', tx => tx.run("UPDATE execution_ledger SET state='PREPARED',attempt_id=NULL,reserved_at=NULL WHERE action_id='action'")));
  assert.deepEqual(f.snapshot(),snapshot);
  await assert.rejects(f.coordinator.dispatch('run',task)); assert.equal(f.calls.execute,0);
});
for (const field of ['workflowRunId','sessionId','taskId','fingerprint','executorId'] as const) test(`reservation rejects crossed ${field}`, t => {
  const f = executionFixture(t), task = f.register();
  const crossed: any = { ...task };
  if (field === 'fingerprint') crossed.inputRefs = ['map.runner.action.v1:action:other'];
  else if (field === 'executorId') f.registry.get = () => ({ ...f.executor,id:'other' });
  else crossed[field] = 'other';
  assert.throws(() => f.coordinator.reserveDispatch('run',crossed)); assert.equal(f.calls.execute,0);
});
test('separate connections compete for exactly one reservation and preserve the original attempt', t => {
  const f = executionFixture(t), task = f.register(), second = f.open(), c = new DurableExecutionCoordinator(second.store,f.registry,{clock});
  const first = f.coordinator.reserveDispatch('run',task);
  assert.throws(() => c.reserveDispatch('run',task));
  assert.equal(c.inspectExecution('run','action')!.attemptId,first.attemptId);
});
test('durable store rejects missing or mismatched Coordinator instead of memory fallback', t => {
  const f = executionFixture(t);
  const deps = {store:f.store,supervisorProvider:f.provider,executors:f.registry,pendingActions:f.coordinator.pendingActions,evidenceStore:f.coordinator.evidenceStore};
  assert.throws(() => createCoordinationRunner(deps),/RUNNER_DURABLE_CONFIGURATION_REQUIRED/);
  assert.throws(() => createCoordinationRunner({...deps,durableExecution:f.coordinator,pendingActions:{...deps.pendingActions} as any}),/RUNNER_DURABLE_CONFIGURATION_REQUIRED/);
  assert.throws(() => createDurableCoordinationRunner({coordinator:undefined as any,supervisorProvider:f.provider}));
});
test('v1-era assigned Task without Ledger is excluded from dispatch and never repaired automatically', async t => {
  const f = executionFixture(t), {registration} = await import('./durable-execution-fixture.ts'), request = registration(f.store);
  f.store.append(request.sessionEvent); f.store.append(request.taskEvent);
  const result = await f.runner.runUntilStop('run'); assert.equal(result.errorCode,'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.equal(f.calls.execute,0); assert.equal(f.calls.plan,0); assert.equal(f.coordinator.inspectExecution('run','action'),undefined);
  assert.equal(f.snapshot().tasks.task.status,'ASSIGNED');
});

test('Policy DENY ends Task without dispatch and retained PREPARED audit proves no reservation occurred',async t=>{
  const f=executionFixture(t,'DENY');await f.runner.runOneRound('run');
  const row=f.coordinator.inspectExecution('run','action')!;assert.equal(row.state,'PREPARED');assert.equal(row.taskStatus,'FAILED');
  assert.equal(row.dispatchMayHaveOccurred,false);assert.equal(row.attemptId,undefined);assert.equal(f.calls.execute,0);
});
test('direct reservation cannot bypass first-resume Security Review using a newly prepared Action',async t=>{
  const f=executionFixture(t);let reviewRef='';
  f.executor.execute=async(_a,c)=>{reviewRef=`map.runner.security-review.v1:run:${c.taskId}:sha256%3A${'a'.repeat(64)}`;return {status:'failed',summary:'hold',safetyHold:{kind:'untrusted-content',effectState:'applied',reasonCode:'CONTENT_REVIEW_REQUIRED',reviewRef,safeSummary:'Untrusted content requires user review.'}};};
  await f.runner.runOneRound('run');f.add('WorkflowResumed',{authorization:{type:'user',reference:'wrong'}});
  f.add('WorkflowSuspended',{});f.add('WorkflowResumed',{authorization:{type:'user',reference:reviewRef}});
  const task=f.register({...record,sessionId:'second-session',taskId:'second-task',action:{...prepared,actionId:'second-action'}});
  assert.throws(()=>f.coordinator.reserveDispatch('run',task));assert.equal(f.coordinator.inspectExecution('run','second-action')!.state,'PREPARED');
});
