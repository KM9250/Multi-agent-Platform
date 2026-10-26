import { bypassFencingForCorruption } from './durable-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { createRunnerEvent, evaluateCommitmentGate } from '../services/coordination/index.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import { formatSecurityHoldReason } from '../services/coordination/runner/securityHold.ts';
import { verifyEvidenceReviewRef } from '../services/coordination/runner/verifyEvidenceReview.ts';
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
  const f = executionFixture(t), task = f.register(), write = f.store.writeWorkflow.bind(f.store);
  let once = true;
  f.store.writeWorkflow = (id, fn) => {const value=write(id, fn); if(once){once=false;throw Error('lost response');}return value;};
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
  const write=f.store.writeWorkflow.bind(f.store); let lost=false;
  f.store.writeWorkflow = (id, fn) => {
    const value=write(id, fn);
    const count = stage==='registration' ? f.snapshot().events.length===3
      : stage==='result' ? f.coordinator.inspectExecution('run','action')!.state==='RESULT_RECORDED'
      : f.coordinator.inspectExecution('run','action')!.state==='FINALIZED';
    if(!lost&&count){lost=true;throw Error('lost acknowledgement');}return value;
  };
  if(stage==='registration') {assert.throws(register); task=f.snapshot().tasks.task;}
  else if(stage==='result') await assert.rejects(f.coordinator.dispatch('run',task!));
  else assert.throws(() => f.coordinator.finalizeResult('run',task!));
  f.store.writeWorkflow=write;
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


