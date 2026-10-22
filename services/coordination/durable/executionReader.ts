// Shared, effect-free validation used by the execution coordinator and recovery reader.
import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { RunnerClock, RunnerExecutionResult, RunnerPendingActionRecord } from '../runner/types';
import { validateRunnerExecution } from '../runner/model';
import { createRunnerEvent } from '../runner/eventFactory';
import { formatSecurityHoldReason, parseSecurityReviewRef } from '../runner/securityHold';
import type { DurableTransaction } from './db';
import { SqliteRunnerEvidenceStore } from './evidenceStore';
import { readExecution } from './executionLedger';
import { canonicalJson, digest, guarded, requireIntegrity } from './integrity';
import { EXECUTION_LIMITS, parseExecutionJson } from './executionIntegrity';
export const executionOwner = (r: RunnerPendingActionRecord) => ({ workflowRunId: r.workflowRunId, sessionId: r.sessionId, taskId: r.taskId, actionId: r.action.actionId });
export function validateExecutionEvidence(tx: DurableTransaction, r: RunnerPendingActionRecord, result: RunnerExecutionResult, evidenceStore: SqliteRunnerEvidenceStore): void {
  requireIntegrity(!!result.resultRef);
  for (const ref of new Set([result.resultRef!, ...(result.evidenceRefs ?? [])])) {
    requireIntegrity(evidenceStore.getOwnedInTransaction(tx, executionOwner(r), ref));
  }
}
export function readExecutionResult(tx: DurableTransaction, r: RunnerPendingActionRecord, evidenceStore: SqliteRunnerEvidenceStore): RunnerExecutionResult | undefined {
  const row = readExecution(tx, r);
  if (!row.result_ref) return;
  const saved = tx.get('SELECT * FROM execution_results WHERE result_ref = ?', row.result_ref);
  requireIntegrity(saved && saved.workflow_run_id === r.workflowRunId && saved.session_id === r.sessionId && saved.task_id === r.taskId
    && saved.action_id === r.action.actionId && saved.fingerprint === r.action.fingerprint && saved.executor_id === r.action.executorId
    && saved.attempt_id === row.attempt_id && saved.schema_version === 1);
  const parsed = parseExecutionJson<RunnerExecutionResult>(saved.result_json, EXECUTION_LIMITS.result);
  const result = guarded('INTEGRITY_ERROR', () => validateRunnerExecution(parsed));
  requireIntegrity(canonicalJson(result) === canonicalJson(parsed) && saved.result_digest === digest(result) && row.result_digest === saved.result_digest);
  requireIntegrity(row.state === 'REVIEW_REQUIRED' ? result.status === 'uncertain' || !!result.safetyHold
    : ['RESULT_RECORDED','FINALIZED'].includes(String(row.state)) && ['succeeded','failed'].includes(result.status) && !result.safetyHold);
  requireIntegrity(row.review_reason !== 'SECURITY_REVIEW_REQUIRED' || !!result.safetyHold);
  requireIntegrity(row.review_reason !== 'EXECUTION_UNCERTAIN' || result.status === 'uncertain' && !result.safetyHold);
  if (result.safetyHold) {
    const binding = parseSecurityReviewRef(result.safetyHold.reviewRef);
    requireIntegrity(binding?.workflowRunId === r.workflowRunId && binding.taskId === r.taskId);
  }
  validateExecutionEvidence(tx, r, result, evidenceStore);
  return result;
}
export function recordedResultEvent(s: CoordinationSnapshot, r: RunnerPendingActionRecord, result: RunnerExecutionResult, clock: RunnerClock): CoordinationEvent {
  const task = s.tasks[r.taskId];
  const failureReason = result.status === 'uncertain' ? 'EXECUTION_UNCERTAIN'
    : result.safetyHold ? formatSecurityHoldReason({ reviewRef: result.safetyHold.reviewRef, effectState: result.safetyHold.effectState }) : 'RUNNER_EXECUTION_FAILED';
  const success = result.status === 'succeeded' && !result.safetyHold;
  return createRunnerEvent(s, success ? 'TaskCompleted' : 'TaskFailed', success
    ? { taskId: r.taskId, resultRef: result.resultRef, evidenceRefs: result.evidenceRefs }
    : { taskId: r.taskId, failureReason, ...(!result.safetyHold && result.status !== 'uncertain'
      ? { evidenceRefs: [...new Set([result.resultRef!, ...(result.evidenceRefs ?? [])])] } : {}) }, clock,
    { nextId: () => `durable-result-${digest([r.workflowRunId, r.action.actionId])}` }, {
      sessionId: r.sessionId, actorAgentId: success ? task.assigneeAgentId : s.run.supervisorAgentId,
      idempotencyKey: `durable-result:${digest([r.workflowRunId, r.action.actionId])}`,
    });
}

