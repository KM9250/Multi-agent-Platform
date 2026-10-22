import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRecovery } from '../services/coordination/durable/recoveryClassifier.ts';
import { executionSeed } from './durable-execution-fixture.ts';
import type { ExecutionStateSummary } from '../services/coordination/durable/recoveryTypes.ts';
const execution = (state: ExecutionStateSummary['state'], reviewReason?: string): ExecutionStateSummary => ({
  actionId: 'a', taskId: 't', sessionId: 's', taskStatus: 'ASSIGNED', sessionState: 'OPEN', state, reviewReason,
});
test('integrity precedes uncertainty, blocked status, recorded results and prepared work', () => {
  const snapshot = executionSeed(); snapshot.run.status = 'BLOCKED';
  const facts = { workflowRunId: 'run', inspectedAt: 10, snapshot, executions: [execution('PREPARED'), execution('DISPATCH_RESERVED')] };
  assert.equal(classifyRecovery({ ...facts, integrityReason: 'LEDGER_INVALID' }).disposition, 'RECOVERY_FAILED');
  assert.equal(classifyRecovery(facts).reasonCodes[0], 'EXECUTION_OUTCOME_REVIEW_REQUIRED');
});
test('a restrictive Action prevents another saved Result or PREPARED Action from authorizing work', () => {
  const facts = { workflowRunId: 'run', inspectedAt: 10, snapshot: executionSeed(), executions: [execution('RESULT_RECORDED'), execution('REVIEW_REQUIRED', 'EXECUTION_UNCERTAIN')] };
  assert.equal(classifyRecovery(facts).disposition, 'REVIEW_REQUIRED');
});
test('multiple active execution candidates are ambiguous and fail closed', () => {
  assert.equal(classifyRecovery({ workflowRunId: 'run', inspectedAt: 10, snapshot: executionSeed(), executions: [execution('PREPARED'), execution('RESULT_RECORDED')] }).disposition, 'RECOVERY_FAILED');
});
for (const exhausted of [false,true]) test(`recorded budget ${exhausted ? 'exhausted' : 'within limits'} never proves model-call coverage`, () => {
  const snapshot = executionSeed(); if (exhausted) snapshot.run.usage.llmCalls = snapshot.run.budget.maxLlmCalls;
  const result = classifyRecovery({ workflowRunId: 'run', inspectedAt: 10, snapshot, executions: [] });
  assert.equal(result.budgetStatus, exhausted ? 'RECORDED_LIMIT_EXHAUSTED' : 'WITHIN_RECORDED_LIMITS');
  assert.equal(result.modelCallCoverage, 'NOT_TRACKED_YET'); assert.equal(result.executable, false);
});
test('unverified budget is explicit when saved data cannot be validated', () => {
  const result = classifyRecovery({ workflowRunId: 'run', inspectedAt: 10, executions: [], integrityReason: 'JOURNAL_INVALID' });
  assert.equal(result.budgetStatus, 'UNVERIFIED'); assert.equal(result.disposition, 'RECOVERY_FAILED');
});

for (const status of ['RESOLVED','CANCELLED','FAILED'] as const) test(`${status} is terminal in the classifier contract`, () => {
  const snapshot = executionSeed(); snapshot.run.status = status;
  assert.equal(classifyRecovery({ workflowRunId: 'run', inspectedAt: 10, snapshot, executions: [] }).disposition, 'INACTIVE');
});
