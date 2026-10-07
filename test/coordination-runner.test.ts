import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkflow, createCoordinationRunner, createRunnerEvent, validateCoordinationSnapshot,
  InMemoryCoordinationRunnerStore, InMemoryRunnerPendingActionStore, InMemoryRunnerEvidenceStore,
  RUNNER_PROVIDER_SYSTEM_CONTRACT,
} from '../services/coordination/index.ts';
import type {
  CoordinationPolicy, CoordinationEventType, CoordinationSnapshot, RunnerPlanProposal, RunnerVerification,
  RunnerSupervisorProvider, RunnerActionExecutor, RunnerExecutionResult, RunnerModelResult, RunnerModelUsage,
  PreparedRunnerAction, RunnerPendingActionRecord, CoordinationRunner, CoordinationRunnerDependencies, RunnerPlanRequest, RunnerVerifyRequest,
} from '../services/coordination/index.ts';
import { RequestScheduler } from '../services/scheduler/index.ts';

const policy: CoordinationPolicy = {
  policyId: 'policy', version: '1', schemaVersion: 1,
  budgets: { maxWallTimeMs: 10000, maxRounds: 5, maxLlmCalls: 20, maxInputTokens: 1000, maxOutputTokens: 1000, maxEstimatedCost: 10, maxConsecutiveErrors: 3, maxNoProgressCycles: 3 },
  riskRules: { read: 'ALLOW', write: 'NEEDS_USER', prohibited: 'DENY' },
  completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true },
  schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
};
const usage: RunnerModelUsage = { llmCalls: 1, inputTokens: 3, outputTokens: 2, estimatedCost: 0.01 };
const modelResult = <T>(value: T, consumed = usage): RunnerModelResult<T> => ({ value, usage: consumed, provider: 'fake', model: 'test', latencyMs: 1 });
const plan: Extract<RunnerPlanProposal, { kind: 'execute' }> = { kind: 'execute', objective: 'Process the item', action: { executorId: 'executor', operation: 'read', arguments: { secret: 'private-form-value' } } };
const pass: RunnerVerification = { taskOutcome: 'PASS', summary: 'Verified.', criteria: [{ criterion: 'done', outcome: 'SATISFIED' }] };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options: { mode?: 'interactive' | 'supervised_autonomous'; criteria?: string[]; budget?: Partial<CoordinationPolicy['budgets']>; actionClass?: string; result?: RunnerExecutionResult; verification?: RunnerVerification; proposal?: RunnerPlanProposal } = {}) {
  let tick = 10, serial = 0, actionSerial = 0;
  const ids = { nextId: (kind: string) => `${kind}-${++serial}` };
  const clock = { now: () => tick };
  const snapshot = createWorkflow({ runId: 'run', roomId: 'room', goal: 'Complete the goal', acceptanceCriteria: options.criteria ?? ['done'],
    supervisorAgentId: 'supervisor', participantAgentIds: ['supervisor', 'worker'], executionMode: options.mode ?? 'supervised_autonomous',
    policy: { ...policy, budgets: { ...policy.budgets, ...options.budget } }, now: 1 });
  const store = new InMemoryCoordinationRunnerStore([snapshot]);
  const pendingActions = new InMemoryRunnerPendingActionStore(); const evidenceStore = new InMemoryRunnerEvidenceStore(ids);
  const plans: Array<RunnerPlanProposal | Error> = []; const verifications: Array<RunnerVerification | Error> = [];
  const calls = { plan: 0, prepare: 0, execute: 0, verify: 0 };
  const requests: { plan?: RunnerPlanRequest; verify?: RunnerVerifyRequest; executionSignal?: AbortSignal } = {};
  const provider: RunnerSupervisorProvider = {
    scheduling: { provider: 'fake', model: 'test' },
    async plan(request) { calls.plan++; requests.plan = request; const value = plans.shift() ?? options.proposal ?? plan; if (value instanceof Error) throw value; return modelResult(value); },
    async verify(request) { calls.verify++; requests.verify = request; const value = verifications.shift() ?? options.verification ?? pass; if (value instanceof Error) throw value; return modelResult(value); },
  };
  const executor: RunnerActionExecutor = {
    id: 'executor',
    async prepare(proposal) { calls.prepare++; return { actionId: `action-${++actionSerial}`, executorId: 'executor', operation: proposal.operation,
      actionClass: options.actionClass ?? 'read', fingerprint: `fingerprint-${actionSerial}`, publicSummary: 'Public action summary', retrySafety: 'never', payload: structuredClone(proposal.arguments) }; },
    async execute(_action, context) { calls.execute++; requests.executionSignal = context.signal; return options.result ?? { status: 'succeeded', summary: 'private-result-value' }; },
  };
  const deps: CoordinationRunnerDependencies = { store, pendingActions, evidenceStore, supervisorProvider: provider, executors: { get: id => id === executor.id ? executor : undefined }, ids, clock };
  const runner = createCoordinationRunner(deps);
  const add = (type: CoordinationEventType, payload: unknown, sessionId?: string) => store.append(createRunnerEvent(store.getSnapshot('run'), type, payload, clock, ids, { sessionId }));
  const resume = (reference?: string) => add('WorkflowResumed', { authorization: { type: 'user', reference } });
  const get = () => store.getSnapshot('run');
  const events = (type: CoordinationEventType) => get().events.filter(event => event.type === type);
  return { runner, store, pendingActions, evidenceStore, provider, executor, deps, ids, clock, calls, plans, verifications, requests, add, resume, get, events, advance: (ms: number) => { tick += ms; } };
}
const firstTask = (s: CoordinationSnapshot) => Object.values(s.tasks)[0];
const progress = (f: ReturnType<typeof fixture>) => f.events('ProgressRecorded').map(event => (event.payload as { outcome: string }).outcome);
const validate = (f: ReturnType<typeof fixture>) => validateCoordinationSnapshot(f.get());

