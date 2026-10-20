import type { RunnerPendingActionRecord, RunnerPendingActionStore } from '../runner/types';
import { validatePreparedRunnerAction } from '../runner/model';
import { parseRunnerActionRef } from '../runner/policyGuard';
import type { CoordinationSnapshot } from '../types';
import { DurableDatabase } from './db';
import type { DurableTransaction } from './db';
import { canonicalJson, digest, DurableStoreError, guarded, requireIntegrity } from './integrity';
import { EXECUTION_LIMITS, executionJson, parseExecutionJson, rejectEmbeddedCredentials } from './executionIntegrity';

export function validateAction(record: RunnerPendingActionRecord): RunnerPendingActionRecord {
  executionJson(record, EXECUTION_LIMITS.action);
  for (const id of [record.workflowRunId, record.sessionId, record.taskId]) requireIntegrity(typeof id === 'string' && !!id.trim() && id === id.trim());
  const action = guarded('INTEGRITY_ERROR', () => validatePreparedRunnerAction(record.action, record.action.executorId));
  requireIntegrity(canonicalJson(action) === canonicalJson(record.action));
  executionJson(action.payload, EXECUTION_LIMITS.action);
  rejectEmbeddedCredentials(action.payload);
  return JSON.parse(executionJson({ ...record, action }, EXECUTION_LIMITS.action));
}
export function validateActionOwner(s: CoordinationSnapshot, r: RunnerPendingActionRecord): void {
  const task = s.tasks[r.taskId], session = s.sessions[r.sessionId], ref = task && parseRunnerActionRef(task.inputRefs);
  requireIntegrity(r.workflowRunId === s.run.runId && task?.workflowRunId === r.workflowRunId && task.sessionId === r.sessionId
    && session?.workflowRunId === r.workflowRunId && session.mode === 'map.coord.task.v1'
    && !!session.contextRef?.startsWith('map.runner.v1:') && ref?.actionId === r.action.actionId && ref.fingerprint === r.action.fingerprint);
}
/** Read-compatible adapter. Registration is exclusively Coordinator-owned; audit rows are retained. */
export class SqliteRunnerPendingActionStore implements RunnerPendingActionStore {
  constructor(readonly database: DurableDatabase) {}
  get(id: string, actionId: string): RunnerPendingActionRecord | undefined { return this.database.read(tx => this.getInTransaction(tx, id, actionId)); }
  getInTransaction(tx: DurableTransaction, id: string, actionId: string): RunnerPendingActionRecord | undefined {
    this.database.assertTransaction(tx);
    const row = tx.get('SELECT * FROM pending_actions WHERE workflow_run_id = ? AND action_id = ?', id, actionId);
    if (!row) return;
    const action = parseExecutionJson<RunnerPendingActionRecord['action']>(row.prepared_action_json, EXECUTION_LIMITS.action);
    const record = validateAction({ workflowRunId: id, sessionId: String(row.session_id), taskId: String(row.task_id), action });
    requireIntegrity(row.schema_version === 1 && action.actionId === actionId && row.prepared_action_digest === digest(action)
      && row.executor_id === action.executorId && row.operation === action.operation && row.action_class === action.actionClass
      && row.fingerprint === action.fingerprint && row.retry_safety === action.retrySafety);
    return record;
  }
  put(_record: RunnerPendingActionRecord): never { throw new DurableStoreError('INVALID_TRANSACTION'); }
  delete(_id: string, _actionId: string): void { /* Deliberately retain the immutable action and its audit linkage. */ }
}
