import assert from 'node:assert/strict'; import test from 'node:test';
import { appendEvent, createWorkflow, validateCoordinationSnapshot } from '../services/coordination/index.ts';
import type { CoordinationPolicy, CoordinationSession } from '../services/coordination/index.ts';
const policy: CoordinationPolicy = { policyId: 'p', version: '1', schemaVersion: 1, budgets: { maxWallTimeMs: 100, maxRounds: 5, maxLlmCalls: 5, maxInputTokens: 100, maxOutputTokens: 100, maxEstimatedCost: 1, maxConsecutiveErrors: 3, maxNoProgressCycles: 3 }, riskRules: {}, completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true }, schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } };
const fresh = () => createWorkflow({ runId: 'r', roomId: 'room', goal: 'g', acceptanceCriteria: [], supervisorAgentId: 's', participantAgentIds: ['s', 'a'], executionMode: 'interactive', policy, now: 1 });
const event = (state: ReturnType<typeof fresh>, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown, sessionId?: string, actorAgentId = 's') => ({ eventId: `e${state.events.length + 1}`, sequence: state.events.length + 1, type, workflowRunId: 'r', actorAgentId, sessionId, timestamp: 10, payload });
const session = (mode: CoordinationSession['mode'], overrides: object = {}): CoordinationSession => ({ sessionId: 'x', workflowRunId: 'r', mode, participants: ['s', 'a'], initiator: 's', supervisor: 's', state: 'OPEN', policyId: 'p', policyVersion: '1', goal: 'g', createdAt: 8, updatedAt: 9, ...overrides });

test('principal creation timestamps cannot be later than their event', () => {
  assert.throws(() => appendEvent(fresh(), event(fresh(), 'SessionStarted', session('map.coord.task.v1', { updatedAt: 11 }), 'x')), /timestamps/);
  let tasks = appendEvent(fresh(), event(fresh(), 'SessionStarted', session('map.coord.task.v1'), 'x'));
  const task = { taskId: 't', workflowRunId: 'r', sessionId: 'x', title: 't', goal: 'g', assigneeAgentId: 'a', assignedByAgentId: 's', status: 'ASSIGNED' as const, createdAt: 11, updatedAt: 11 };
  assert.throws(() => appendEvent(tasks, event(tasks, 'TaskAssigned', task, 'x')), /timestamps/);
  let decisions = appendEvent(fresh(), event(fresh(), 'SessionStarted', session('map.coord.decision.v1'), 'x'));
  const decision = { decisionId: 'd', workflowRunId: 'r', sessionId: 'x', question: '?', authorityAgentId: 'a', status: 'OPEN' as const, createdAt: 11, updatedAt: 11 };
  assert.throws(() => appendEvent(decisions, event(decisions, 'DecisionOpened', decision, 'x')), /timestamps/);
  let quorums = appendEvent(fresh(), event(fresh(), 'SessionStarted', session('map.coord.quorum.v1'), 'x'));
  const quorum = { quorumId: 'q', workflowRunId: 'r', sessionId: 'x', question: '?', eligibleAgentIds: ['a'], threshold: { kind: 'all' as const }, votes: {}, status: 'OPEN' as const, createdAt: 11, updatedAt: 11 };
  assert.throws(() => appendEvent(quorums, event(quorums, 'QuorumOpened', quorum, 'x')), /timestamps/);
  const evaluation = { evaluationId: 'v', workflowRunId: 'r', sessionId: 'x', evaluatorAgentId: 'a', target: { type: 'artifact' as const, ref: 'a' }, outcome: 'PASS' as const, createdAt: 11 };
  assert.throws(() => appendEvent(tasks, event(tasks, 'EvaluationAdded', evaluation, 'x', 'a')), /timestamp/);
  validateCoordinationSnapshot(appendEvent(tasks, event(tasks, 'TaskAssigned', { ...task, createdAt: 9, updatedAt: 10 }, 'x')));
});

test('snapshot object timestamps must remain inside the workflow journal timeline', () => {
  let state = appendEvent(fresh(), event(fresh(), 'SessionStarted', session('map.coord.task.v1'), 'x'));
  const task = { taskId: 't', workflowRunId: 'r', sessionId: 'x', title: 't', goal: 'g', assigneeAgentId: 'a', assignedByAgentId: 's', status: 'ASSIGNED' as const, createdAt: 9, updatedAt: 10 };
  state = appendEvent(state, event(state, 'TaskAssigned', task, 'x')); validateCoordinationSnapshot(state);
  const futureTask = structuredClone(state); futureTask.tasks.t.updatedAt = 11; assert.throws(() => validateCoordinationSnapshot(futureTask), /Task timestamps/);
  const withEvaluation = appendEvent(state, event(state, 'EvaluationAdded', { evaluationId: 'v', workflowRunId: 'r', sessionId: 'x', evaluatorAgentId: 'a', target: { type: 'artifact', ref: 'a' }, outcome: 'PASS', createdAt: 10 }, 'x', 'a'));
  const futureEvaluation = structuredClone(withEvaluation); futureEvaluation.evaluations.v.createdAt = 11; assert.throws(() => validateCoordinationSnapshot(futureEvaluation), /Evaluation timestamp/);
});