// Reconstruct prefixes committed by the previous implementation, not by the new atomic completion.
async function partialUncertain(t: TestContext, stage: 'task' | 'session' | 'progress' | 'block' = 'task') {
  const f = executionFixture(t), task = f.register();
  f.executor.execute = async () => { f.calls.execute++; return { status: 'uncertain', summary: 'unknown' }; };
  await f.coordinator.dispatch('run', task); f.coordinator.finalizeResult('run', task);
  const legacy = (type: Parameters<typeof createRunnerEvent>[1], payload: unknown, sessionId?: string, idempotencyKey?: string) =>
    f.store.append(createRunnerEvent(f.snapshot(), type, payload, clock,
      { nextId: () => `legacy-${f.snapshot().events.length}` }, { sessionId, idempotencyKey }));
  if (stage !== 'task') legacy('SessionResolved', { outcome: 'FAILED' }, 'session', 'runner:run:round:resolve');
  if (stage === 'progress' || stage === 'block') legacy('ProgressRecorded', { outcome: 'ERROR', summary: 'Runner round error.' }, undefined, 'runner:run:round:progress');
  if (stage === 'block') legacy('WorkflowBlocked', { reason: 'RUNNER_EXECUTION_UNCERTAIN:action' });
  const ledger = () => f.db.read(tx => tx.get("SELECT * FROM execution_ledger WHERE workflow_run_id = 'run' AND action_id = 'action'"));
  return { ...f, legacy, ledger };
}
for (const stage of ['task','session','progress'] as const) test(`explicit Runner completes legacy uncertain ${stage} prefix without PLAN, Executor or duplicate usage`, async t => {
  const f = await partialUncertain(t, stage), before = f.snapshot(), ledger = f.ledger();
  const result = await f.runner.runUntilStop('run');
  assert.equal(result.reason, 'needs_user'); assert.equal(result.roundsCompleted, stage === 'progress' ? 0 : 1);
  const after = f.snapshot(); assert.equal(after.run.statusReason, 'RUNNER_EXECUTION_UNCERTAIN:action');
  assert.deepEqual(after.events.slice(0, before.events.length), before.events); assert.deepEqual(f.ledger(), ledger);
  for (const type of ['TaskFailed','SessionResolved','ProgressRecorded','WorkflowBlocked']) assert.equal(after.events.filter(e => e.type === type).length, 1);
  assert.equal(after.run.usage.rounds, 1); assert.equal(after.run.usage.consecutiveErrors, 1);
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 0); assert.equal(f.calls.verify, 0);
  for (let i = 0; i < 3; i++) { f.coordinator.completeUncertainBlock('run'); await f.runner.runOneRound('run'); }
  assert.deepEqual(f.snapshot(), after); assert.deepEqual(f.ledger(), ledger);
});
test('legacy unkeyed WorkflowBlocked and later user resume never create a second block', async t => {
  const f = await partialUncertain(t, 'block'), before = f.snapshot(), ledger = f.ledger();
  assert.equal(f.coordinator.completeUncertainBlock('run'), undefined); assert.deepEqual(f.snapshot(), before);
  f.add('WorkflowResumed', { authorization: { type: 'user', reference: 'manual' } }); const resumed = f.snapshot();
  assert.equal((await f.runner.runUntilStop('run')).errorCode, 'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.deepEqual(f.snapshot(), resumed); assert.deepEqual(f.ledger(), ledger); assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 0);
});
for (const failure of ['SessionResolved','ProgressRecorded','WorkflowBlocked'] as const) test(`uncertain completion rollback at ${failure} retains prior TaskFailed and allows a later explicit retry`, async t => {
  const f = await partialUncertain(t), before = f.snapshot(), ledger = f.ledger();
  f.raw().exec(`CREATE TRIGGER fail_uncertain BEFORE INSERT ON journal_events WHEN NEW.event_type='${failure}' BEGIN SELECT RAISE(ABORT,'private'); END`);
  assert.equal((await f.runner.runOneRound('run')).errorCode, 'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.ledger(), ledger);
  f.raw().exec('DROP TRIGGER fail_uncertain'); assert.equal((await f.runner.runOneRound('run')).reason, 'needs_user');
  assert.equal(f.snapshot().run.usage.rounds, 1); assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 0);
});
test('lost completion COMMIT acknowledgement reuses the committed block and unchanged Ledger', async t => {
  const f = await partialUncertain(t), ledger = f.ledger(), write = f.store.writeWorkflow.bind(f.store);
  f.store.writeWorkflow = (id, fn) => { const result = write(id, fn); throw Error('lost response'); };
  assert.throws(() => f.coordinator.completeUncertainBlock('run')); f.store.writeWorkflow = write;
  const after = f.snapshot(); assert.equal(after.run.status, 'BLOCKED');
  await f.runner.runOneRound('run'); f.coordinator.completeUncertainBlock('run');
  assert.deepEqual(f.snapshot(), after); assert.deepEqual(f.ledger(), ledger); assert.equal(f.calls.execute, 1);
});
test('another Round progress cannot satisfy this uncertain Round progress', async t => {
  const f = await partialUncertain(t, 'session');
  f.legacy('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'Different round.' }, undefined, 'runner:run:other-round:progress');
  await f.runner.runOneRound('run');
  const progress = f.snapshot().events.filter(e => e.type === 'ProgressRecorded');
  assert.equal(progress.length, 2); assert.equal(progress[1].idempotencyKey, 'runner:run:round:progress');
  assert.equal((progress[1].payload as any).outcome, 'ERROR'); assert.equal(f.snapshot().run.usage.rounds, 2);
});
for (const mismatch of ['resolve key','progress content','progress order','block content'] as const) test(`uncertain completion rejects mismatched ${mismatch} without repairing Journal or Ledger`, async t => {
  const f = await partialUncertain(t);
  if (mismatch === 'resolve key') f.legacy('SessionResolved', { outcome: 'FAILED' }, 'session', 'runner:run:other-round:resolve');
  if (mismatch === 'progress content') {
    f.legacy('SessionResolved', { outcome: 'FAILED' }, 'session', 'runner:run:round:resolve');
    f.legacy('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'wrong' }, undefined, 'runner:run:round:progress');
  }
  if (mismatch === 'progress order') f.legacy('ProgressRecorded', { outcome: 'ERROR', summary: 'Runner round error.' }, undefined, 'runner:run:round:progress');
  if (mismatch === 'block content') f.legacy('UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, undefined, 'runner:run:round:execution-uncertain-block:action');
  const before = f.snapshot(), ledger = f.ledger();
  assert.throws(() => f.coordinator.completeUncertainBlock('run'), { code: 'INTEGRITY_ERROR' });
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.ledger(), ledger); assert.equal(f.calls.execute, 1);
});
for (const stop of ['WorkflowSuspended','WorkflowBlocked','WorkflowCancelled'] as const) test(`uncertain completion never overrides ${stop}`, async t => {
  const f = await partialUncertain(t); f.add(stop, stop === 'WorkflowBlocked' ? { reason: 'another review' } : {});
  const before = f.snapshot(), ledger = f.ledger(); f.coordinator.completeUncertainBlock('run'); await f.runner.runOneRound('run');
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.ledger(), ledger); assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 0);
  if (stop === 'WorkflowSuspended') {
    f.add('WorkflowResumed', { authorization: { type: 'user', reference: 'manual' } });
    assert.equal((await f.runner.runOneRound('run')).reason, 'needs_user'); assert.equal(f.snapshot().run.statusReason, 'RUNNER_EXECUTION_UNCERTAIN:action');
  }
});
test('uncertain completion cannot alter a terminal RESOLVED Workflow', async t => {
  const f = await partialUncertain(t, 'progress');
  f.add('AcceptanceCriterionEvaluated', { criterion: 'done', outcome: 'SATISFIED', evidenceEventIds: [f.snapshot().events.find(e => e.type === 'TaskFailed')!.eventId] });
  f.add('PolicyEvaluated', { scope: 'commitment', result: evaluateCommitmentGate(f.snapshot(), 10) });
  f.add('CommitmentRequested', { commitmentId: 'legacy-commitment', summary: 'legacy' });
  f.add('CommitmentAccepted', { commitmentId: 'legacy-commitment' });
  const before = f.snapshot(); assert.equal(before.run.status, 'RESOLVED');
  f.coordinator.completeUncertainBlock('run'); await f.runner.runOneRound('run'); assert.deepEqual(f.snapshot(), before);
});
test('uncertain completion is Workflow-scoped even when another Workflow reuses Action IDs', async t => {
  const f = await partialUncertain(t); f.store.createWorkflow(executionSeed('ALLOW', 'other')); const other = f.forWorkflow('other'); other.register({ ...record, workflowRunId: 'other' });
  const before = f.store.getSnapshot('other'); assert.equal(other.coordinator.completeUncertainBlock('other'), undefined);
  assert.deepEqual(f.store.getSnapshot('other'), before); assert.throws(() => f.coordinator.completeUncertainBlock('missing'), { code: 'LEASE_FENCED' });
  await f.runner.runOneRound('run'); assert.deepEqual(f.store.getSnapshot('other'), before);
});
test('uncertain completion refuses foreign Ledger ownership without adding any Event', async t => {
  const f = await partialUncertain(t); f.store.createWorkflow(executionSeed('ALLOW', 'other'));
  const other = f.forWorkflow('other');
  const raw = f.raw(); bypassFencingForCorruption(raw); raw.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER ledger_transition'); raw.exec("UPDATE execution_ledger SET workflow_run_id='other'");
  const before = f.store.getSnapshot('other'); assert.throws(() => other.coordinator.completeUncertainBlock('other'), { code: 'INTEGRITY_ERROR' });
  assert.deepEqual(f.store.getSnapshot('other'), before);
});
test('uncertain Result without TaskFailed still uses normal finalization and then completes the safety stop', async t => {
  const f = executionFixture(t), task = f.register(); f.executor.execute = async () => { f.calls.execute++; return { status: 'uncertain', summary: 'unknown' }; };
  await f.coordinator.dispatch('run', task); const before = f.snapshot();
  assert.equal(f.coordinator.completeUncertainBlock('run'), undefined); assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.runner.runOneRound('run')).reason, 'needs_user'); assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 0);
});

