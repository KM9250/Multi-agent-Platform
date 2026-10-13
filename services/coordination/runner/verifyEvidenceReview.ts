export const VERIFY_EVIDENCE_BLOCK_PREFIX = 'RUNNER_VERIFY_EVIDENCE_UNAVAILABLE:';
const REVIEW_PREFIX = 'map.runner.verify-evidence-review.v1:';

export function verifyEvidenceReviewRef(workflowRunId: string, taskId: string, nonce: string): string {
  return REVIEW_PREFIX + [workflowRunId, taskId, nonce].map(encodeURIComponent).join(':');
}

export function parseVerifyEvidenceReviewRef(value: unknown): { workflowRunId: string; taskId: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith(REVIEW_PREFIX)) return;
  const fields = value.slice(REVIEW_PREFIX.length).split(':');
  if (fields.length !== 3) return;
  try {
    const decoded = fields.map(decodeURIComponent);
    if (decoded.some((field, index) => !field.trim() || encodeURIComponent(field) !== fields[index])) return;
    return { workflowRunId: decoded[0], taskId: decoded[1] };
  } catch { return; }
}
