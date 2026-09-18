import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEvent, createWorkflow, evaluateRisk, findExhaustedBudget } from '../services/coordination/index.ts';
import type { CoordinationPolicy, CoordinationSession } from '../services/coordination/index.ts';

const policy = (): CoordinationPolicy => ({
  policyId: 'safe', version: '1', schemaVersion: 1,
  budgets: { maxWallTimeMs: 1000, maxRounds: 3, maxLlmCalls: 10, maxInputTokens: 1000, maxOutputTokens: 1000, maxEstimatedCost: 1, maxConsecutiveErrors: 2, maxNoProgressCycles: 3 },
  riskRules: { read_local_data: 'ALLOW', purchase: 'DENY' },
  completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true },
  schedulerRules: { sameModelConcurrency: 2 }, retryRules: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
});

const workflow = () => createWorkflow({ runId: 'run', roomId: 'room', goal: 'produce a reviewed answer', acceptanceCriteria: ['reviewed'], supervisorAgentId: 'supervisor', participantAgentIds: ['supervisor', 'worker'], executionMode: 'supervised_autonomous', policy: policy(), now: 1 });
const event = (sequence: number, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown = {}, extra = {}) => ({ eventId: `e${sequence}`, sequence, type, workflowRunId: 'run', timestamp: sequence, payload, ...extra });
const session = (overrides: Partial<CoordinationSession> = {}): CoordinationSession => ({
  sessionId: 'task', workflowRunId: 'run', mode: 'map.coord.task.v1',
  participants: ['supervisor', 'worker'], initiator: 'supervisor', supervisor: 'supervisor',
  state: 'OPEN', policyId: 'safe', policyVersion: '1', goal: 'draft', createdAt: 2, updatedAt: 2,
  ...overrides,
});
const withSession = () => appendEvent(workflow(), event(2, 'SessionStarted', session(), { sessionId: 'task', actorAgentId: 'supervisor' }));

test('policies are bounded and unknown actions fail closed', () => {
  assert.equal(evaluateRisk(policy(), 'read_local_data'), 'ALLOW');
  assert.equal(evaluateRisk(policy(), 'not_registered'), 'NEEDS_USER');
  const invalid = policy(); invalid.budgets.maxRounds = 0;
  assert.throws(() => createWorkflow({ runId: 'x', roomId: 'r', goal: 'g', acceptanceCriteria: [], supervisorAgentId: 's', participantAgentIds: ['s'], executionMode: 'supervised_autonomous', policy: invalid }), /maxRounds/);
  assert.equal(findExhaustedBudget(policy().budgets, { rounds: 3, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, consecutiveErrors: 0, noProgressCycles: 0 }, 0), 'maxRounds');
});

test('TaskCompleted is non-terminal; supervisor CommitmentAccepted resolves', () => {
  let state = withSession();
  state = appendEvent(state, event(3, 'TaskCompleted', { resultRef: 'artifact:1' }, { sessionId: 'task', actorAgentId: 'worker' }));
  assert.equal(state.run.status, 'RUNNING'); assert.equal(state.sessions.task.state, 'OPEN');
  assert.throws(() => appendEvent(state, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'worker' })), /supervisor/);
  state = appendEvent(state, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'supervisor' }));
  assert.equal(state.run.status, 'RESOLVED'); assert.equal(state.sessions.task.state, 'RESOLVED');
});

test('journal is ordered, idempotent, and excludes non-participant sessions', () => {
  const state = withSession();
  assert.throws(() => appendEvent(state, event(4, 'TaskAssigned', {}, { sessionId: 'task' })), /sequence 3/);
  const repeated = appendEvent(state, { ...event(3, 'TaskAssigned', {}, { sessionId: 'task' }), idempotencyKey: 'assign:1' });
  // An exact semantic retry may have transport-specific event metadata.
  assert.equal(appendEvent(repeated, { ...event(4, 'TaskAssigned', {}, { sessionId: 'task' }), eventId: 'other', idempotencyKey: 'assign:1' }), repeated);
  assert.throws(() => appendEvent(repeated, { ...event(4, 'TaskCompleted', {}, { sessionId: 'task' }), eventId: 'collision', idempotencyKey: 'assign:1' }), /collision/);
  const badSession = session({ sessionId: 'bad', participants: ['private-subagent'] });
  assert.throws(() => appendEvent(workflow(), event(2, 'SessionStarted', badSession)), /Persona participants/);
});

