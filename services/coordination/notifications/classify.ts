import type { CoordinationEvent, WorkflowBlockedPayload } from '../types';
import { parseSecurityHoldReason, SECURITY_BLOCK_PREFIX } from '../runner/securityHold';
import { parseVerifyEvidenceReviewRef, VERIFY_EVIDENCE_BLOCK_PREFIX } from '../runner/verifyEvidenceReview';
import type { CoordinationNotificationKind } from './types';

/** Internal identity metadata is not part of the public notification model. */
interface Classification { kind: CoordinationNotificationKind; reference?: string }
const attention: Classification = { kind: 'workflow_attention_required' };
const APPROVAL_PREFIX = 'map.runner.approval.v1:';
const BUDGETS = new Set(['maxWallTimeMs', 'maxRounds', 'maxLlmCalls', 'maxInputTokens', 'maxOutputTokens', 'maxEstimatedCost', 'maxConsecutiveErrors', 'maxNoProgressCycles']);
function validApprovalRef(value: string, workflowRunId: string): boolean {
  if (!value.startsWith(APPROVAL_PREFIX)) return false;
  const fields = value.slice(APPROVAL_PREFIX.length).split(':');
  if (fields.length !== 3) return false;
  try {
    const decoded = fields.map(decodeURIComponent);
    return decoded[0] === workflowRunId && decoded.every((part, i) => !!part.trim() && encodeURIComponent(part) === fields[i]);
  } catch { return false; }
}

export function classifyCoordinationEvent(event: CoordinationEvent): Classification | undefined {
  if (event.type === 'CommitmentAccepted') return { kind: 'workflow_completed' };
  if (event.type === 'WorkflowCancelled') return { kind: 'workflow_cancelled' };
  if (event.type !== 'WorkflowBlocked') return;
  const reason = (event.payload as WorkflowBlockedPayload)?.reason;
  if (typeof reason !== 'string') return { ...attention };
  if (reason.startsWith('RUNNER_NEEDS_USER:')) {
    const reference = reason.slice('RUNNER_NEEDS_USER:'.length);
    return validApprovalRef(reference, event.workflowRunId) ? { kind: 'action_approval_required', reference } : { ...attention };
  }
  if (reason.startsWith(SECURITY_BLOCK_PREFIX)) {
    const hold = parseSecurityHoldReason(reason, { workflowRunId: event.workflowRunId });
    return hold ? { kind: 'security_review_required', reference: hold.reviewRef } : { ...attention };
  }
  if (reason.startsWith(VERIFY_EVIDENCE_BLOCK_PREFIX)) {
    const reference = reason.slice(VERIFY_EVIDENCE_BLOCK_PREFIX.length);
    const owner = parseVerifyEvidenceReviewRef(reference);
    return owner?.workflowRunId === event.workflowRunId ? { kind: 'evidence_review_required', reference } : { ...attention };
  }
  if (reason.startsWith('RUNNER_EXECUTION_UNCERTAIN:')) {
    const actionId = reason.slice('RUNNER_EXECUTION_UNCERTAIN:'.length);
    return actionId.trim() && actionId === actionId.trim() && !/[\u0000-\u001f\u007f]/.test(actionId)
      ? { kind: 'execution_review_required', reference: actionId } : { ...attention };
  }
  if (reason.startsWith('RUNNER_BUDGET_EXHAUSTED:')) {
    return BUDGETS.has(reason.slice('RUNNER_BUDGET_EXHAUSTED:'.length)) ? { kind: 'budget_exhausted' } : { ...attention };
  }
  return { ...attention };
}
