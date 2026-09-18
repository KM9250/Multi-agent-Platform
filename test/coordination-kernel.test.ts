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

test('policies are bounded and unknown actions fail closed', () => {
  assert.equal(evaluateRisk(policy(), 'read_local_data'), 'ALLOW');
  assert.equal(evaluateRisk(policy(), 'not_registered'), 'NEEDS_USER');
  const invalid = policy(); invalid.budgets.maxRounds = 0;
  assert.throws(() => createWorkflow({ runId: 'x', roomId: 'r', goal: 'g', acceptanceCriteria: [], supervisorAgentId: 's', participantAgentIds: ['s'], executionMode: 'supervised_autonomous', policy: invalid }), /maxRounds/);
  assert.equal(findExhaustedBudget(policy().budgets, { rounds: 3, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, consecutiveErrors: 0, noProgressCycles: 0 }, 0), 'maxRounds');
});

test('TaskCompleted is non-terminal; supervisor CommitmentAccepted resolves', () => {
  let state = workflow();
  const session: CoordinationSession = { sessionId: 'task', workflowRunId: 'run', mode: 'map.coord.task.v1', participants: ['supervisor', 'worker'], initiator: 'supervisor', supervisor: 'supervisor', state: 'OPEN', policyId: 'safe', policyVersion: '1', goal: 'draft', createdAt: 2, updatedAt: 2 };
  state = appendEvent(state, event(2, 'SessionStarted', session, { sessionId: 'task', actorAgentId: 'supervisor' }));
  state = appendEvent(state, event(3, 'TaskCompleted', { resultRef: 'artifact:1' }, { sessionId: 'task', actorAgentId: 'worker' }));
  assert.equal(state.run.status, 'RUNNING'); assert.equal(state.sessions.task.state, 'OPEN');
  assert.throws(() => appendEvent(state, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'worker' })), /supervisor/);
  state = appendEvent(state, event(4, 'CommitmentAccepted', {}, { sessionId: 'task', actorAgentId: 'supervisor' }));
  assert.equal(state.run.status, 'RESOLVED'); assert.equal(state.sessions.task.state, 'RESOLVED');
});

test('journal is ordered, idempotent, and excludes non-participant sessions', () => {
  const state = workflow();
  assert.throws(() => appendEvent(state, event(3, 'TaskAssigned')), /sequence 2/);
  const repeated = appendEvent(state, { ...event(2, 'TaskAssigned'), idempotencyKey: 'assign:1' });
  assert.equal(appendEvent(repeated, { ...event(3, 'TaskAssigned'), eventId: 'other', idempotencyKey: 'assign:1' }), repeated);
  const badSession: CoordinationSession = { sessionId: 'bad', workflowRunId: 'run', mode: 'map.coord.task.v1', participants: ['private-subagent'], initiator: 'supervisor', supervisor: 'supervisor', state: 'OPEN', policyId: 'safe', policyVersion: '1', goal: 'x', createdAt: 2, updatedAt: 2 };
  assert.throws(() => appendEvent(state, event(2, 'SessionStarted', badSession)), /Persona participants/);
});