test('terminal workflows reject new events but accept exact event retries', () => {
  let cancelled = withSession();
  const cancellation = event(3, 'WorkflowCancelled');
  cancelled = appendEvent(cancelled, cancellation);
  assert.equal(appendEvent(cancelled, cancellation), cancelled);
  assert.throws(() => appendEvent(cancelled, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'supervisor' })), /already terminal: CANCELLED/);

  let resolved = withSession();
  resolved = appendEvent(resolved, event(3, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'supervisor' }));
  assert.throws(() => appendEvent(resolved, event(4, 'SessionStarted', session({ sessionId: 'next' }), { sessionId: 'next' })), /already terminal: RESOLVED/);
});

test('CommitmentAccepted requires an existing open session', () => {
  assert.throws(() => appendEvent(workflow(), event(2, 'CommitmentAccepted', {}, { sessionId: 'missing', actorAgentId: 'supervisor' })), /does not exist/);
  let state = withSession();
  state = { ...state, sessions: { task: { ...state.sessions.task, state: 'SUSPENDED' } } };
  assert.throws(() => appendEvent(state, event(3, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'supervisor' })), /not commit-ready/);
});

test('SessionStarted validates workflow and supervisor identity', () => {
  assert.throws(() => appendEvent(workflow(), event(2, 'SessionStarted', session({ workflowRunId: 'other' }))), /another workflow/);
  assert.throws(() => appendEvent(workflow(), event(2, 'SessionStarted', session({ supervisor: 'worker' }))), /workflow supervisor/);
});

test('SessionStarted rejects duplicate IDs and non-open sessions', () => {
  const state = withSession();
  assert.throws(() => appendEvent(state, event(3, 'SessionStarted', session(), { eventId: 'duplicate' })), /Duplicate session ID/);
  assert.throws(() => appendEvent(workflow(), event(2, 'SessionStarted', session({ state: 'RESOLVED' }))), /must be OPEN/);
});

test('SessionStarted requires valid participants, initiator, supervisor membership, and goal', () => {
  const base = workflow();
  assert.throws(() => appendEvent(base, event(2, 'SessionStarted', session({ participants: [] }))), /at least one participant/);
  assert.throws(() => appendEvent(base, event(2, 'SessionStarted', session({ initiator: 'outsider' }))), /initiator/);
  assert.throws(() => appendEvent(base, event(2, 'SessionStarted', session({ participants: ['worker'] }))), /include the supervisor/);
  assert.throws(() => appendEvent(base, event(2, 'SessionStarted', session({ goal: '  ' }))), /goal/);
});

test('policy validation rejects fractional counts and invalid retry delays', () => {
  const assertInvalid = (mutate: (candidate: CoordinationPolicy) => void, pattern: RegExp) => {
    const candidate = policy(); mutate(candidate);
    assert.throws(() => createWorkflow({ runId: 'x', roomId: 'r', goal: 'g', acceptanceCriteria: [], supervisorAgentId: 's', participantAgentIds: ['s'], executionMode: 'supervised_autonomous', policy: candidate }), pattern);
  };
  assertInvalid(candidate => { candidate.budgets.maxRounds = 1.5; }, /maxRounds/);
  assertInvalid(candidate => { candidate.retryRules.maxAttempts = 0; }, /maxAttempts/);
  assertInvalid(candidate => { candidate.retryRules.baseDelayMs = -1; }, /baseDelayMs/);
  assertInvalid(candidate => { candidate.retryRules.maxDelayMs = 99; }, /greater than or equal/);
});
