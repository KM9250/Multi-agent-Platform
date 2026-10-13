import type { RunnerSafetyHold, RunnerSafetyHoldEffectState } from './types';

export const SECURITY_BLOCK_PREFIX = 'RUNNER_UNTRUSTED_CONTENT:';
export type SecurityHoldMetadata = Pick<RunnerSafetyHold, 'reviewRef' | 'effectState'>;
type ReviewOwner = { workflowRunId: string; taskId?: string };
export const isSafetyHoldEffectState = (value: unknown): value is RunnerSafetyHoldEffectState =>
  value === 'not_dispatched' || value === 'applied';

/** Canonical escaping makes IDs containing colons, pipes, or percent signs unambiguous. */
export function parseSecurityReviewRef(value: unknown): { workflowRunId: string; taskId: string } | undefined {
  if (typeof value !== 'string') return;
  const match = /^map\.runner\.security-review\.v1:([^:]+):([^:]+):sha256%3A[0-9a-f]{64}$/.exec(value);
  if (!match || match[0] !== value) return;
  try {
    const [workflowRunId, taskId] = match.slice(1).map(decodeURIComponent);
    if (!workflowRunId.trim() || !taskId.trim() || encodeURIComponent(workflowRunId) !== match[1] || encodeURIComponent(taskId) !== match[2]) return;
    return { workflowRunId, taskId };
  } catch { return; }
}

export function formatSecurityHoldReason(metadata: SecurityHoldMetadata): string {
  if (!parseSecurityReviewRef(metadata.reviewRef) || !isSafetyHoldEffectState(metadata.effectState)
    || Object.keys(metadata).some(key => !['reviewRef', 'effectState'].includes(key))) throw new Error('Invalid security hold metadata.');
  return `${SECURITY_BLOCK_PREFIX}v1:${encodeURIComponent(metadata.reviewRef)}|effect=${metadata.effectState}`;
}

/** Unknown versions, legacy reasons without effect state, extra fields and bad ownership fail closed. */
export function parseSecurityHoldReason(value: unknown, owner?: ReviewOwner): SecurityHoldMetadata | undefined {
  if (typeof value !== 'string' || !value.startsWith(`${SECURITY_BLOCK_PREFIX}v1:`)) return;
  const fields = value.slice(`${SECURITY_BLOCK_PREFIX}v1:`.length).split('|');
  if (fields.length !== 2 || !fields[1].startsWith('effect=')) return;
  try {
    const reviewRef = decodeURIComponent(fields[0]);
    const effectState = fields[1].slice('effect='.length);
    const binding = parseSecurityReviewRef(reviewRef);
    if (!binding || !isSafetyHoldEffectState(effectState) || encodeURIComponent(reviewRef) !== fields[0]
      || (owner && (binding.workflowRunId !== owner.workflowRunId || (owner.taskId !== undefined && binding.taskId !== owner.taskId)))) return;
    return { reviewRef, effectState };
  } catch { return; }
}
