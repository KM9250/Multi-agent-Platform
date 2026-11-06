import assert from 'node:assert/strict';
import test from 'node:test';
import { executionFixture, model, clock } from './durable-execution-fixture.ts';
import { testModel } from './model-call-fixture.ts';
import { createTestDurableModelAdapter, DurableModelCallCoordinator } from '../services/coordination/durable/modelCallCoordinator.ts';
import { createCoordinationRunner } from '../services/coordination/runner/runner.ts';
import { runnerPlanRequest } from '../services/coordination/runner/context.ts';
import { RecoveryReader } from '../services/coordination/durable/recoveryReader.ts';
import type { RunnerClock } from '../services/coordination/runner/types.ts';
import type { WorkflowBudget } from '../services/coordination/types.ts';

type Fixture = ReturnType<typeof executionFixture>;
function setup(f: Fixture, time: RunnerClock = clock) {
  const models = new DurableModelCallCoordinator(f.store, testModel(f.provider), time);
  const runner = createCoordinationRunner({ store: f.store, supervisorProvider: f.provider,
    durableModelCalls: models, durableExecution: f.coordinator, executors: f.registry,
    evidenceStore: f.coordinator.evidenceStore, pendingActions: f.coordinator.pendingActions, clock: time });
  return { models, runner };
}
function input(f: Fixture) {
  const s = f.snapshot();
  return { workflowRunId: 'run', roundKey: 'round', phase: 'PLAN' as const,
    requestCursor: s.events.length, requestEventId: s.events.at(-1)!.eventId,
    request: runnerPlanRequest(s, 10, new AbortController().signal) };
}
const completedUsage = { llmCalls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0 };

test('F-01: PLAN at maxLlmCalls=1 discards the unusable response without pending recovery', async t => {
  const f = executionFixture(t, 'ALLOW', { maxLlmCalls: 1 }), { models, runner } = setup(f);
  const result = await runner.runUntilStop('run');
  assert.equal(result.reason, 'budget_exhausted');
  const row = models.ledger.inspect('run')[0];
  assert.equal(row.state, 'SETTLED'); assert.equal(row.application_status, 'DISCARDED');
  assert.equal(row.reason_code, 'BUDGET_EXHAUSTED'); assert.equal(f.snapshot().run.usage.llmCalls, 1);
  assert.equal(f.calls.execute, 0); assert.equal(f.calls.plan, 1);
  const recovery = new RecoveryReader(f.db).inspect('run');
  assert.equal(recovery.modelCalls!.pendingApplication, 0);
  assert.ok(!recovery.reasonCodes.includes('MODEL_CALL_REVIEW_REQUIRED'));
});