for (const review of ['security','evidence'] as const) test(`existing ${review} first-resume Review takes priority over uncertain completion`, async t => {
  const f = await partialUncertain(t, 'progress'); let reason: string, ref: string;
  if (review === 'security') {
    const r = { ...record, sessionId: 'review-session', taskId: 'review-task', action: { ...record.action, actionId: 'review-action' } };
    const request = registration(f.store, r, 'review-round'); f.coordinator.registerAction(r, request.expected, request.sessionEvent, request.taskEvent);
    ref = `map.runner.security-review.v1:run:review-task:sha256%3A${'a'.repeat(64)}`;
    reason = formatSecurityHoldReason({ reviewRef: ref, effectState: 'applied' });
    f.legacy('TaskFailed', { taskId: r.taskId, failureReason: reason }, r.sessionId);
    f.legacy('SessionResolved', { outcome: 'FAILED' }, r.sessionId, 'runner:run:review-round:resolve');
  } else {
    ref = verifyEvidenceReviewRef('run', 'task', 'existing-review'); reason = `RUNNER_VERIFY_EVIDENCE_UNAVAILABLE:${ref}`;
  }
  f.add('WorkflowBlocked', { reason }); f.add('WorkflowResumed', { authorization: { type: 'user', reference: 'wrong-first-resume' } });
  f.add('WorkflowSuspended', {}); f.add('WorkflowResumed', { authorization: { type: 'user', reference: ref } });
  const before = f.snapshot(), ledger = f.ledger();
  assert.throws(() => f.coordinator.completeUncertainBlock('run'), { code: 'INTEGRITY_ERROR' }); assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.runner.runUntilStop('run')).reason, 'needs_user'); assert.equal(f.snapshot().run.statusReason, reason);
  assert.equal(f.snapshot().events.filter(e => e.type === 'WorkflowBlocked' && (e.payload as any).reason === 'RUNNER_EXECUTION_UNCERTAIN:action').length, 0);
  assert.deepEqual(f.ledger(), ledger); assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 0); assert.equal(f.calls.verify, 0);
});
test('uncertainty completion precedes an otherwise satisfied commitment gate', async t => {
  const f = await partialUncertain(t, 'progress');
  f.add('AcceptanceCriterionEvaluated', { criterion: 'done', outcome: 'SATISFIED', evidenceEventIds: [f.snapshot().events.find(e => e.type === 'TaskFailed')!.eventId] });
  assert.equal(evaluateCommitmentGate(f.snapshot(), 10).allowed, true);
  await f.runner.runUntilStop('run'); assert.equal(f.snapshot().run.status, 'BLOCKED');
  assert.equal(f.snapshot().events.some(e => e.type === 'CommitmentAccepted' || e.type === 'PolicyEvaluated'), false);
});
test('completion uses consecutive sequences and monotonic event times even when the clock moves backwards', async t => {
  const f = await partialUncertain(t); f.legacy('UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
  const c = new DurableExecutionCoordinator(f.store, f.registry, { clock: { now: () => 2 } }); const n = f.snapshot().events.length;
  c.completeUncertainBlock('run'); const added = f.snapshot().events.slice(n);
  assert.deepEqual(added.map(e => e.sequence), [n + 1,n + 2,n + 3]); assert.ok(added.every(e => e.timestamp >= 10));
});
test('a REVIEW_REQUIRED record without a saved Result is never synthesized into an uncertain stop', async t => {
  const f = executionFixture(t), task = f.register(); f.coordinator.reserveDispatch('run', task); f.coordinator.requireReview('run', task, 'EXECUTION_UNCERTAIN');
  const before = f.snapshot(); assert.throws(() => f.coordinator.completeUncertainBlock('run'), { code: 'INTEGRITY_ERROR' });
  assert.equal((await f.runner.runOneRound('run')).errorCode, 'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.deepEqual(f.snapshot(), before); assert.equal(f.calls.execute, 0); assert.equal(f.calls.plan, 0);
});
