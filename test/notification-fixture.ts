import { appendEvent, createWorkflow, evaluateCommitmentGate, projectCoordinationNotifications, formatSecurityHoldReason } from '../services/coordination/index.ts';
import type { CoordinationSnapshot, CoordinationEvent, CoordinationEventType } from '../services/coordination/index.ts';
import { verifyEvidenceReviewRef } from '../services/coordination/runner/verifyEvidenceReview.ts';

export function fresh(runId = 'run'): CoordinationSnapshot {
  return createWorkflow({ runId, roomId: 'room', goal: 'raw-private-goal', acceptanceCriteria: [],
    supervisorAgentId: 'supervisor', participantAgentIds: ['supervisor'], executionMode: 'supervised_autonomous', now: 1,
    policy: { policyId: 'policy', version: '1', schemaVersion: 1, riskRules: {},
      budgets: { maxWallTimeMs: 10000, maxRounds: 10, maxLlmCalls: 20, maxInputTokens: 1000, maxOutputTokens: 1000, maxEstimatedCost: 10, maxConsecutiveErrors: 3, maxNoProgressCycles: 3 },
      completionRules: { commitAuthority: 'supervisor', requireAllAcceptanceCriteria: true },
      schedulerRules: { sameModelConcurrency: 1 }, retryRules: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } } });
}
export const event = (s: CoordinationSnapshot, type: CoordinationEventType, payload: unknown): CoordinationEvent => ({
  eventId: `event-${s.events.length + 1}`, sequence: s.events.length + 1, workflowRunId: s.run.runId,
  actorAgentId: s.run.supervisorAgentId, timestamp: s.events.length + 1, type, payload,
});
export const add = (s: CoordinationSnapshot, type: CoordinationEventType, payload: unknown) => appendEvent(s, event(s, type, payload));
export const block = (reason: string, s = fresh()) => add(s, 'WorkflowBlocked', { reason });
export const resume = (s: CoordinationSnapshot, reference?: string) => add(s, 'WorkflowResumed', { authorization: { type: 'user', reference } });
export const approvalRef = (id = 'action', runId = 'run') => `map.runner.approval.v1:${[runId, id, 'private-fingerprint'].map(encodeURIComponent).join(':')}`;
export const securityRef = (nonce = 'a', runId = 'run') => `map.runner.security-review.v1:${encodeURIComponent(runId)}:task:sha256%3A${nonce.repeat(64)}`;
export const securityReason = (nonce = 'a', runId = 'run') => formatSecurityHoldReason({ reviewRef: securityRef(nonce, runId), effectState: 'applied' });
export const evidenceReason = (nonce = 'one', runId = 'run') => `RUNNER_VERIFY_EVIDENCE_UNAVAILABLE:${verifyEvidenceReviewRef(runId, 'task', nonce)}`;
export const done = (initial = fresh()) => {
  let s = initial;
  s = add(s, 'PolicyEvaluated', { scope: 'commitment', result: evaluateCommitmentGate(s, s.events.length + 1) });
  s = add(s, 'CommitmentRequested', { commitmentId: 'c', summary: 'raw-private-evidence' });
  return add(s, 'CommitmentAccepted', { commitmentId: 'c' });
};
export const cancelled = () => add(fresh(), 'WorkflowCancelled', { reason: 'raw-private-exception' });
export const notification = () => projectCoordinationNotifications(cancelled())[0];
export const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
