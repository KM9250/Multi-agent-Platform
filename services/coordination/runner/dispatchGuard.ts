import type { CoordinationSnapshot, WorkflowResumePayload } from '../types';
import type { PreparedRunnerAction } from './types';
import { runnerPendingApproval } from './policyGuard';
import { parseSecurityHoldReason, parseSecurityReviewRef, SECURITY_BLOCK_PREFIX } from './securityHold';
import { parseVerifyEvidenceReviewRef, VERIFY_EVIDENCE_BLOCK_PREFIX } from './verifyEvidenceReview';

export const runnerOwnedSession = (s: CoordinationSnapshot, id: string): boolean =>
  !!s.sessions[id]?.contextRef?.startsWith('map.runner.v1:');
export function runnerActionApproved(s: CoordinationSnapshot, action: PreparedRunnerAction): boolean {
  const approval = runnerPendingApproval(s.run.runId, action);
  const resume = [...s.events].reverse().find(e => e.type === 'WorkflowResumed');
  const block = [...s.events].reverse().find(e => e.type === 'WorkflowBlocked'
    && (e.payload as { reason?: string }).reason === `RUNNER_NEEDS_USER:${approval.approvalRef}`);
  const auth = (resume?.payload as WorkflowResumePayload | undefined)?.authorization;
  return !!block && !!resume && resume.sequence > block.sequence && auth?.type === 'user' && auth.reference === approval.approvalRef;
}
/** Shared by Runner preflight and the transaction that authorizes dispatch. */
export function runnerSecurityReviewReason(s: CoordinationSnapshot): string | undefined {
  const held = [...s.events].reverse().find(e => e.type === 'TaskFailed'
    && (e.payload as { failureReason?: string }).failureReason?.startsWith(SECURITY_BLOCK_PREFIX)
    && !!e.sessionId && runnerOwnedSession(s, e.sessionId));
  const block = [...s.events].reverse().find(e => e.type === 'WorkflowBlocked'
    && (e.payload as { reason?: string }).reason?.startsWith(SECURITY_BLOCK_PREFIX));
  if (held) {
    const p = held.payload as { taskId: string; failureReason: string };
    if (!parseSecurityHoldReason(p.failureReason, { workflowRunId: s.run.runId, taskId: p.taskId })) return `${SECURITY_BLOCK_PREFIX}INVALID_METADATA`;
    if (!s.events.some(e => e.type === 'WorkflowBlocked' && e.sequence > held.sequence
      && (e.payload as { reason?: string }).reason === p.failureReason)) return p.failureReason;
  }
  if (!block) return;
  const reason = (block.payload as { reason: string }).reason;
  const metadata = parseSecurityHoldReason(reason, { workflowRunId: s.run.runId });
  const binding = metadata && parseSecurityReviewRef(metadata.reviewRef);
  const task = binding && s.tasks[binding.taskId];
  if (!metadata || !task || !runnerOwnedSession(s, task.sessionId) || task.failureReason !== reason
    || (held && (held.payload as { failureReason: string }).failureReason !== reason)) return `${SECURITY_BLOCK_PREFIX}INVALID_METADATA`;
  const resume = s.events.find(e => e.type === 'WorkflowResumed' && e.sequence > block.sequence);
  const auth = (resume?.payload as WorkflowResumePayload | undefined)?.authorization;
  if (auth?.type !== 'user' || auth.reference !== metadata.reviewRef) return reason;
}
export function runnerEvidenceReviewReason(s: CoordinationSnapshot): string | undefined {
  const block = [...s.events].reverse().find(e => e.type === 'WorkflowBlocked'
    && (e.payload as { reason?: string }).reason?.startsWith(VERIFY_EVIDENCE_BLOCK_PREFIX));
  if (!block) return;
  const reason = (block.payload as { reason: string }).reason;
  const ref = reason.slice(VERIFY_EVIDENCE_BLOCK_PREFIX.length), binding = parseVerifyEvidenceReviewRef(ref);
  const task = binding && s.tasks[binding.taskId], session = task && s.sessions[task.sessionId];
  if (!binding || binding.workflowRunId !== s.run.runId || !task || task.workflowRunId !== s.run.runId
    || !session || session.workflowRunId !== s.run.runId || !runnerOwnedSession(s, session.sessionId)
    || !['COMPLETED', 'FAILED'].includes(task.status)) return `${VERIFY_EVIDENCE_BLOCK_PREFIX}INVALID_METADATA`;
  const resume = s.events.find(e => e.type === 'WorkflowResumed' && e.sequence > block.sequence);
  const auth = (resume?.payload as WorkflowResumePayload | undefined)?.authorization;
  if (auth?.type !== 'user' || auth.reference !== ref) return reason;
}
