import type { CoordinationSnapshot } from '../types';
import type { RunnerExecutionResult, RunnerPendingActionRecord } from '../runner/types';
import type { DurableTransaction, Row } from './db';
import { requireIntegrity } from './integrity';

export type DurableExecutionState = 'PREPARED' | 'DISPATCH_RESERVED' | 'RESULT_RECORDED' | 'FINALIZED' | 'REVIEW_REQUIRED';
export interface DurableExecutionInspection {
  workflowRunId: string; sessionId: string; taskId: string; actionId: string; fingerprint: string; executorId: string;
  taskStatus: CoordinationSnapshot['tasks'][string]['status'];
  workflowStatus: CoordinationSnapshot['run']['status'];
  sessionState: CoordinationSnapshot['sessions'][string]['state'];
  roundKey: string; journalCursor: number;
  state: DurableExecutionState; attemptId?: string; reservedAt?: number; resultRef?: string; resultDigest?: string;
  reviewReason?: string; finalizedEventId?: string; updatedAt: number;
  result?: RunnerExecutionResult;
  // Diagnostics for 5C; never an authorization to restart dispatch.
  dispatchMayHaveOccurred: boolean;
}
export function readExecution(tx: DurableTransaction, record: RunnerPendingActionRecord): Row {
  const row = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id = ? AND action_id = ?', record.workflowRunId, record.action.actionId);
  requireIntegrity(row && row.session_id === record.sessionId && row.task_id === record.taskId
    && row.fingerprint === record.action.fingerprint && row.executor_id === record.action.executorId && row.schema_version === 1);
  requireIntegrity(['PREPARED','DISPATCH_RESERVED','RESULT_RECORDED','FINALIZED','REVIEW_REQUIRED'].includes(String(row.state)));
  requireIntegrity(row.state === 'PREPARED' ? row.attempt_id === null && row.reserved_at === null
    : typeof row.attempt_id === 'string' && !!row.attempt_id && typeof row.reserved_at === 'number' && Number.isFinite(row.reserved_at));
  requireIntegrity((row.result_ref === null) === (row.result_digest === null)
    && (!['RESULT_RECORDED','FINALIZED'].includes(String(row.state)) || row.result_ref !== null));
  requireIntegrity(row.state === 'REVIEW_REQUIRED'
    ? ['EXECUTION_UNCERTAIN','SECURITY_REVIEW_REQUIRED','RESULT_INTEGRITY_UNAVAILABLE'].includes(String(row.review_reason))
    : row.review_reason === null);
  requireIntegrity(row.state !== 'FINALIZED' || typeof row.finalized_event_id === 'string');
  requireIntegrity(!['PREPARED','DISPATCH_RESERVED'].includes(String(row.state)) || (row.result_ref === null && row.finalized_event_id === null));
  return row;
}
