import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEvent, createWorkflow, evaluateCommitmentGate, validateCoordinationSnapshot } from '../services/coordination/index.ts';
import type { CommitmentGateResult, CoordinationPolicy, CoordinationSession, CoordinationSnapshot, CoordinationTask } from '../services/coordination/index.ts';

const policy = (requireAll = true): CoordinationPolicy => ({ policyId: 'p', version: '1', schemaVersion: 1, budgets: { maxWallTimeMs: 10, maxRounds: 2, maxLlmCalls: 5, maxInputTokens: 10, maxOutputTokens: 10, maxEstimatedCost: 1, maxConsecutiveErrors: 2, maxNoProgressCycles: 2 }, riskRules: {}, completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: requireAll }, schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
const fresh = (requireAll = true) => createWorkflow({ runId: 'r', roomId: 'room', goal: 'goal', acceptanceCriteria: ['A', 'B'], supervisorAgentId: 's', participantAgentIds: ['s', 'worker'], executionMode: 'interactive', policy: policy(requireAll), now: 0 });
const ev = (state: CoordinationSnapshot, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown, actorAgentId = 's', sessionId?: string) => ({ eventId: `e${state.events.length + 1}`, sequence: state.events.length + 1, type, workflowRunId: 'r', actorAgentId, sessionId, timestamp: state.events.length + 1, payload });
const add = (state: CoordinationSnapshot, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown, actor = 's', sessionId?: string) => appendEvent(state, ev(state, type, payload, actor, sessionId));
const work = (state = fresh()) => {
  const session: CoordinationSession = { sessionId: 'work', workflowRunId: 'r', mode: 'map.coord.task.v1', participants: ['s', 'worker'], initiator: 's', supervisor: 's', state: 'OPEN', policyId: 'p', policyVersion: '1', goal: 'work', createdAt: 1, updatedAt: 1 };
  state = add(state, 'SessionStarted', session, 's', 'work');
  const task: CoordinationTask = { taskId: 't', workflowRunId: 'r', sessionId: 'work', title: 't', goal: 'g', assigneeAgentId: 'worker', assignedByAgentId: 's', status: 'ASSIGNED', createdAt: 2, updatedAt: 2 };
  state = add(state, 'TaskAssigned', task, 's', 'work');
  state = add(state, 'TaskCompleted', { taskId: 't', resultRef: 'artifact' }, 'worker', 'work');
  return add(state, 'SessionResolved', { outcome: 'SUCCEEDED' }, 's', 'work');
};
const criterion = (state: CoordinationSnapshot, name: string, outcome: 'SATISFIED' | 'UNSATISFIED', evidence = outcome === 'SATISFIED' ? ['e4'] : []) => add(state, 'AcceptanceCriterionEvaluated', { criterion: ` ${name} `, outcome, evidenceEventIds: evidence, note: ' checked ' });
const policyEvent = (state: CoordinationSnapshot, mutate?: (result: CommitmentGateResult) => void) => { const result = evaluateCommitmentGate(state, state.events.length + 1); mutate?.(result); return add(state, 'PolicyEvaluated', { scope: 'commitment', result }); };

 test('acceptance evaluations are supervisor-owned, evidence-backed, reversible, and ordered', () => {
  let state = work();
  assert.throws(() => add(state, 'AcceptanceCriterionEvaluated', { criterion: 'A', outcome: 'SATISFIED', evidenceEventIds: ['e4'] }, 'worker'), /supervisor/);
  assert.throws(() => add(state, 'AcceptanceCriterionEvaluated', { criterion: 'unknown', outcome: 'SATISFIED', evidenceEventIds: ['e4'] }), /unknown/);
  assert.throws(() => add(state, 'AcceptanceCriterionEvaluated', { criterion: 'A', outcome: 'SATISFIED', evidenceEventIds: [] }), /requires evidence/);
  assert.throws(() => add(state, 'AcceptanceCriterionEvaluated', { criterion: 'A', outcome: 'SATISFIED', evidenceEventIds: ['missing'] }), /prior event/);
  assert.throws(() => add(state, 'AcceptanceCriterionEvaluated', { criterion: 'A', outcome: 'SATISFIED', evidenceEventIds: ['r:created'] }), /type is not allowed/);
  state = criterion(state, 'B', 'SATISFIED'); state = criterion(state, 'A', 'SATISFIED'); assert.deepEqual(state.run.satisfiedCriteria, ['A', 'B']);
  state = criterion(state, 'A', 'UNSATISFIED'); assert.deepEqual(state.run.satisfiedCriteria, ['B']);
  state = criterion(state, 'A', 'SATISFIED'); assert.deepEqual(state.run.satisfiedCriteria, ['A', 'B']); validateCoordinationSnapshot(state);
});

test('journal replay rejects forged or stale acceptance projections and corrupt baselines', () => {
  let state = criterion(work(), 'A', 'SATISFIED'); validateCoordinationSnapshot(state);
  assert.throws(() => validateCoordinationSnapshot({ ...fresh(), run: { ...fresh().run, satisfiedCriteria: ['A'] } }), /projection/);
  state = criterion(state, 'A', 'UNSATISFIED'); assert.throws(() => validateCoordinationSnapshot({ ...state, run: { ...state.run, satisfiedCriteria: ['A'] } }), /projection/);
  const future = structuredClone(state); (future.events[5].payload as { evidenceEventIds: string[] }).evidenceEventIds = ['e7']; assert.throws(() => validateCoordinationSnapshot(future), /prior event/);
  const gap = structuredClone(state); gap.events[1].sequence = 3; assert.throws(() => validateCoordinationSnapshot(gap), /contiguous/);
  const duplicate = structuredClone(state); duplicate.events[1].eventId = duplicate.events[0].eventId; assert.throws(() => validateCoordinationSnapshot(duplicate), /unique/);
  const wrong = structuredClone(state); wrong.events[1].workflowRunId = 'other'; assert.throws(() => validateCoordinationSnapshot(wrong), /another workflow/);
});

test('commitment gate is deterministic, blocks state not budgets, and fails closed', () => {
  let state = fresh(); let result = evaluateCommitmentGate(state, 20); assert.equal(result.allowed, false); assert.deepEqual(result.missingCriteria, ['A', 'B']); assert.equal(result.exhaustedBudget, 'maxWallTimeMs');
  state = work(state); result = evaluateCommitmentGate(state, 20); assert.equal(result.allowed, false); assert.deepEqual(result.activeSessionIds, []);
  state = criterion(criterion(state, 'A', 'SATISFIED'), 'B', 'SATISFIED');
  state = add(state, 'ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'no progress one' });
  state = add(state, 'ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'no progress two' });
  result = evaluateCommitmentGate(state, 5); assert.equal(result.allowed, true); assert.equal(result.exhaustedBudget, 'maxRounds');
  let optional = work(fresh(false)); result = evaluateCommitmentGate(optional, 5); assert.equal(result.allowed, true); assert.deepEqual(result.missingCriteria, ['A', 'B']);
  const invalid = { ...optional, run: { ...optional.run, satisfiedCriteria: ['A'] } }; assert.deepEqual(evaluateCommitmentGate(invalid, 5).reasons, ['snapshot-invalid']);
});

test('policy evaluation is workflow-scoped, supervisor-only, exact, and non-triggering', () => {
  let state = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); const correct = evaluateCommitmentGate(state, state.events.length + 1);
  assert.throws(() => add(state, 'PolicyEvaluated', { scope: 'commitment', result: correct }, 'worker'), /supervisor/);
  assert.throws(() => add(state, 'PolicyEvaluated', { scope: 'commitment', result: correct }, 's', 'work'), /must not include/);
  assert.throws(() => policyEvent(state, result => { result.reasons.push('fake'); }), /does not match/);
  state = policyEvent(state); assert.equal(state.run.status, 'RUNNING'); assert.equal(state.commitment, undefined);
});

test('request requires fresh allowed policy and participant, then accept resolves without cleanup', () => {
  let state = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED');
  assert.throws(() => add(state, 'CommitmentRequested', { commitmentId: 'c1' }, 'worker'), /preceding/);
  state = policyEvent(state);
  assert.throws(() => add(state, 'CommitmentRequested', { commitmentId: 'c1' }, 'outsider'), /participant/);
  assert.throws(() => add(state, 'CommitmentRequested', { commitmentId: 'c1' }, 'worker', 'work'), /must not include/);
  state = add(state, 'CommitmentRequested', { commitmentId: ' c1 ', summary: ' done ', evidenceRefs: [' artifact '] }, 'worker');
  assert.equal(state.commitment?.status, 'REQUESTED'); assert.equal(state.run.status, 'RUNNING');
  assert.throws(() => add(state, 'CommitmentAccepted', { commitmentId: 'c1' }, 'worker'), /supervisor/);
  assert.throws(() => add(state, 'CommitmentAccepted', { commitmentId: 'wrong' }), /does not match/);
  const beforeSessions = structuredClone(state.sessions); state = add(state, 'CommitmentAccepted', { commitmentId: 'c1' });
  assert.equal(state.run.status, 'RESOLVED'); assert.equal(state.commitment?.status, 'ACCEPTED'); assert.equal(state.commitment?.decidedByAgentId, 's'); assert.deepEqual(state.sessions, beforeSessions); validateCoordinationSnapshot(state);
  assert.throws(() => add(state, 'WorkflowCancelled', {}), /terminal/);
});

test('stale policy and gate changes after request prevent commitment', () => {
  let stale = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); stale = policyEvent(stale); stale = add(stale, 'ErrorRecorded', {}); assert.throws(() => add(stale, 'CommitmentRequested', { commitmentId: 'c' }, 'worker'), /immediately preceding/);
  let state = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); state = policyEvent(state); state = add(state, 'CommitmentRequested', { commitmentId: 'c' }, 'worker');
  const session: CoordinationSession = { sessionId: 'later', workflowRunId: 'r', mode: 'map.coord.task.v1', participants: ['s', 'worker'], initiator: 's', supervisor: 's', state: 'OPEN', policyId: 'p', policyVersion: '1', goal: 'later', createdAt: 10, updatedAt: 10 };
  state = add(state, 'SessionStarted', session, 's', 'later'); assert.throws(() => add(state, 'CommitmentAccepted', { commitmentId: 'c' }), /does not allow/);
  let regressed = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); regressed = policyEvent(regressed); regressed = add(regressed, 'CommitmentRequested', { commitmentId: 'x' }, 'worker'); regressed = criterion(regressed, 'A', 'UNSATISFIED'); assert.throws(() => add(regressed, 'CommitmentAccepted', { commitmentId: 'x' }), /does not allow/);
});