// Preflight, bounded execution, and deterministic commitment.
test('interactive workflow never plans or executes', async () => {
  const f = fixture({ mode: 'interactive' }); const result = await f.runner.runUntilStop('run');
  assert.equal(result.reason, 'stopped'); assert.equal(f.calls.plan, 0); assert.equal(f.calls.execute, 0); assert.equal(f.get().events.length, 1);
});
test('terminal workflow never plans', async () => {
  const f = fixture(); f.add('WorkflowCancelled', {});
  assert.equal((await f.runner.runOneRound('run')).reason, 'cancelled'); assert.equal(f.calls.plan, 0);
});
test('gate pass finalizes before PLAN and before exhausted budget', async () => {
  const f = fixture({ criteria: [], budget: { maxWallTimeMs: 1 } }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'completed'); assert.equal(f.calls.plan, 0);
  assert.deepEqual(f.get().events.slice(-3).map(e => e.type), ['PolicyEvaluated', 'CommitmentRequested', 'CommitmentAccepted']); validate(f);
});
test('pending commitment is accepted without another policy evaluation or PLAN', async () => {
  const f = fixture({ criteria: [] });
  const { evaluateCommitmentGate } = await import('../services/coordination/index.ts');
  f.add('PolicyEvaluated', { scope: 'commitment', result: evaluateCommitmentGate(f.get(), f.clock.now()) });
  f.add('CommitmentRequested', { commitmentId: 'existing' });
  await f.runner.runOneRound('run'); assert.equal(f.events('PolicyEvaluated').length, 1); assert.equal(f.calls.plan, 0); validate(f);
});
test('budget exhausted blocks without PLAN and does not fail workflow', async () => {
  const f = fixture({ budget: { maxWallTimeMs: 1 } }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'budget_exhausted'); assert.equal(f.get().run.status, 'BLOCKED'); assert.equal(f.calls.plan, 0); assert.deepEqual(progress(f), []);
});
test('PLAN budget boundary prevents prepare and execution', async () => {
  const f = fixture({ budget: { maxLlmCalls: 1 } }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'budget_exhausted'); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.execute, 0); assert.equal(f.get().run.usage.llmCalls, 1); assert.deepEqual(progress(f), []);
});
test('runUntilStop is bounded by round budget', async () => {
  const f = fixture({ proposal: { kind: 'finish', summary: 'Done' }, budget: { maxRounds: 2 } });
  const result = await f.runner.runUntilStop('run'); assert.equal(result.reason, 'budget_exhausted'); assert.equal(result.roundsCompleted, 2); assert.equal(f.calls.plan, 2); validate(f);
});
test('success at exact round and model-call budget still commits', async () => {
  const f = fixture({ budget: { maxRounds: 1, maxLlmCalls: 2 } }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'completed'); assert.equal(f.get().run.usage.rounds, 1); assert.equal(f.get().run.usage.llmCalls, 2); validate(f);
});
test('one ALLOW round creates one session and task and records both model usages', async () => {
  const f = fixture(); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'completed'); assert.equal(result.roundsCompleted, 1);
  assert.deepEqual(f.calls, { plan: 1, prepare: 1, execute: 1, verify: 1 });
  assert.equal(Object.keys(f.get().sessions).length, 1); assert.equal(Object.keys(f.get().tasks).length, 1);
  assert.match(Object.values(f.get().sessions)[0].contextRef!, /^map.runner.v1:/);
  assert.equal(firstTask(f.get()).status, 'COMPLETED'); assert.deepEqual(progress(f), ['PROGRESS']);
  assert.equal(f.events('UsageRecorded').length, 2); assert.equal(f.get().run.usage.inputTokens, 6); validate(f);
});
test('runner metadata and executor classification cannot be supplied by planner', async () => {
  const f = fixture({ actionClass: 'prohibited', proposal: { ...plan, eventId: 'forged', sequence: 100, taskId: 'forged', actionClass: 'read', action: { ...plan.action, actionClass: 'read', approvalRef: 'forged' } } as unknown as RunnerPlanProposal });
  const prepare = f.executor.prepare; f.executor.prepare = async proposal => { assert.equal('actionClass' in proposal, false); return prepare(proposal); };
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.equal(f.get().events.some(e => e.eventId === 'forged'), false);
  assert.equal(firstTask(f.get()).failureReason, 'POLICY_DENY:prohibited'); validate(f);
});
test('unknown executor fails closed with ERROR progress', async () => {
  const f = fixture({ proposal: { ...plan, action: { ...plan.action, executorId: 'missing' } } });
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.deepEqual(progress(f), ['ERROR']); assert.equal(Object.keys(f.get().sessions).length, 0);
});
test('prepare failure closes a round before task creation', async () => {
  const f = fixture(); f.executor.prepare = async () => { throw new Error('Invalid input'); };
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.equal(Object.keys(f.get().tasks).length, 0); assert.deepEqual(progress(f), ['ERROR']);
});
test('DENY never executes, including after unrelated user authorization', async () => {
  const f = fixture({ actionClass: 'prohibited' }); f.add('WorkflowSuspended', {}); f.resume('any-reference');
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.equal(f.calls.verify, 0);
  assert.equal(firstTask(f.get()).failureReason, 'POLICY_DENY:prohibited'); assert.deepEqual(progress(f), ['NO_PROGRESS']); validate(f);
});

// Exact approval binding and continuation.
test('NEEDS_USER leaves task assigned and session suspended with no Progress', async () => {
  const f = fixture({ actionClass: 'write' }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'needs_user'); assert.equal(f.calls.execute, 0); assert.equal(firstTask(f.get()).status, 'ASSIGNED');
  assert.equal(Object.values(f.get().sessions)[0].state, 'SUSPENDED'); assert.deepEqual(progress(f), []);
  assert.match(result.pendingApproval!.approvalRef, /^map.runner.approval.v1:run:action-1:fingerprint-1$/); validate(f);
});
for (const reference of [undefined, 'wrong', 'map.runner.approval.v1:run:action-1:changed']) test(`wrong/missing approval ${reference} reblocks the same round`, async () => {
  const f = fixture({ actionClass: 'write' }); const first = await f.runner.runOneRound('run'); f.resume(reference);
  const second = await f.runner.runOneRound('run'); assert.deepEqual(second.pendingApproval, first.pendingApproval);
  assert.equal(f.calls.plan, 1); assert.equal(f.calls.execute, 0); assert.equal(firstTask(f.get()).status, 'ASSIGNED'); assert.deepEqual(progress(f), []); validate(f);
});
test('exact approval continues the same action exactly once even with a new runner instance', async () => {
  const f = fixture({ actionClass: 'write' }); const first = await f.runner.runOneRound('run');
  f.resume(first.pendingApproval!.approvalRef); const secondRunner = createCoordinationRunner(f.deps);
  const second = await secondRunner.runOneRound('run'); assert.equal(second.reason, 'completed');
  await secondRunner.runOneRound('run'); assert.equal(f.calls.plan, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.execute, 1);
  assert.deepEqual(progress(f), ['PROGRESS']); assert.equal(f.get().policy.riskRules.write, 'NEEDS_USER'); validate(f);
});
test('approval for previous action cannot authorize a subsequent action', async () => {
  const f = fixture({ actionClass: 'write', verification: { ...pass, criteria: [] } });
  const first = await f.runner.runOneRound('run'); f.resume(first.pendingApproval!.approvalRef);
  await f.runner.runOneRound('run'); const next = await f.runner.runOneRound('run');
  assert.notEqual(next.pendingApproval!.approvalRef, first.pendingApproval!.approvalRef);
  f.resume(first.pendingApproval!.approvalRef); await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 1); assert.equal(f.get().run.status, 'BLOCKED');
});
test('reused actionId fails closed before another session or execution', async () => {
  const f = fixture({ verification: { ...pass, criteria: [] } });
  const prepare = f.executor.prepare; f.executor.prepare = async proposal => ({ ...await prepare(proposal), actionId: 'same-id' });
  await f.runner.runOneRound('run'); await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 1); assert.equal(Object.keys(f.get().sessions).length, 1);
});
test('missing pending payload fails closed and closes the original round', async () => {
  const f = fixture({ actionClass: 'write' }); const first = await f.runner.runOneRound('run');
  f.pendingActions.delete('run', first.pendingApproval!.actionId); f.resume(first.pendingApproval!.approvalRef);
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.equal(firstTask(f.get()).failureReason, 'RUNNER_PENDING_ACTION_UNAVAILABLE');
  assert.deepEqual(progress(f), ['ERROR']); validate(f);
});
test('pending payload fingerprint mismatch cannot execute', async () => {
  const f = fixture({ actionClass: 'write' }); const first = await f.runner.runOneRound('run'); const record = f.pendingActions.get('run', first.pendingApproval!.actionId)!;
  f.pendingActions.delete('run', record.action.actionId); f.pendingActions.put({ ...record, action: { ...record.action, fingerprint: 'changed' } }); f.resume(first.pendingApproval!.approvalRef);
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.deepEqual(progress(f), ['ERROR']);
});
test('journal never stores private action arguments or raw result', async () => {
  const f = fixture(); await f.runner.runOneRound('run'); const journal = JSON.stringify(f.get().events);
  assert.equal(journal.includes('private-form-value'), false); assert.equal(journal.includes('private-result-value'), false);
  assert.ok(f.requests.verify!.evidence.some(e => JSON.stringify(e).includes('private-result-value')));
});

