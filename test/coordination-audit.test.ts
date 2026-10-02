import assert from 'node:assert/strict'; import test from 'node:test';
import { appendEvent, buildCoordinationAuditView, createWorkflow } from '../services/coordination/index.ts';
import type { CoordinationPolicy } from '../services/coordination/index.ts';
const policy: CoordinationPolicy = { policyId: 'p', version: '1', schemaVersion: 1, budgets: { maxWallTimeMs: 100, maxRounds: 5, maxLlmCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxEstimatedCost: 1, maxConsecutiveErrors: 3, maxNoProgressCycles: 3 }, riskRules: {}, completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true }, schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } };
test('audit projection is deterministic, complete, isolated, and rejects invalid snapshots', () => {
  let state = createWorkflow({ runId: 'r', roomId: 'room', goal: 'g', acceptanceCriteria: ['A'], supervisorAgentId: 's', participantAgentIds: ['s'], executionMode: 'interactive', policy, now: 1 });
  state = appendEvent(state, { eventId: 'usage', sequence: 2, type: 'UsageRecorded', workflowRunId: 'r', actorAgentId: 's', timestamp: 2, payload: { llmCalls: 1, inputTokens: 2, outputTokens: 3, estimatedCost: 0 } });
  state = appendEvent(state, { eventId: 'progress', sequence: 3, type: 'ProgressRecorded', workflowRunId: 'r', actorAgentId: 's', timestamp: 3, payload: { outcome: 'PROGRESS', summary: ' advanced ' } });
  const before = structuredClone(state); const one = buildCoordinationAuditView(state, 3); const two = buildCoordinationAuditView(state, 3);
  assert.deepEqual(one, two); assert.deepEqual(state, before); assert.equal(one.events.count, 3); assert.equal(one.progress?.summary, 'advanced'); assert.equal(one.exhaustedBudget, 'maxLlmCalls'); assert.deepEqual(one.acceptance.missingCriteria, ['A']); assert.equal(one.sessionCounts.OPEN, 0); assert.equal(one.trail[2].scope, 'workflow');
  one.usage.llmCalls = 99; one.budget.maxLlmCalls = 99; assert.equal(state.run.usage.llmCalls, 1); assert.equal(state.run.budget.maxLlmCalls, 1);
  const invalid = structuredClone(state); invalid.run.updatedAt = 99; assert.throws(() => buildCoordinationAuditView(invalid, 3), /updatedAt/);
});