test('rejection permits a new ID, forbids reuse, and cancellation marks pending request', () => {
  let state = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); state = policyEvent(state); state = add(state, 'CommitmentRequested', { commitmentId: 'one' }, 'worker');
  assert.throws(() => add(state, 'CommitmentRejected', { commitmentId: 'one', reason: ' ' }), /reason/); assert.throws(() => add(state, 'CommitmentRejected', { commitmentId: 'bad', reason: 'no' }), /does not match/);
  state = add(state, 'CommitmentRejected', { commitmentId: 'one', reason: ' more work ' }); assert.equal(state.commitment?.status, 'REJECTED'); assert.equal(state.run.status, 'RUNNING');
  state = policyEvent(state); assert.throws(() => add(state, 'CommitmentRequested', { commitmentId: 'one' }, 'worker'), /already been used/); state = add(state, 'CommitmentRequested', { commitmentId: 'two' }, 'worker');
  state = add(state, 'WorkflowCancelled', {}); assert.equal(state.commitment?.status, 'CANCELLED'); assert.equal(state.commitment?.decidedAt, state.events.length); validateCoordinationSnapshot(state);
});

test('snapshot commitment invariants reject forged terminal state and metadata', () => {
  const base = fresh(); assert.throws(() => validateCoordinationSnapshot({ ...base, run: { ...base.run, status: 'RESOLVED' } }), /accepted commitment/);
  const requested = { commitmentId: 'c', status: 'REQUESTED' as const, requestedByAgentId: 'worker', requestedAt: 2 };
  assert.throws(() => validateCoordinationSnapshot({ ...base, commitment: { ...requested, decidedAt: 3 } }), /decision metadata/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, commitment: { ...requested, requestedByAgentId: 'outsider' } }), /requester/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, commitment: { ...requested, status: 'REJECTED', decidedByAgentId: 's', decidedAt: 3 } }), /reason/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, commitment: { ...requested, status: 'CANCELLED', decidedAt: 3 } }), /cancelled workflow/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, commitment: { ...requested, status: 'ACCEPTED', decidedByAgentId: 'worker', decidedAt: 3 } }), /supervisor decision/);
});