// Task collection, semantic verification, and deterministic progress.
for (const taskOutcome of ['FAIL', 'INCONCLUSIVE'] as const) test(`verification ${taskOutcome} records evaluation and NO_PROGRESS`, async () => {
  const f = fixture({ verification: { taskOutcome, summary: 'Not proven.', criteria: [] } }); await f.runner.runOneRound('run');
  assert.equal(Object.values(f.get().evaluations)[0].outcome, taskOutcome); assert.deepEqual(progress(f), ['NO_PROGRESS']);
  assert.equal(Object.values(f.get().sessions)[0].resolution!.outcome, 'FAILED'); assert.deepEqual(f.get().run.satisfiedCriteria, []); validate(f);
});
test('executor success alone never satisfies acceptance', async () => {
  const f = fixture({ verification: { ...pass, criteria: [] } }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'round_completed'); assert.deepEqual(f.get().run.satisfiedCriteria, []); assert.equal(firstTask(f.get()).status, 'COMPLETED');
});
test('execution failure records TaskFailed then verification and ERROR progress', async () => {
  const f = fixture({ result: { status: 'failed', summary: 'Known failure.' }, verification: { taskOutcome: 'FAIL', summary: 'Failed.', criteria: [] } });
  await f.runner.runOneRound('run'); assert.equal(firstTask(f.get()).status, 'FAILED'); assert.equal(f.calls.verify, 1); assert.deepEqual(progress(f), ['ERROR']); validate(f);
});
for (const status of ['uncertain', 'aborted'] as const) test(`${status} execution blocks with no automatic retry`, async () => {
  const f = fixture({ result: { status, summary: 'Outcome unknown.' } });
  await f.runner.runUntilStop('run'); await f.runner.runOneRound('run');
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.verify, 0); assert.equal(firstTask(f.get()).failureReason, 'EXECUTION_UNCERTAIN');
  assert.equal(f.get().run.status, 'BLOCKED'); assert.match(f.get().run.statusReason!, /^RUNNER_EXECUTION_UNCERTAIN:/); assert.deepEqual(progress(f), ['ERROR']); validate(f);
});
test('throwing executor is uncertain, never automatically retried', async () => {
  const f = fixture(); let executed = 0; f.executor.execute = async () => { executed++; throw new Error('Transport lost after submission'); };
  await f.runner.runUntilStop('run'); assert.equal(executed, 1); assert.equal(f.get().run.status, 'BLOCKED'); assert.deepEqual(progress(f), ['ERROR']);
});
test('malformed executor result is uncertain', async () => {
  const f = fixture({ result: { status: 'succeeded', summary: ' ' } }); await f.runner.runOneRound('run');
  assert.equal(firstTask(f.get()).failureReason, 'EXECUTION_UNCERTAIN'); assert.equal(f.calls.execute, 1);
});
for (const criteria of [
  [{ criterion: 'unknown', outcome: 'SATISFIED' }],
  [{ criterion: 'done', outcome: 'SATISFIED' }, { criterion: 'done', outcome: 'UNCHANGED' }],
  [{ criterion: 'done', outcome: 'SATISFIED', note: ' ' }],
  [{ criterion: 'done', outcome: 'INVALID' }],
]) test(`malformed verification criteria are rejected atomically: ${JSON.stringify(criteria)}`, async () => {
  const f = fixture({ verification: { ...pass, criteria } as RunnerVerification }); const result = await f.runner.runOneRound('run');
  assert.equal(result.errorCode, 'RUNNER_VERIFY_ERROR'); assert.deepEqual(f.get().run.satisfiedCriteria, []);
  assert.equal(f.events('EvaluationAdded').length, 0); assert.deepEqual(progress(f), ['ERROR']); assert.equal(f.events('UsageRecorded').length, 2); validate(f);
});
test('acceptance evidence IDs come from actual appended evaluation, not model metadata', async () => {
  const f = fixture({ verification: { ...pass, criteria: [{ ...pass.criteria[0], evidenceEventIds: ['forged'] }] } as unknown as RunnerVerification });
  await f.runner.runOneRound('run'); const acceptance = f.events('AcceptanceCriterionEvaluated')[0];
  assert.deepEqual((acceptance.payload as { evidenceEventIds: string[] }).evidenceEventIds, [f.events('EvaluationAdded')[0].eventId]);
  assert.equal(f.events('EvaluationAdded')[0].actorAgentId, 'supervisor'); validate(f);
});
test('UNCHANGED creates no acceptance event', async () => {
  const f = fixture({ verification: { ...pass, criteria: [{ criterion: 'done', outcome: 'UNCHANGED' }] } });
  await f.runner.runOneRound('run'); assert.equal(f.events('AcceptanceCriterionEvaluated').length, 0);
});
test('finish without gate pass records NO_PROGRESS and does not resolve', async () => {
  const f = fixture({ proposal: { kind: 'finish', summary: 'I am done' } }); await f.runner.runOneRound('run');
  assert.equal(f.get().run.status, 'RUNNING'); assert.deepEqual(progress(f), ['NO_PROGRESS']); assert.equal(f.calls.execute, 0);
});
test('planner needs_user blocks after NO_PROGRESS', async () => {
  const f = fixture({ proposal: { kind: 'needs_user', reason: 'Need a destination' } }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'needs_user'); assert.deepEqual(progress(f), ['NO_PROGRESS']); assert.equal(result.pendingApproval, undefined);
});

