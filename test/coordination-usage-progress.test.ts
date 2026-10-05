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

test('unknown event types fail closed at append, restore, and audit boundaries', async () => {
  const unknown = { eventId: 'unknown', sequence: 2, type: 'UNKNOWN' as never, workflowRunId: 'r', actorAgentId: 's', timestamp: 2, payload: {} };
  assert.throws(() => appendEvent(fresh(), unknown), /event type/);
  const restored = structuredClone(fresh()); restored.events.push(unknown); restored.run.updatedAt = 2;
  assert.throws(() => validateCoordinationSnapshot(restored), /event type/);
  const { buildCoordinationAuditView } = await import('../services/coordination/index.ts');
  assert.throws(() => buildCoordinationAuditView(restored, 2), /event type/);
});

test('usage and progress replay enforce the historical workflow lifecycle', () => {
  const forge = (state: CoordinationSnapshot, type: 'UsageRecorded' | 'ProgressRecorded', payload: unknown) => {
    const forged = structuredClone(state); const timestamp = forged.run.updatedAt + 1;
    forged.events.push({ eventId: `forged-${type}`, sequence: forged.events.length + 1, type, workflowRunId: 'r', actorAgentId: 's', timestamp, payload });
    forged.run.updatedAt = timestamp;
    if (type === 'UsageRecorded') forged.run.usage.llmCalls += 1;
    else forged.run.usage.rounds += 1;
    return forged;
  };
  for (const stoppedType of ['WorkflowSuspended', 'WorkflowBlocked'] as const) {
    const stopped = add(fresh(), stoppedType, stoppedType === 'WorkflowBlocked' ? { reason: 'wait' } : {});
    assert.throws(() => validateCoordinationSnapshot(forge(stopped, 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'forged' })), /while workflow is running/);
    validateCoordinationSnapshot(add(stopped, 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }));
  }
  let resumed = add(fresh(), 'WorkflowSuspended', {});
  resumed = add(resumed, 'WorkflowResumed', { authorization: { type: 'user' } });
  resumed = add(resumed, 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'resumed' }); validateCoordinationSnapshot(resumed);
  const cancelled = add(fresh(), 'WorkflowCancelled', {});
  assert.throws(() => validateCoordinationSnapshot(forge(cancelled, 'ProgressRecorded', { outcome: 'PROGRESS', summary: 'forged' })), /Terminal workflow/);
  assert.throws(() => validateCoordinationSnapshot(forge(cancelled, 'UsageRecorded', { llmCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCost: 0 })), /Terminal workflow/);
});