test('normalized event payloads retain exact event and idempotency retry semantics', () => {
  let state = work();
  const acceptance = { ...ev(state, 'AcceptanceCriterionEvaluated', { criterion: ' A ', outcome: 'SATISFIED', evidenceEventIds: [' e4 '], note: ' checked ' }), idempotencyKey: 'accept:A' };
  state = appendEvent(state, acceptance);
  assert.equal((state.events.at(-1)!.payload as { criterion: string }).criterion, ' A ');
  assert.equal(appendEvent(state, acceptance), state);
  assert.equal(appendEvent(state, { ...acceptance, eventId: 'accept-retry' }), state);
  state = criterion(state, 'B', 'SATISFIED'); state = policyEvent(state);
  const request = ev(state, 'CommitmentRequested', { commitmentId: ' c1 ', summary: ' done ', evidenceRefs: [' artifact '] }, 'worker');
  state = appendEvent(state, request); assert.equal((state.events.at(-1)!.payload as { commitmentId: string }).commitmentId, ' c1 '); assert.equal(appendEvent(state, request), state);
  const rejection = ev(state, 'CommitmentRejected', { commitmentId: ' c1 ', reason: ' more work ' });
  state = appendEvent(state, rejection); assert.equal((state.events.at(-1)!.payload as { reason: string }).reason, ' more work '); assert.equal(appendEvent(state, rejection), state);
  validateCoordinationSnapshot(state);
});