const exits = ['abort', 'suspended', 'blocked', 'cancelled', 'cursor'] as const;
for (const boundary of ['PLAN response', 'PLAN prepare', 'VERIFY response'] as const) {
  for (const exit of exits) test(`F-01: ${boundary} ${exit} closes the settled application`, async t => {
    const f = executionFixture(t), { models, runner } = setup(f), abort = new AbortController();
    const change = () => {
      if (exit === 'abort') abort.abort();
      if (exit === 'suspended') f.add('WorkflowSuspended', {});
      if (exit === 'blocked') f.add('WorkflowBlocked', { reason: 'OPERATOR_STOP' });
      if (exit === 'cancelled') f.add('WorkflowCancelled', { reason: 'OPERATOR_STOP' });
      if (exit === 'cursor') f.add('ProgressRecorded', { outcome: 'PROGRESS', summary: 'Concurrent update' });
    };
    if (boundary === 'PLAN prepare') {
      const prepare = f.executor.prepare.bind(f.executor);
      f.executor.prepare = async request => { const action = await prepare(request); change(); return action; };
    } else {
      const call = models.call.bind(models);
      models.call = async request => { const result = await call(request); if (request.phase === boundary.split(' ')[0]) change(); return result; };
    }
    await runner.runOneRound('run', { signal: abort.signal });
    const row = models.ledger.inspect('run').find(r => r.phase === boundary.split(' ')[0])!;
    assert.equal(row.state, 'SETTLED'); assert.equal(row.application_status, 'DISCARDED');
    assert.equal(row.reason_code, exit === 'abort' ? 'ABORTED' : exit === 'cursor' ? 'STALE_RESPONSE' : 'WORKFLOW_STOPPED');
    assert.equal(f.calls.plan, 1); assert.equal(f.calls.execute, boundary.startsWith('VERIFY') ? 1 : 0);
    assert.equal(f.snapshot().run.usage.llmCalls, boundary.startsWith('VERIFY') ? 2 : 1);
    assert.equal(f.snapshot().events.filter(e => e.type === 'EvaluationAdded').length, 0);
    assert.equal(new RecoveryReader(f.db).inspect('run').modelCalls!.pendingApplication, 0);
  });
}
for (const boundary of ['response', 'prepare']) test(`F-01: PLAN ${boundary} time-budget exit is discarded`, async t => {
  const f = executionFixture(t); let now = 10;
  const { models, runner } = setup(f, { now: () => now });
  const expire = () => { now = f.snapshot().run.createdAt + f.snapshot().run.budget.maxWallTimeMs; };
  if (boundary === 'response') {
    const call = models.call.bind(models); models.call = async request => { const result = await call(request); expire(); return result; };
  } else {
    const prepare = f.executor.prepare.bind(f.executor); f.executor.prepare = async request => { const result = await prepare(request); expire(); return result; };
  }
  assert.equal((await runner.runOneRound('run')).reason, 'budget_exhausted');
  assert.equal(models.ledger.inspect('run')[0].reason_code, 'BUDGET_EXHAUSTED');
  assert.equal(models.ledger.inspect('run')[0].application_status, 'DISCARDED'); assert.equal(f.calls.execute, 0);
});
test('F-01: VERIFY can apply the final allowed call without issuing another model call', async t => {
  const f = executionFixture(t, 'ALLOW', { maxLlmCalls: 2 }), { models, runner } = setup(f);
  await runner.runUntilStop('run');
  assert.ok(models.ledger.inspect('run').every(r => r.application_status === 'APPLIED'));
  assert.equal(f.calls.plan + f.calls.verify, 2); assert.equal(f.snapshot().events.filter(e => e.type === 'EvaluationAdded').length, 1);
});
test('F-01: invalid prepared action is discarded before any application transaction', async t => {
  const f = executionFixture(t), { models, runner } = setup(f);
  f.executor.prepare = async () => ({} as any);
  await runner.runOneRound('run');
  assert.equal(models.ledger.inspect('run')[0].application_status, 'DISCARDED');
  assert.equal(models.ledger.inspect('run')[0].reason_code, 'INVALID_RESPONSE'); assert.equal(f.calls.execute, 0);
});
for (const boundary of ['response', 'prepare']) test(`F-01: lease loss after PLAN ${boundary} retains pending because the old owner cannot write`, async t => {
  const f = executionFixture(t), { models, runner } = setup(f);
  if (boundary === 'response') {
    const call = models.call.bind(models); models.call = async request => { const result = await call(request); f.release(); return result; };
  } else {
    const prepare = f.executor.prepare.bind(f.executor); f.executor.prepare = async request => { const result = await prepare(request); f.release(); return result; };
  }
  assert.equal((await runner.runOneRound('run')).reason, 'error');
  assert.equal(models.ledger.inspect('run')[0].application_status, 'PENDING_APPLICATION');
  assert.equal(f.snapshot().run.usage.llmCalls, 1); assert.equal(f.calls.execute, 0);
});
test('F-01: failed discard audit retains pending and does not pretend the discard committed', async t => {
  const f = executionFixture(t, 'ALLOW', { maxLlmCalls: 1 }), { models, runner } = setup(f);
  f.raw().exec("CREATE TRIGGER fail_discard BEFORE INSERT ON runtime_audit_events WHEN NEW.event_kind='MODEL_RESPONSE_DISCARDED' BEGIN SELECT RAISE(ABORT,'fault'); END");
  assert.equal((await runner.runOneRound('run')).reason, 'error');
  assert.equal(models.ledger.inspect('run')[0].application_status, 'PENDING_APPLICATION'); assert.equal(f.calls.execute, 0);
});
test('F-01: actual usage violation discards the response while keeping the durable violation', async t => {
  const f = executionFixture(t), { models, runner } = setup(f);
  f.provider.plan = async () => ({ ...model({ kind: 'finish', summary: 'done' }), usage: { ...completedUsage, inputTokens: 2 } });
  await runner.runOneRound('run');
  const row = models.ledger.inspect('run')[0];
  assert.equal(row.application_status, 'DISCARDED'); assert.equal(row.budget_violation, 1);
  assert.equal(f.snapshot().run.usage.inputTokens, 2); assert.throws(() => models.assertCanRun('run'));
});