// Async state changes, cancellation and continuation.
test('stale PLAN is discarded but consumed usage is recorded on latest snapshot', async () => {
  const f = fixture(); f.provider.plan = async () => { f.add('ErrorRecorded', {}); return modelResult(plan); };
  await f.runner.runOneRound('run'); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.execute, 0); assert.equal(f.get().run.usage.llmCalls, 1); assert.deepEqual(progress(f), []); validate(f);
});
test('stopped workflow during PLAN retains usage and does not execute', async () => {
  const f = fixture(); f.provider.plan = async () => { f.add('WorkflowSuspended', {}); return modelResult(plan); };
  assert.equal((await f.runner.runOneRound('run')).reason, 'stopped'); assert.equal(f.get().run.usage.llmCalls, 1); assert.equal(f.calls.execute, 0); validate(f);
});
test('stale VERIFY is discarded with usage recorded; terminal task continues to VERIFY next time', async () => {
  const f = fixture(); const verify = f.provider.verify;
  f.provider.verify = async () => { f.add('ErrorRecorded', {}); return modelResult(pass); };
  await f.runner.runOneRound('run'); assert.equal(f.events('EvaluationAdded').length, 0); assert.equal(f.get().run.usage.llmCalls, 2); assert.deepEqual(progress(f), []);
  f.provider.verify = verify; await f.runner.runOneRound('run'); assert.equal(f.calls.plan, 1); assert.equal(f.calls.execute, 1); assert.deepEqual(progress(f), ['PROGRESS']); validate(f);
});
test('prepare async state change prevents execution and task assignment', async () => {
  const f = fixture(); const prepare = f.executor.prepare;
  f.executor.prepare = async p => { f.add('ErrorRecorded', {}); return prepare(p); };
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.equal(f.events('TaskAssigned').length, 0);
});
test('concurrent starts are rejected across instances and lock released after settlement', async () => {
  const f = fixture(); const wait = deferred<RunnerModelResult<RunnerPlanProposal>>(); f.provider.plan = () => wait.promise;
  const first = f.runner.runOneRound('run'); assert.equal(f.runner.isRunning('run'), true);
  await assert.rejects(createCoordinationRunner(f.deps).runOneRound('run'), /RUNNER_ALREADY_RUNNING/);
  wait.resolve(modelResult({ kind: 'finish', summary: 'Done' })); await first; assert.equal(f.runner.isRunning('run'), false);
});
test('provider error releases lock and records known usage and ERROR progress', async () => {
  const f = fixture(); f.plans.push(Object.assign(new Error('Failed'), { usage }));
  await f.runner.runOneRound('run'); assert.equal(f.runner.isRunning('run'), false); assert.equal(f.get().run.usage.llmCalls, 1); assert.deepEqual(progress(f), ['ERROR']);
  await f.runner.runOneRound('run'); assert.equal(f.get().run.status, 'RESOLVED');
});
test('stop propagates AbortSignal to PLAN and suspends only after settle', async () => {
  const f = fixture(); const wait = deferred<RunnerModelResult<RunnerPlanProposal>>(); let signal: AbortSignal;
  f.provider.plan = request => { signal = request.signal!; return wait.promise; };
  const running = f.runner.runOneRound('run'); f.runner.stop('run'); assert.equal(signal!.aborted, true); assert.equal(f.get().run.status, 'RUNNING');
  wait.resolve(modelResult(plan)); assert.equal((await running).reason, 'cancelled'); assert.equal(f.get().run.status, 'SUSPENDED'); assert.equal(f.calls.execute, 0); assert.equal(f.get().run.usage.llmCalls, 1);
});
test('external AbortSignal reaches executor; unknown side effect blocks instead of suspending', async () => {
  const f = fixture(); const started = deferred<AbortSignal>(); const wait = deferred<RunnerExecutionResult>();
  f.executor.execute = (_action, context) => { started.resolve(context.signal!); return wait.promise; };
  const controller = new AbortController(); const running = f.runner.runOneRound('run', { signal: controller.signal });
  const signal = await started.promise; controller.abort(); assert.equal(signal.aborted, true);
  wait.resolve({ status: 'aborted', summary: 'Outcome unknown' }); await running;
  assert.equal(f.get().run.status, 'BLOCKED'); assert.deepEqual(progress(f), ['ERROR']); assert.equal(f.runner.isRunning('run'), false); validate(f);
});
test('known execution result survives stop and resumes collection without reexecution', async () => {
  const f = fixture(); const execute = f.executor.execute;
  f.executor.execute = async (action, context) => { const result = await execute(action, context); f.runner.stop('run'); return result; };
  await f.runner.runOneRound('run'); assert.equal(f.get().run.status, 'SUSPENDED'); assert.equal(firstTask(f.get()).status, 'ASSIGNED');
  f.resume(); await createCoordinationRunner(f.deps).runOneRound('run'); assert.equal(f.calls.execute, 1); assert.equal(f.calls.plan, 1); assert.equal(f.get().run.status, 'RESOLVED'); validate(f);
});
test('workflow blocked while executor awaits preserves result without illegal TaskCompleted append', async () => {
  const f = fixture(); const execute = f.executor.execute;
  f.executor.execute = async (a, c) => { f.add('WorkflowBlocked', { reason: 'User intervention' }); return execute(a, c); };
  await f.runner.runOneRound('run'); assert.equal(f.events('TaskCompleted').length, 0); assert.equal(f.get().run.status, 'BLOCKED');
  f.resume(); await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 1); assert.equal(f.events('TaskCompleted').length, 1); validate(f);
});
test('terminalized workflow receives no late result or usage events', async () => {
  const f = fixture(); f.executor.execute = async () => { f.add('WorkflowCancelled', {}); return { status: 'succeeded', summary: 'Late result' }; };
  await f.runner.runOneRound('run'); assert.equal(f.get().events.at(-1)!.type, 'WorkflowCancelled'); assert.equal(f.calls.verify, 0); validate(f);
});
test('manual active session prevents PLAN', async () => {
  const f = fixture(); f.add('SessionStarted', { sessionId: 'manual', workflowRunId: 'run', mode: 'map.coord.task.v1', participants: ['supervisor'],
    initiator: 'supervisor', supervisor: 'supervisor', state: 'OPEN', policyId: 'policy', policyVersion: '1', goal: 'Manual work', createdAt: 10, updatedAt: 10 }, 'manual');
  assert.equal((await f.runner.runOneRound('run')).reason, 'stopped'); assert.equal(f.calls.plan, 0);
  assert.equal(f.events('SessionCancelled').length, 0); validate(f);
});
test('VERIFY budget boundary closes existing task session without new model work', async () => {
  const f = fixture(); const execute = f.executor.execute;
  f.executor.execute = async (a, c) => { const result = await execute(a, c); f.advance(10000); return result; };
  assert.equal((await f.runner.runOneRound('run')).reason, 'budget_exhausted'); assert.equal(f.calls.verify, 0);
  assert.equal(firstTask(f.get()).status, 'COMPLETED'); assert.deepEqual(progress(f), ['NO_PROGRESS']); validate(f);
});
test('clock moving backwards still produces monotonic events', async () => {
  const f = fixture(); f.add('ErrorRecorded', {}); f.advance(-9); await f.runner.runOneRound('run');
  const times = f.get().events.map(e => e.timestamp); assert.deepEqual(times, [...times].sort((a, b) => a - b)); validate(f);
});
test('model context is bounded and explicitly treats evidence as untrusted', async () => {
  const f = fixture(); for (let i = 0; i < 25; i++) f.add('ErrorRecorded', {});
  await f.runner.runOneRound('run'); assert.equal(f.requests.plan!.recentTrail.length, 20); assert.equal(f.requests.plan!.audit.trail.length, 20);
  assert.equal(f.requests.verify!.systemContract, RUNNER_PROVIDER_SYSTEM_CONTRACT); assert.match(RUNNER_PROVIDER_SYSTEM_CONTRACT, /untrusted data/);
});
test('stores clone inputs and outputs, preventing authority through reference mutation', async () => {
  const f = fixture({ actionClass: 'write' }); const copy = f.get(); copy.run.status = 'RESOLVED'; assert.equal(f.get().run.status, 'RUNNING');
  const result = await f.runner.runOneRound('run'); const action = f.pendingActions.get('run', result.pendingApproval!.actionId)!.action;
  action.actionClass = 'read'; assert.equal(f.pendingActions.get('run', action.actionId)!.action.actionClass, 'write');
  const evidence = { kind: 'test', content: { text: 'original' }, createdAt: 1 }; const ref = await f.evidenceStore.put(evidence); evidence.content.text = 'mutated';
  assert.deepEqual((await f.evidenceStore.get(ref))!.content, { text: 'original' });
});
for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) test(`invalid llmCalls ${invalid} fails closed`, async () => {
  const f = fixture(); f.provider.plan = async () => modelResult(plan, { ...usage, llmCalls: invalid });
  await f.runner.runOneRound('run'); assert.equal(f.calls.execute, 0); assert.equal(f.events('UsageRecorded').length, 0); assert.deepEqual(progress(f), ['ERROR']);
});
test('coordination model calls use injected scheduler and propagate signal', async () => {
  const f = fixture(); const scheduler = new RequestScheduler();
  await createCoordinationRunner({ ...f.deps, scheduler }).runOneRound('run');
  assert.equal(scheduler.getDiagnostics().filter(e => e.kind === 'coordination' && e.state === 'completed').length, 2);
  assert.ok(f.requests.plan!.signal); assert.ok(f.requests.verify!.signal);
});