/** Shared validation of the legacy uncertain-stop prefix; never appends its missing suffix. */
export function inspectUncertainStop(tx: DurableTransaction, s: CoordinationSnapshot, r: RunnerPendingActionRecord,
  row: import('./db').Row, result: RunnerExecutionResult, clock: RunnerClock) {
  const id = r.workflowRunId;
  const task = s.tasks[r.taskId], session = s.sessions[r.sessionId];
  // A Result not yet reflected into TaskFailed follows the existing finalizeResult path.
  if (!row.finalized_event_id) { requireIntegrity(task.status === 'ASSIGNED'); return; }
  const expected = recordedResultEvent(s, r, result, clock);
  const failed = s.events.find(e => e.eventId === row.finalized_event_id);
  requireIntegrity(failed && failed.eventId === expected.eventId && failed.type === 'TaskFailed'
    && failed.sessionId === r.sessionId && failed.actorAgentId === expected.actorAgentId
    && failed.idempotencyKey === expected.idempotencyKey && canonicalJson(failed.payload) === canonicalJson(expected.payload)
    && task.status === 'FAILED' && task.failureReason === 'EXECUTION_UNCERTAIN');
  const prefix = 'map.runner.v1:', context = session.contextRef;
  requireIntegrity(context?.startsWith(prefix) && !!context.slice(prefix.length).trim());
  const saved = tx.get('SELECT round_key FROM pending_actions WHERE workflow_run_id = ? AND action_id = ?', id, r.action.actionId);
  requireIntegrity(saved?.round_key === context && Object.values(s.sessions).filter(item => item.contextRef === context).length === 1
    && Object.values(s.tasks).filter(item => item.sessionId === r.sessionId).length === 1
    && Object.values(s.sessions).every(item => !['OPEN','SUSPENDED'].includes(item.state) || item.sessionId === r.sessionId));
  const roundKey = context.slice(prefix.length), key = `runner:${id}:${roundKey}`;
  const resolveKey = `${key}:resolve`, progressKey = `${key}:progress`;
  const reason = `RUNNER_EXECUTION_UNCERTAIN:${r.action.actionId}`, blockKey = `${key}:execution-uncertain-block:${r.action.actionId}`;
  const resolutions = s.events.filter(e => e.type === 'SessionResolved' && e.sessionId === r.sessionId);
  const blocks = s.events.filter(e => e.type === 'WorkflowBlocked' && (e.payload as { reason?: string }).reason === reason);
  requireIntegrity(resolutions.length <= 1 && blocks.length <= 1);
  let resolved = resolutions[0], progress = s.events.find(e => e.idempotencyKey === progressKey), block = blocks[0];
  const matches = (event: CoordinationEvent, type: CoordinationEvent['type'], payload: unknown, sessionId?: string) =>
    event.workflowRunId === id && event.type === type && event.sessionId === sessionId
    && event.actorAgentId === s.run.supervisorAgentId && canonicalJson(event.payload) === canonicalJson(payload);
  const resolvePayload = { outcome: 'FAILED' }, progressPayload = { outcome: 'ERROR', summary: 'Runner round error.' };
  requireIntegrity(!s.events.some(e => e.idempotencyKey === resolveKey && e !== resolved)
    && !s.events.some(e => e.idempotencyKey === blockKey && e !== block));
  requireIntegrity(resolved
    ? matches(resolved, 'SessionResolved', resolvePayload, r.sessionId) && resolved.idempotencyKey === resolveKey
      && resolved.sequence > failed.sequence && session.state === 'RESOLVED' && session.resolution?.outcome === 'FAILED'
    : session.state === 'OPEN');
  if (progress) requireIntegrity(resolved && matches(progress, 'ProgressRecorded', progressPayload) && progress.sequence > resolved.sequence);
  if (block) {
    requireIntegrity(progress && matches(block, 'WorkflowBlocked', { reason }) && block.sequence > progress.sequence
      && (!block.idempotencyKey || block.idempotencyKey === blockKey));
    // A later user resume cannot resolve uncertainty or create another copy of this block.
    return { reason, resolved, progress, block, resolveKey, progressKey, blockKey, failed, resolvePayload, progressPayload };
  }
  return { reason, resolved, progress, block, resolveKey, progressKey, blockKey, failed, resolvePayload, progressPayload };
}
