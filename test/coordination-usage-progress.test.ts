import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEvent, createWorkflow, findExhaustedBudget, validateCoordinationSnapshot } from '../services/coordination/index.ts';
import type { CoordinationPolicy, CoordinationSnapshot } from '../services/coordination/index.ts';

const policy: CoordinationPolicy = { policyId: 'p', version: '1', schemaVersion: 1, budgets: { maxWallTimeMs: 100, maxRounds: 3, maxLlmCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxEstimatedCost: 1, maxConsecutiveErrors: 2, maxNoProgressCycles: 2 }, riskRules: {}, completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true }, schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } };
const fresh = () => createWorkflow({ runId: 'r', roomId: 'room', goal: 'g', acceptanceCriteria: [], supervisorAgentId: 's', participantAgentIds: ['s', 'w'], executionMode: 'supervised_autonomous', policy, now: 1 });
const add = (state: CoordinationSnapshot, type: Parameters<typeof appendEvent>[1]['type'], payload: unknown, extra: object = {}) => appendEvent(state, { eventId: `e${state.events.length + 1}`, sequence: state.events.length + 1, type, workflowRunId: 'r', actorAgentId: 's', timestamp: state.events.length + 1, payload, ...extra });

test('usage records consumed resources, can exceed budget, and replays exactly', () => {
  let state = add(fresh(), 'UsageRecorded', { llmCalls: 3, inputTokens: 10, outputTokens: 4, estimatedCost: 0.2, sourceRef: ' provider ' });
  assert.deepEqual(state.run.usage, { rounds: 0, llmCalls: 3, inputTokens: 10, outputTokens: 4, estimatedCost: 0.2, consecutiveErrors: 0, noProgressCycles: 0 });
  assert.equal(findExhaustedBudget(state.run.budget, state.run.usage, 1), 'maxLlmCalls'); validateCoordinationSnapshot(state);
  const forged = structuredClone(state); forged.run.usage.llmCalls = 0; assert.throws(() => validateCoordinationSnapshot(forged), /projection/);
  for (const llmCalls of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => add(fresh(), 'UsageRecorded', { llmCalls, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }), /llmCalls/);
  assert.throws(() => add(fresh(), 'UsageRecorded', { llmCalls: 1, inputTokens: -1, outputTokens: 0, estimatedCost: 0 }), /inputTokens/);
  assert.throws(() => add(fresh(), 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0, sourceRef: ' ' }), /sourceRef/);
});

test('progress implements round streak semantics and ErrorRecorded remains generic', () => {
  let state = add(fresh(), 'ProgressRecorded', { outcome: 'ERROR', summary: ' failed ' });
  state = add(state, 'ProgressRecorded', { outcome: 'ERROR', summary: 'failed again', evidenceEventIds: ['e2'] });
  assert.deepEqual([state.run.usage.rounds, state.run.usage.consecutiveErrors, state.run.usage.noProgressCycles], [2, 2, 2]);
  state = add(state, 'ProgressRecorded', { outcome: 'NO_PROGRESS', summary: 'waiting' });
  assert.deepEqual([state.run.usage.rounds, state.run.usage.consecutiveErrors, state.run.usage.noProgressCycles], [3, 0, 3]);
  state = add(state, 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'done' });
  assert.deepEqual([state.run.usage.rounds, state.run.usage.consecutiveErrors, state.run.usage.noProgressCycles], [4, 0, 0]);
  state = add(state, 'ErrorRecorded', {}); assert.equal(state.run.usage.consecutiveErrors, 0); validateCoordinationSnapshot(state);
});

test('usage/progress enforce scope, authority, stopped and timestamp rules', () => {
  assert.throws(() => add(fresh(), 'ProgressRecorded', { outcome: 'UNKNOWN', summary: 'x' }), /outcome/);
  assert.throws(() => add(fresh(), 'ProgressRecorded', { outcome: 'PROGRESS', summary: ' ' }), /summary/);
  assert.throws(() => add(fresh(), 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'x', evidenceEventIds: ['future'] }), /prior/);
  assert.throws(() => add(fresh(), 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, { actorAgentId: 'w' }), /supervisor/);
  assert.throws(() => add(fresh(), 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, { sessionId: 'x' }), /must not include/);
  let state = add(fresh(), 'WorkflowSuspended', {}); state = add(state, 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }); assert.equal(state.run.status, 'SUSPENDED');
  assert.throws(() => add(state, 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'x' }), /stopped/);
  assert.throws(() => appendEvent(state, { eventId: 'back', sequence: state.events.length + 1, type: 'UsageRecorded', workflowRunId: 'r', actorAgentId: 's', timestamp: 1, payload: { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 } }), /backwards/);
});