test('prototype-named unknown action class requires user approval', async () => {
  const f = fixture({ actionClass: 'toString' }); const result = await f.runner.runOneRound('run');
  assert.equal(result.reason, 'needs_user'); assert.equal(f.calls.execute, 0);
});
test('scheduler queue wait rechecks budget before dispatching model', async () => {
  const f = fixture(); const scheduler = new RequestScheduler({ defaultConcurrencyPerModel: 1 }); const gate = deferred<void>();
  const occupied = scheduler.schedule({ provider: 'fake', model: 'test', kind: 'coordination', execute: () => gate.promise });
  const running = createCoordinationRunner({ ...f.deps, scheduler }).runOneRound('run');
  f.advance(10000); gate.resolve(); await occupied; const result = await running;
  assert.equal(result.reason, 'budget_exhausted'); assert.equal(f.calls.plan, 0); assert.equal(f.get().run.usage.llmCalls, 0);
});
test('scheduler queue wait rechecks state before dispatching model', async () => {
  const f = fixture(); const scheduler = new RequestScheduler({ defaultConcurrencyPerModel: 1 }); const gate = deferred<void>();
  const occupied = scheduler.schedule({ provider: 'fake', model: 'test', kind: 'coordination', execute: () => gate.promise });
  const running = createCoordinationRunner({ ...f.deps, scheduler }).runOneRound('run');
  f.add('WorkflowSuspended', {}); gate.resolve(); await occupied; await running;
  assert.equal(f.calls.plan, 0); assert.equal(f.get().run.status, 'SUSPENDED');
});
test('missing external evidence fails verification closed without calling provider', async () => {
  const f = fixture({ result: { status: 'succeeded', summary: 'Done', resultRef: 'unavailable' } });
  const result = await f.runner.runOneRound('run'); assert.equal(result.errorCode, 'RUNNER_VERIFY_ERROR');
  assert.equal(f.calls.verify, 0); assert.deepEqual(f.get().run.satisfiedCriteria, []); assert.deepEqual(progress(f), ['ERROR']);
});
test('known VERIFY error usage is recorded', async () => {
  const f = fixture(); f.verifications.push(Object.assign(new Error('Verify unavailable'), { usage: { ...usage, llmCalls: 2 } }));
  await f.runner.runOneRound('run'); assert.equal(f.get().run.usage.llmCalls, 3); assert.deepEqual(progress(f), ['ERROR']);
});
test('pre-aborted caller does not start PLAN and always releases lock', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const result = await f.runner.runOneRound('run', { signal: controller.signal });
  assert.equal(result.reason, 'cancelled'); assert.equal(f.calls.plan, 0); assert.equal(f.runner.isRunning('run'), false);
});
test('unknown assignee is rejected before prepare or session assignment', async () => {
  const f = fixture({ proposal: { ...plan, assigneeAgentId: 'outsider' } }); await f.runner.runOneRound('run');
  assert.equal(f.calls.prepare, 0); assert.equal(f.events('TaskAssigned').length, 0); assert.deepEqual(progress(f), ['ERROR']);
});
test('participant assignee completes through its own actor identity', async () => {
  const f = fixture({ proposal: { ...plan, assigneeAgentId: 'worker' } }); await f.runner.runOneRound('run');
  assert.equal(f.events('TaskCompleted')[0].actorAgentId, 'worker'); assert.equal(f.events('EvaluationAdded')[0].actorAgentId, 'supervisor'); validate(f);
});

for (const phase of ['plan', 'verify']) test(`state changed after ${phase} usage append still invalidates proposal`, async () => {
  const f = fixture(); const append = f.store.append.bind(f.store); let usages = 0;
  f.store.append = event => {
    const snapshot = append(event);
    if (event.type === 'UsageRecorded' && ++usages === (phase === 'plan' ? 1 : 2)) queueMicrotask(() => f.add('ErrorRecorded', {}));
    return snapshot;
  };
  await f.runner.runOneRound('run'); assert.equal(f.events('EvaluationAdded').length, 0); assert.deepEqual(progress(f), []);
  assert.equal(f.calls.execute, phase === 'plan' ? 0 : 1); assert.equal(f.get().run.usage.llmCalls, phase === 'plan' ? 1 : 2); validate(f);
});

// Shared stores with deliberately colliding session/task/action IDs and fingerprints.
function multiWorkflowFixture(risks: { A?: 'ALLOW' | 'NEEDS_USER'; B?: 'ALLOW' | 'NEEDS_USER' } = {}) {
  let serial = 0;
  const ids = { nextId: (kind: string) => ['session', 'task'].includes(kind) ? `${kind}-1` : `${kind}-${++serial}` };
  const clock = { now: () => 10 };
  const snapshots = ['A', 'B'].map(runId => createWorkflow({ runId, roomId: 'room', goal: `Goal ${runId}`, acceptanceCriteria: ['done'],
    supervisorAgentId: 'supervisor', participantAgentIds: ['supervisor'], executionMode: 'supervised_autonomous', now: 1,
    policy: { ...policy, riskRules: { shared: risks[runId] ?? 'ALLOW' } } }));
  const store = new InMemoryCoordinationRunnerStore(snapshots);
  const pendingActions = new InMemoryRunnerPendingActionStore(); const evidenceStore = new InMemoryRunnerEvidenceStore(ids);
  const calls: string[] = []; const verifications: RunnerVerifyRequest[] = [];
  const get = (id: string) => store.getSnapshot(id);
  const add = (id: string, type: CoordinationEventType, payload: unknown, sessionId?: string) => store.append(createRunnerEvent(get(id), type, payload, clock, ids, { sessionId }));
  const resume = (id: string, reference?: string) => add(id, 'WorkflowResumed', { authorization: { type: 'user', reference } });
  const provider: RunnerSupervisorProvider = {
    async plan(request) { return modelResult({ ...plan, action: { ...plan.action, arguments: { owner: request.workflowRunId } } }); },
    async verify(request) { verifications.push(request); return modelResult(pass); },
  };
  const executor: RunnerActionExecutor = {
    id: 'executor',
    async prepare(proposal) { return { actionId: 'action-1', executorId: 'executor', operation: 'read', actionClass: 'shared',
      fingerprint: 'fingerprint-1', publicSummary: 'Public action', retrySafety: 'never', payload: proposal.arguments }; },
    async execute(action, context) {
      calls.push(context.workflowRunId);
      assert.equal((action.payload as { owner: string }).owner, context.workflowRunId);
      add(context.workflowRunId, 'WorkflowSuspended', {});
      return { status: 'succeeded', summary: `Result ${context.workflowRunId}` };
    },
  };
  const deps: CoordinationRunnerDependencies = { store, pendingActions, evidenceStore, supervisorProvider: provider, executors: { get: () => executor }, ids, clock };
  const runner = createCoordinationRunner(deps);
  const seedTask = (id: string) => {
    add(id, 'SessionStarted', { sessionId: 'session-1', workflowRunId: id, mode: 'map.coord.task.v1', participants: ['supervisor'], initiator: 'supervisor', supervisor: 'supervisor',
      state: 'OPEN', policyId: 'policy', policyVersion: '1', goal: 'Public action', contextRef: `map.runner.v1:seed-${id}`, createdAt: 10, updatedAt: 10 }, 'session-1');
    add(id, 'TaskAssigned', { taskId: 'task-1', workflowRunId: id, sessionId: 'session-1', title: 'Public action', goal: 'Public action', assigneeAgentId: 'supervisor',
      assignedByAgentId: 'supervisor', inputRefs: ['map.runner.action.v1:action-1:fingerprint-1'], status: 'ASSIGNED', createdAt: 10, updatedAt: 10 }, 'session-1');
  };
  const events = (id: string, type: CoordinationEventType) => get(id).events.filter(event => event.type === type);
  return { runner, deps, store, pendingActions, evidenceStore, executor, get, add, resume, seedTask, events, calls, verifications };
}
// Inspect ephemeral retention only; these assertions must not create a public state authority API.
const retainedResults = (runner: CoordinationRunner) => (runner as unknown as { results: Map<string, Map<string, unknown>> }).results;