test('commitment projection is anchored to replayed request, acceptance, rejection, and cancellation', () => {
  const base = fresh();
  const forgedRequest = { commitmentId: 'forged', status: 'REQUESTED' as const, requestedByAgentId: 'worker', requestedAt: 2 };
  assert.throws(() => validateCoordinationSnapshot({ ...base, commitment: forgedRequest }), /projection/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, run: { ...base.run, status: 'RESOLVED' }, commitment: { ...forgedRequest, status: 'ACCEPTED', decidedByAgentId: 's', decidedAt: 3 } }), /projection/);

  let requested = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); requested = policyEvent(requested); requested = add(requested, 'CommitmentRequested', { commitmentId: 'c1' }, 'worker');
  assert.throws(() => validateCoordinationSnapshot({ ...requested, commitment: { ...requested.commitment!, commitmentId: 'c2' } }), /projection/);
  assert.throws(() => validateCoordinationSnapshot({ ...requested, commitment: { ...requested.commitment!, status: 'UNKNOWN' as never } }), /status is invalid/);
  validateCoordinationSnapshot(requested);

  const rejected = add(requested, 'CommitmentRejected', { commitmentId: 'c1', reason: 'not yet' }); validateCoordinationSnapshot(rejected);
  let accepted = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); accepted = policyEvent(accepted); accepted = add(accepted, 'CommitmentRequested', { commitmentId: 'accepted' }, 'worker'); accepted = add(accepted, 'CommitmentAccepted', { commitmentId: 'accepted' }); validateCoordinationSnapshot(accepted);
  let cancelled = criterion(criterion(work(), 'A', 'SATISFIED'), 'B', 'SATISFIED'); cancelled = policyEvent(cancelled); cancelled = add(cancelled, 'CommitmentRequested', { commitmentId: 'cancelled' }, 'worker'); cancelled = add(cancelled, 'WorkflowCancelled', {}); validateCoordinationSnapshot(cancelled);
});

test('workflow creation anchors immutable run metadata and journal origin', () => {
  const base = fresh();
  assert.throws(() => validateCoordinationSnapshot({ ...base, events: [] }), /begin with WorkflowRunCreated/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, events: [...base.events, { ...base.events[0], eventId: 'created-again', sequence: 2 }] }), /exactly one/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, run: { ...base.run, acceptanceCriteria: ['A'] } }), /immutable workflow metadata/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, run: { ...base.run, supervisorAgentId: 'worker' } }), /immutable workflow metadata/);
  assert.throws(() => validateCoordinationSnapshot({ ...base, run: { ...base.run, participantAgentIds: ['s'] } }), /immutable workflow metadata/);
  const malformed = structuredClone(base); malformed.events[0].payload = null; assert.throws(() => validateCoordinationSnapshot(malformed), /immutable workflow metadata/);
});

test('commitment gate contains all malformed snapshot failures', () => {
  const base = fresh(); const invalid = (state: CoordinationSnapshot) => assert.deepEqual(evaluateCommitmentGate(state, 2), { allowed: false, activeSessionIds: [], missingCriteria: [], reasons: ['snapshot-invalid'] });
  invalid({ ...base, policy: { ...base.policy, completionRules: undefined as never } });
  invalid({ ...base, run: { ...base.run, budget: undefined as never } });
  invalid({ ...base, run: { ...base.run, usage: undefined as never } });
  invalid({ ...base, run: { ...base.run, usage: { ...base.run.usage, rounds: -1 } } });
  invalid({ ...base, run: { ...base.run, budget: { ...base.run.budget, maxRounds: 99 } } });
});
