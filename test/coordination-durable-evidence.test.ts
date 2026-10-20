import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableExecutionCoordinator } from '../services/coordination/durable/index.ts';
import { executionFixture, record, clock, executionSeed } from './durable-execution-fixture.ts';

const owner = {workflowRunId:'run',sessionId:'session',taskId:'task',actionId:'action'};
test('Evidence requires trusted scoped owner, survives reconnection, and uses compatible global refs', async t => {
  const f = executionFixture(t), task = f.register(); f.coordinator.reserveDispatch('run',task);
  const store = f.coordinator.evidenceStore, evidence = {kind:'test',content:{data:'raw evidence'},createdAt:10};
  await assert.rejects(store.put(evidence));
  const ref = await store.withOwner(owner,() => store.put(evidence)); assert.match(ref,/^map.runner.evidence.v1:/);
  evidence.content.data = 'mutated';
  await assert.rejects(store.get(ref));
  const second = f.open(), c = new DurableExecutionCoordinator(second.store,f.registry,{clock});
  assert.equal((await c.getOwnedEvidence('run',task,ref))!.content['data'],'raw evidence');
  assert.equal(await c.getOwnedEvidence('run',task,'map.runner.evidence.v1:missing'),undefined);
});
test('concurrent async Evidence scopes never mix Workflow/Task ownership', async t => {
  const f = executionFixture(t), taskA = f.register(); f.coordinator.reserveDispatch('run',taskA);
  f.store.createWorkflow(executionSeed('ALLOW','other'));
  const r = {...record,workflowRunId:'other'}, taskB = f.register(r); f.coordinator.reserveDispatch('other',taskB);
  const store = f.coordinator.evidenceStore;
  const refs = await Promise.all([owner,{...owner,workflowRunId:'other'}].map((owned,i) => store.withOwner(owned,async () => {
    await new Promise(resolve => setImmediate(resolve));
    const ref = await store.put({kind:'test',content:{index:i},createdAt:10});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await store.get(ref))!.content['index'],i); return ref;
  })));
  assert.notEqual(refs[0],refs[1]);
  await assert.rejects(f.coordinator.getOwnedEvidence('run',taskA,refs[1]));
  await assert.rejects(f.coordinator.getOwnedEvidence('other',taskB,refs[0]));
});
test('Evidence digest mismatch blocks result recording and no dangling successful Task is committed', async t => {
  const f = executionFixture(t), task = f.register(), reservation = f.coordinator.reserveDispatch('run',task);
  const ref = await f.coordinator.evidenceStore.withOwner(owner,() => f.coordinator.evidenceStore.put({kind:'test',content:'raw',createdAt:10}));
  f.raw().exec('DROP TRIGGER runner_evidence_no_update');
  f.raw().prepare('UPDATE runner_evidence SET content_digest=? WHERE evidence_ref=?').run('wrong',ref);
  assert.throws(() => f.coordinator.recordResult('run',task,reservation.attemptId,{status:'succeeded',summary:'done',resultRef:ref}),{code:'INTEGRITY_ERROR'});
  assert.equal(f.snapshot().tasks.task.status,'ASSIGNED'); assert.equal(f.coordinator.inspectExecution('run','action')!.state,'DISPATCH_RESERVED');
});
for (const content of ['x'.repeat(1024*1024),{bad:NaN},Array.from({length:34}).reduce(v => ({nested:v}),{})]) test('oversized/deep/non-JSON Evidence is rejected atomically without raw errors', async t => {
  const f = executionFixture(t), task = f.register(); f.coordinator.reserveDispatch('run',task);
  await assert.rejects(f.coordinator.evidenceStore.withOwner(owner,() => f.coordinator.evidenceStore.put({kind:'test',content,createdAt:10})));
  assert.equal(f.raw().prepare('SELECT count(*) AS n FROM runner_evidence').get()!.n,0);
});
test('Evidence insert failure after external effect stops and reservation prevents another Executor call', async t => {
  const f = executionFixture(t);
  f.raw().exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON runner_evidence BEGIN SELECT RAISE(ABORT,'private-evidence'); END");
  const first = await f.runner.runUntilStop('run');
  assert.equal(first.errorCode,'RUNNER_DURABLE_EXECUTION_STOPPED'); assert.equal(f.calls.execute,1); assert.equal(f.calls.plan,1); assert.equal(f.calls.verify,0);
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'DISPATCH_RESERVED');
  assert.equal(Object.values(f.snapshot().tasks)[0].status,'ASSIGNED');
  f.raw().exec('DROP TRIGGER fail_evidence');
  await f.runner.runUntilStop('run'); assert.equal(f.calls.execute,1); assert.equal(f.calls.plan,1);
});
test('missing or foreign result Evidence enters REVIEW_REQUIRED instead of successful collection', async t => {
  const f = executionFixture(t); f.executor.execute = async () => {f.calls.execute++;return {status:'succeeded',summary:'done',resultRef:'map.runner.evidence.v1:missing'};};
  assert.equal((await f.runner.runUntilStop('run')).errorCode,'RUNNER_DURABLE_EXECUTION_STOPPED');
  assert.equal(f.coordinator.inspectExecution('run','action')!.state,'REVIEW_REQUIRED'); assert.equal(f.snapshot().events.some(e => e.type==='TaskCompleted'),false);
  await f.runner.runUntilStop('run'); assert.equal(f.calls.execute,1);
});

test('Result referencing another Workflow Evidence is refused and leaves both Journals unchanged',async t=>{
  const f=executionFixture(t),task=f.register(),attempt=f.coordinator.reserveDispatch('run',task);
  f.store.createWorkflow(executionSeed('ALLOW','other'));const other=f.register({...record,workflowRunId:'other'});f.coordinator.reserveDispatch('other',other);
  const ref=await f.coordinator.evidenceStore.withOwner({...owner,workflowRunId:'other'},()=>f.coordinator.evidenceStore.put({kind:'test',content:'other payload',createdAt:10}));
  assert.throws(()=>f.coordinator.recordResult('run',task,attempt.attemptId,{status:'succeeded',summary:'done',resultRef:ref}));
  assert.equal(f.snapshot().tasks.task.status,'ASSIGNED');assert.equal(f.store.getSnapshot('other').tasks.task.status,'ASSIGNED');
});

test('undefined Evidence content is rejected before a malformed envelope reaches SQLite',async t=>{
  const f=executionFixture(t),task=f.register();f.coordinator.reserveDispatch('run',task);
  await assert.rejects(f.coordinator.evidenceStore.withOwner(owner,()=>f.coordinator.evidenceStore.put({kind:'test',content:undefined,createdAt:10})));
  assert.equal(f.raw().prepare('SELECT count(*) AS n FROM runner_evidence').get()!.n,0);
});