test('shared store does not collect A result for B with the same task/action/fingerprint', async () => {
  const f = multiWorkflowFixture(); await f.runner.runOneRound('A'); f.seedTask('B');
  await f.runner.runOneRound('B'); assert.equal(f.events('B', 'TaskCompleted').length, 0);
  assert.equal(firstTask(f.get('B')).failureReason, 'RUNNER_PENDING_ACTION_UNAVAILABLE');
  assert.equal(retainedResults(f.runner).get('A')?.size, 1); assert.deepEqual(f.calls, ['A']);
  f.resume('A'); await f.runner.runOneRound('A'); assert.equal(f.events('A', 'TaskCompleted').length, 1);
});

test('colliding task IDs independently retain and collect each workflow result once', async () => {
  const f = multiWorkflowFixture(); await Promise.all([f.runner.runOneRound('A'), f.runner.runOneRound('B')]);
  assert.equal(retainedResults(f.runner).get('A')?.size, 1); assert.equal(retainedResults(f.runner).get('B')?.size, 1);
  for (const id of ['B', 'A']) {
    f.resume(id); await createCoordinationRunner(f.deps).runOneRound(id);
    assert.equal(f.events(id, 'TaskCompleted').length, 1); assert.equal(f.events(id, 'ProgressRecorded').length, 1);
    assert.equal(f.get(id).run.status, 'RESOLVED'); validateCoordinationSnapshot(f.get(id));
  }
  assert.deepEqual(f.calls.sort(), ['A', 'B']); assert.equal(retainedResults(f.runner).size, 0);
  for (const request of f.verifications) assert.equal((request.evidence[0].content as RunnerExecutionResult).summary, `Result ${request.workflowRunId}`);
});

test('pending records allow equal action IDs across workflows and isolate clone/deletion', async () => {
  const f = multiWorkflowFixture({ A: 'NEEDS_USER', B: 'NEEDS_USER' });
  await f.runner.runOneRound('A'); await f.runner.runOneRound('B');
  const a = f.pendingActions.get('A', 'action-1')!; const b = f.pendingActions.get('B', 'action-1')!;
  assert.equal(a.workflowRunId, 'A'); assert.equal(b.workflowRunId, 'B'); assert.equal(a.taskId, b.taskId);
  assert.throws(() => f.pendingActions.put(b), /already exists/);
  b.sessionId = 'mutated'; assert.equal(f.pendingActions.get('B', 'action-1')!.sessionId, 'session-1');
  f.pendingActions.delete('B', 'action-1'); assert.deepEqual(f.pendingActions.get('A', 'action-1'), a);
  assert.deepEqual(f.calls, []); assert.equal(f.events('A', 'ProgressRecorded').length, 0); assert.equal(f.events('B', 'ProgressRecorded').length, 0);
});

test('B ALLOW policy cannot execute A NEEDS_USER action by cross-workflow reference', async () => {
  const f = multiWorkflowFixture({ A: 'NEEDS_USER' }); await f.runner.runOneRound('A'); f.seedTask('B');
  const a = f.pendingActions.get('A', 'action-1'); await f.runner.runOneRound('B');
  assert.deepEqual(f.calls, []); assert.equal(f.events('B', 'TaskCompleted').length, 0);
  assert.equal(firstTask(f.get('B')).failureReason, 'RUNNER_PENDING_ACTION_UNAVAILABLE');
  assert.deepEqual(f.pendingActions.get('A', 'action-1'), a); assert.equal(f.get('A').run.status, 'BLOCKED');
});

for (const field of ['workflowRunId', 'sessionId', 'taskId', 'actionId', 'fingerprint']) test(`injected pending record with mismatched ${field} fails before policy or approval`, async () => {
  const f = multiWorkflowFixture({ A: 'NEEDS_USER', B: 'NEEDS_USER' }); await f.runner.runOneRound('A'); f.seedTask('B');
  const a = f.pendingActions.get('A', 'action-1')!;
  const record: RunnerPendingActionRecord = { ...structuredClone(a), workflowRunId: 'B' };
  if (field === 'actionId' || field === 'fingerprint') record.action[field] = 'mismatch';
  else record[field] = field === 'workflowRunId' ? 'A' : 'mismatch';
  const get = f.pendingActions.get.bind(f.pendingActions); const deletions: string[] = [];
  f.pendingActions.get = (id, actionId) => id === 'B' ? record : get(id, actionId);
  const remove = f.pendingActions.delete.bind(f.pendingActions);
  f.pendingActions.delete = (id, actionId) => { deletions.push(id); remove(id, actionId); };
  await f.runner.runOneRound('B'); assert.deepEqual(f.calls, []);
  assert.equal(firstTask(f.get('B')).failureReason, 'RUNNER_PENDING_ACTION_UNAVAILABLE');
  assert.equal(f.events('B', 'WorkflowBlocked').length, 0); // NEEDS_USER policy was never reached.
  assert.deepEqual(deletions, []); assert.deepEqual(get('A', 'action-1'), a);
});

test('exact approval cannot substitute for pending task ownership', async () => {
  const f = multiWorkflowFixture({ A: 'NEEDS_USER' }); const waiting = await f.runner.runOneRound('A');
  const record = f.pendingActions.get('A', 'action-1')!; f.pendingActions.delete('A', 'action-1');
  f.pendingActions.put({ ...record, taskId: 'other-task' }); f.resume('A', waiting.pendingApproval!.approvalRef);
  await f.runner.runOneRound('A'); assert.deepEqual(f.calls, []); assert.equal(f.events('A', 'TaskCompleted').length, 0);
});