test('F-02: Coordinator retry after application COMMIT ACK loss returns the saved receipt exactly once', async t => {
  const f = executionFixture(t), { models } = setup(f), response = await models.call(input(f));
  const cursor = f.snapshot().events.length, atomic = f.store.atomicApplication.bind(f.store);
  let callbacks = 0, loseAck = true;
  f.store.atomicApplication = (id, fn) => { const value = atomic(id, fn); if (loseAck) { loseAck = false; throw Error('ACK lost after COMMIT'); } return value; };
  const apply = () => { callbacks++; f.add('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'Applied once' }); return 'ephemeral'; };
  assert.throws(() => models.apply('run', response.modelCallId, cursor, apply), /ACK lost/);
  const events = f.snapshot().events.length;
  const retry = models.apply('run', response.modelCallId, cursor, apply);
  assert.equal(retry.status, 'ALREADY_APPLIED'); assert.equal(retry.receipt.modelCallId, response.modelCallId);
  assert.equal(retry.receipt.startCursor, cursor); assert.equal(retry.receipt.eventId, f.snapshot().events.at(-1)!.eventId);
  assert.deepEqual(models.apply('run', response.modelCallId, cursor, apply), retry);
  assert.equal(callbacks, 1); assert.equal(f.snapshot().events.length, events); assert.equal(f.calls.plan, 1);
});
test('F-02: void callback has an explicit successful result, and conflicting receipt is rejected', async t => {
  const f = executionFixture(t), { models } = setup(f), response = await models.call(input(f)), cursor = f.snapshot().events.length;
  const result = models.apply('run', response.modelCallId, cursor, () => { f.add('ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'Void callback' }); });
  assert.equal(result.status, 'APPLIED'); if (result.status === 'APPLIED') assert.equal(result.value, undefined);
  assert.equal(models.apply('run', response.modelCallId, cursor, () => assert.fail('must not replay')).status, 'ALREADY_APPLIED');
  assert.throws(() => models.apply('run', response.modelCallId, cursor + 1, () => assert.fail('must not replay')));
});
test('F-02: Runner stops on an already-applied receipt without dispatching or replanning', async t => {
  const f = executionFixture(t), { models, runner } = setup(f), apply = models.apply.bind(models);
  models.apply = (id, callId, cursor, fn) => { apply(id, callId, cursor, fn); return apply(id, callId, cursor, fn); };
  const result = await runner.runUntilStop('run');
  assert.equal(result.reason, 'stopped'); assert.equal(result.errorCode, 'RUNNER_MODEL_APPLICATION_ALREADY_APPLIED');
  assert.equal(f.calls.plan, 1); assert.equal(f.calls.execute, 0);
  assert.equal(f.snapshot().events.filter(e => e.type === 'TaskAssigned').length, 1);
});

const limits: (keyof WorkflowBudget)[] = ['maxWallTimeMs', 'maxRounds', 'maxConsecutiveErrors', 'maxNoProgressCycles',
  'maxLlmCalls', 'maxInputTokens', 'maxOutputTokens', 'maxEstimatedCost'];
function exhaust(f: Fixture, key: keyof WorkflowBudget, time: { value: number }) {
  if (key === 'maxWallTimeMs') { time.value = f.snapshot().run.createdAt + f.snapshot().run.budget.maxWallTimeMs; return; }
  if (['maxRounds', 'maxConsecutiveErrors', 'maxNoProgressCycles'].includes(key)) {
    f.add('ProgressRecorded', { outcome: key === 'maxConsecutiveErrors' ? 'ERROR' : 'NO_PROGRESS', summary: 'Policy boundary' }); return;
  }
  f.add('UsageRecorded', { llmCalls: 1, inputTokens: key === 'maxInputTokens' ? 1 : 0,
    outputTokens: key === 'maxOutputTokens' ? 1 : 0, estimatedCost: key === 'maxEstimatedCost' ? 1 : 0, sourceRef: 'test:other-consumption' });
}
for (const limit of limits) {
  for (const boundary of ['reservation', 'intent'] as const) test(`F-03: direct Coordinator ${boundary} enforces ${limit} from committed state`, async t => {
    const f = executionFixture(t, 'ALLOW', { [limit]: 1 }), time = { value: limit === 'maxWallTimeMs' ? 1 : 10 };
    const { models } = setup(f, { now: () => time.value });
    if (boundary === 'reservation') exhaust(f, limit, time);
    else {
      const reserve = models.ledger.reserve.bind(models.ledger);
      models.ledger.reserve = request => { const row = reserve(request); exhaust(f, limit, time); return row; };
    }
    await assert.rejects(models.call(input(f)), { code: 'MODEL_BUDGET_EXHAUSTED' });
    assert.equal(f.calls.plan, 0);
    const rows = models.ledger.inspect('run'); assert.equal(rows.length, boundary === 'reservation' ? 0 : 1);
    if (rows.length) {
      assert.equal(rows[0].state, 'RESERVED'); assert.equal(models.ledger.getBudgetPosition('run').outstanding.llmCalls, 1);
      assert.equal(f.db.read(tx => tx.get('SELECT dispatch_intent_at FROM model_call_attempts')!.dispatch_intent_at), null);
    }
  });
}
test('F-03: dispatch intent does not count its own reservation twice at the exact call limit', async t => {
  const f = executionFixture(t, 'ALLOW', { maxLlmCalls: 1 }), { models } = setup(f);
  await models.call(input(f)); assert.equal(f.calls.plan, 1); assert.equal(models.ledger.inspect('run')[0].state, 'SETTLED');
});
for (const dimension of ['inputTokens', 'outputTokens', 'estimatedCost'] as const) test(`F-03: intent rechecks outstanding plus newly committed ${dimension}`, async t => {
  const f = executionFixture(t, 'ALLOW', { maxInputTokens: 3, maxOutputTokens: 3, maxEstimatedCost: 3 });
  const provider = createTestDurableModelAdapter(f.provider, { providerId: 'test', modelId: 'test', inputTokens: 2,
    maxOutputTokens: 2, maxEstimatedCost: 2, pricingId: 'test-only', conditions: 'in-memory-only' });
  const models = new DurableModelCallCoordinator(f.store, provider, clock), reserve = models.ledger.reserve.bind(models.ledger);
  models.ledger.reserve = request => {
    const row = reserve(request);
    f.add('UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0, [dimension]: 2, sourceRef: 'test:concurrent-usage' });
    return row;
  };
  await assert.rejects(models.call(input(f)), { code: 'MODEL_BUDGET_EXHAUSTED' });
  assert.equal(f.calls.plan, 0); assert.equal(models.ledger.inspect('run')[0].state, 'RESERVED');
});