test('terminal observation cleans a late executor result without appending TaskCompleted', async () => {
  const f = multiWorkflowFixture(); const started = deferred<void>(); const settled = deferred<RunnerExecutionResult>();
  f.executor.execute = async () => { started.resolve(); return settled.promise; };
  const running = f.runner.runOneRound('A'); await started.promise;
  f.add('A', 'WorkflowCancelled', {}); settled.resolve({ status: 'succeeded', summary: 'Late A result' }); await running;
  assert.equal(f.get('A').run.status, 'CANCELLED'); assert.equal(f.events('A', 'TaskCompleted').length, 0);
  assert.equal(retainedResults(f.runner).has('A'), false); assert.equal(f.runner.isRunning('A'), false);
});

test('terminal preflight removes only its workflow results and cleanup is idempotent', async () => {
  const f = multiWorkflowFixture(); await f.runner.runOneRound('A'); await f.runner.runOneRound('B');
  f.add('A', 'WorkflowCancelled', {});
  assert.equal(retainedResults(f.runner).has('A'), true); // No lifecycle observer when runner is idle.
  await f.runner.runOneRound('A'); await f.runner.runOneRound('A');
  assert.equal(retainedResults(f.runner).has('A'), false); assert.equal(retainedResults(f.runner).get('B')?.size, 1);
  f.resume('B'); await f.runner.runOneRound('B'); assert.equal(f.events('B', 'TaskCompleted').length, 1); assert.deepEqual(f.calls, ['A', 'B']);
});

test('terminal cleanup preserves other workflow pending actions and stored evidence', async () => {
  const f = multiWorkflowFixture({ A: 'NEEDS_USER', B: 'NEEDS_USER' }); await f.runner.runOneRound('A'); await f.runner.runOneRound('B');
  const b = f.pendingActions.get('B', 'action-1'); const ref = await f.evidenceStore.put({ kind: 'retained', content: 'history', createdAt: 10 });
  f.add('A', 'WorkflowCancelled', {}); await f.runner.runOneRound('A');
  assert.equal(f.pendingActions.get('A', 'action-1'), undefined); assert.deepEqual(f.pendingActions.get('B', 'action-1'), b);
  assert.equal((await f.evidenceStore.get(ref))!.content, 'history');
});

for (const type of ['WorkflowSuspended', 'WorkflowBlocked'] as const) test(`${type} retains the result for exactly one collection after resume`, async () => {
  const f = multiWorkflowFixture(); f.executor.execute = async (_action, ctx) => {
    f.calls.push(ctx.workflowRunId); f.add(ctx.workflowRunId, type, { reason: 'Wait' }); return { status: 'succeeded', summary: 'Known result' };
  };
  await f.runner.runOneRound('A'); assert.equal(retainedResults(f.runner).get('A')?.size, 1);
  await f.runner.runOneRound('A'); assert.equal(retainedResults(f.runner).get('A')?.size, 1);
  f.resume('A'); await f.runner.runOneRound('A');
  assert.deepEqual(f.calls, ['A']); assert.equal(f.events('A', 'TaskCompleted').length, 1); assert.equal(f.events('A', 'ProgressRecorded').length, 1);
  assert.equal(retainedResults(f.runner).has('A'), false);
});

for (const failureType of ['SessionStarted', 'TaskAssigned'] as const) test(`${failureType} append failure cleans registration without rolling back journal`, async () => {
  const f = multiWorkflowFixture({ A: 'NEEDS_USER', B: 'NEEDS_USER' }); await f.runner.runOneRound('B');
  const append = f.store.append.bind(f.store);
  f.store.append = event => { if (event.workflowRunId === 'A' && event.type === failureType) throw new Error('Injected append failure'); return append(event); };
  await f.runner.runOneRound('A'); assert.equal(f.pendingActions.get('A', 'action-1'), undefined);
  assert.ok(f.pendingActions.get('B', 'action-1')); assert.deepEqual(f.calls, []);
  assert.equal(f.events('A', 'SessionStarted').length, failureType === 'TaskAssigned' ? 1 : 0);
  assert.equal(f.events('A', 'SessionCancelled').length, failureType === 'TaskAssigned' ? 1 : 0);
  assert.equal(Object.values(f.get('A').sessions).filter(session => session.state === 'OPEN').length, 0);
  assert.deepEqual(f.events('A', 'ProgressRecorded').map(event => (event.payload as { outcome: string }).outcome), ['ERROR']);
  validateCoordinationSnapshot(f.get('A'));
});

test('COLLECT safe point cleans results when workflow terminalizes during evidence storage', async () => {
  const f = multiWorkflowFixture();
  f.executor.execute = async () => ({ status: 'succeeded', summary: 'Known result' });
  const put = f.evidenceStore.put.bind(f.evidenceStore);
  f.evidenceStore.put = async evidence => { f.add('A', 'WorkflowCancelled', {}); return put(evidence); };
  await f.runner.runOneRound('A');
  assert.equal(f.events('A', 'TaskCompleted').length, 0); assert.equal(retainedResults(f.runner).has('A'), false);
  assert.equal(f.get('A').run.status, 'CANCELLED'); validateCoordinationSnapshot(f.get('A'));
});

test('retained result also requires matching session/action identity before collection', async () => {
  const f = multiWorkflowFixture(); await f.runner.runOneRound('A');
  // Simulate an inconsistent ephemeral cache; the authoritative task remains unchanged.
  const retained = retainedResults(f.runner).get('A')!.get('task-1') as { sessionId: string };
  retained.sessionId = 'other-session'; f.resume('A'); await f.runner.runOneRound('A');
  assert.equal(f.events('A', 'TaskCompleted').length, 0); assert.deepEqual(f.calls, ['A']);
  assert.equal(firstTask(f.get('A')).failureReason, 'RUNNER_PENDING_ACTION_UNAVAILABLE');
});

test('TaskAssigned failure cancels the empty session once and permits the next plan', async () => {
  const f = fixture(); const append = f.store.append.bind(f.store); let fail = true;
  f.store.append = event => { if (event.type === 'TaskAssigned' && fail) { fail = false; throw new Error('Registration failed'); } return append(event); };
  const result = await f.runner.runOneRound('run'); const session = Object.values(f.get().sessions)[0];
  assert.equal(result.roundsCompleted, 1); assert.equal(session.state, 'CANCELLED'); assert.equal(f.pendingActions.get('run', 'action-1'), undefined);
  assert.equal(f.events('SessionStarted').length, 1); assert.equal(f.events('SessionCancelled').length, 1);
  assert.equal(f.events('SessionCancelled')[0].actorAgentId, 'supervisor'); assert.deepEqual(progress(f), ['ERROR']);
  assert.equal(f.events('ProgressRecorded')[0].idempotencyKey, `runner:run:${session.contextRef!.slice('map.runner.v1:'.length)}:progress`);
  const next = await f.runner.runOneRound('run'); assert.equal(next.reason, 'completed'); assert.equal(f.calls.plan, 2);
  assert.deepEqual(progress(f), ['ERROR', 'PROGRESS']); assert.equal(f.events('SessionCancelled').length, 1); validate(f);
});

for (const stoppedType of ['WorkflowSuspended', 'WorkflowBlocked'] as const) test(`${stoppedType} during registration defers cancellation until resume`, async () => {
  const f = fixture(); const append = f.store.append.bind(f.store); let stop = true;
  f.store.append = event => {
    if (event.type === 'TaskAssigned' && stop) { stop = false; f.add(stoppedType, { reason: 'Pause registration' }); }
    return append(event); // Real Kernel guard rejects TaskAssigned while stopped.
  };
  await f.runner.runOneRound('run'); const session = Object.values(f.get().sessions)[0];
  assert.equal(f.get().run.status, stoppedType === 'WorkflowSuspended' ? 'SUSPENDED' : 'BLOCKED');
  assert.equal(session.state, 'SUSPENDED'); assert.equal(f.events('SessionCancelled').length, 0);
  assert.deepEqual(progress(f), []); assert.equal(f.pendingActions.get('run', 'action-1'), undefined);
  await f.runner.runOneRound('run'); assert.equal(f.events('SessionCancelled').length, 0);
  f.resume(); const recovered = await f.runner.runOneRound('run');
  assert.equal(recovered.roundsCompleted, 1); assert.equal(f.calls.plan, 1); assert.equal(f.calls.execute, 0);
  assert.equal(f.get().sessions[session.sessionId].state, 'CANCELLED'); assert.equal(f.events('SessionCancelled').length, 1);
  assert.deepEqual(progress(f), ['ERROR']);
  assert.equal(f.events('ProgressRecorded')[0].idempotencyKey, `runner:run:${session.contextRef!.slice('map.runner.v1:'.length)}:progress`);
  await f.runner.runOneRound('run'); assert.equal(f.calls.plan, 2); assert.equal(f.calls.execute, 1);
  assert.deepEqual(progress(f), ['ERROR', 'PROGRESS']); validate(f);
});

test('terminal race during registration appends no cancellation or progress after terminalization', async () => {
  const f = fixture(); const append = f.store.append.bind(f.store);
  f.store.append = event => { if (event.type === 'TaskAssigned') f.add('WorkflowCancelled', {}); return append(event); };
  const result = await f.runner.runOneRound('run'); assert.equal(result.reason, 'cancelled');
  assert.equal(f.get().events.at(-1)!.type, 'WorkflowCancelled'); assert.equal(f.get().run.status, 'CANCELLED');
  assert.equal(f.events('SessionCancelled').length, 0); assert.deepEqual(progress(f), []);
  assert.equal(f.pendingActions.get('run', 'action-1'), undefined); assert.equal(f.calls.execute, 0); validate(f);
});

function seedRunnerSession(f: ReturnType<typeof fixture>, contextRef = 'map.runner.v1:original-round') {
  f.add('SessionStarted', { sessionId: 'incomplete', workflowRunId: 'run', mode: 'map.coord.task.v1', participants: ['supervisor'],
    initiator: 'supervisor', supervisor: 'supervisor', state: 'OPEN', policyId: 'policy', policyVersion: '1', goal: 'Registration', contextRef,
    createdAt: 10, updatedAt: 10 }, 'incomplete');
}

test('multiple tasks in runner session remain fail closed without automatic cancellation', async () => {
  const f = fixture(); seedRunnerSession(f);
  for (const taskId of ['one', 'two']) f.add('TaskAssigned', { taskId, workflowRunId: 'run', sessionId: 'incomplete', title: 'Work', goal: 'Work',
    assigneeAgentId: 'supervisor', assignedByAgentId: 'supervisor', status: 'ASSIGNED', createdAt: 10, updatedAt: 10 }, 'incomplete');
  const result = await f.runner.runOneRound('run'); assert.equal(result.errorCode, 'RUNNER_INVALID_PENDING_WORK');
  assert.equal(f.events('SessionCancelled').length, 0); assert.deepEqual(progress(f), []);
  assert.ok(Object.values(f.get().tasks).every(task => task.status === 'ASSIGNED')); assert.equal(f.calls.plan, 0); validate(f);
});

for (const contextRef of ['map.runner.v1:', 'map.runner.v1:   ']) test(`malformed empty round key ${JSON.stringify(contextRef)} is not repaired`, async () => {
  const f = fixture(); seedRunnerSession(f, contextRef); const result = await f.runner.runOneRound('run');
  assert.equal(result.errorCode, 'RUNNER_INVALID_PENDING_WORK'); assert.equal(f.events('SessionCancelled').length, 0);
  assert.deepEqual(progress(f), []); assert.equal(f.calls.plan, 0); validate(f);
});

test('unexpected registration cleanup failure stops safely and later recovery does not duplicate progress', async () => {
  const f = fixture(); const append = f.store.append.bind(f.store); let fail = true;
  f.store.append = event => {
    if (fail && ['TaskAssigned', 'SessionCancelled'].includes(event.type)) throw new Error(`Unavailable: ${event.type}`);
    return append(event);
  };
  const first = await f.runner.runOneRound('run'); assert.equal(first.reason, 'error'); assert.equal(first.errorCode, 'RUNNER_INTERNAL_ERROR');
  assert.deepEqual(progress(f), ['ERROR']); assert.equal(f.pendingActions.get('run', 'action-1'), undefined);
  assert.equal(Object.values(f.get().sessions)[0].state, 'OPEN'); assert.equal(f.runner.isRunning('run'), false);
  fail = false; const recovered = await f.runner.runOneRound('run');
  assert.equal(recovered.roundsCompleted, 0); assert.equal(f.events('SessionCancelled').length, 1); assert.deepEqual(progress(f), ['ERROR']);
  await f.runner.runOneRound('run'); assert.equal(f.calls.plan, 2); assert.deepEqual(progress(f), ['ERROR', 'PROGRESS']); validate(f);
});

test('registration cleanup leaves a session containing an already-appended task intact', async () => {
  const f = fixture(); const append = f.store.append.bind(f.store);
  f.store.append = event => { const s = append(event); if (event.type === 'TaskAssigned') throw new Error('Append acknowledgement lost'); return s; };
  await f.runner.runOneRound('run'); assert.equal(firstTask(f.get()).status, 'ASSIGNED');
  assert.equal(Object.values(f.get().sessions)[0].state, 'OPEN'); assert.equal(f.events('SessionCancelled').length, 0);
  assert.equal(f.calls.execute, 0); assert.deepEqual(progress(f), ['ERROR']); validate(f);
});

test('stop while attempting registration cancellation respects guard and recovers on resume', async () => {
  const f = fixture(); const append = f.store.append.bind(f.store); let failTask = true; let stopCleanup = true;
  f.store.append = event => {
    if (event.type === 'TaskAssigned' && failTask) { failTask = false; throw new Error('Registration failed'); }
    if (event.type === 'SessionCancelled' && stopCleanup) { stopCleanup = false; f.add('WorkflowSuspended', {}); }
    return append(event);
  };
  await f.runner.runOneRound('run'); assert.equal(f.get().run.status, 'SUSPENDED'); assert.equal(f.events('SessionCancelled').length, 0);
  assert.deepEqual(progress(f), []); f.resume(); await f.runner.runOneRound('run');
  assert.equal(f.events('SessionCancelled').length, 1); assert.deepEqual(progress(f), ['ERROR']); assert.equal(f.calls.execute, 0); validate(f);
});
