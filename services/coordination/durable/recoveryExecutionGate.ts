import type { DurableDatabase, DurableTransaction } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { RecoveryReason } from './recoveryDecisionTypes';
import { readJournal } from './restore';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { parseJson } from './integrity';
import { evaluateRunnerActionRisk } from '../runner/policyGuard';
import type { PreparedRunnerAction } from '../runner/types';
import { readWorkflowControl } from './recoveryHoldLifecycle';
import { effectiveModelRows } from './safeRecoveryModelState';
import { effectiveActionRows, reconciliationHasDisputes } from './reconciliationEffectiveState';

/** Persisted risk only. A normal dispatch may finish under its still-current lease;
 * a new invocation cannot treat that dispatch as permission to start more work. */
export function recoveryGateReason(tx: DurableTransaction, id: string, ignoreReservedModel?: string): RecoveryReason | undefined {
  const s = readJournal(tx, id).snapshot;
  const control = readWorkflowControl(tx, id);
  if (control.active_invocation_id || control.planning_review_pending) return 'STATE_CHANGED';
  const existing = tx.get('SELECT reason_code FROM recovery_effective_holds WHERE workflow_run_id=?', id);
  if (existing) return existing.reason_code as RecoveryReason;
  if (tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?', id)?.coverage !== 'TRACKED_FROM_CREATION') return 'LEGACY_COVERAGE';
  if (['BLOCKED','SUSPENDED'].includes(s.run.status)) return 'EXPLICIT_STOP';
  if (['RESOLVED','CANCELLED','FAILED'].includes(s.run.status)) return 'EXPLICIT_STOP';
  if (runnerSecurityReviewReason(s)) return 'SECURITY_REVIEW';
  if (runnerEvidenceReviewReason(s)) return 'EVIDENCE_REVIEW';
  if (reconciliationHasDisputes(tx,id)) return 'STATE_CHANGED';
  if (effectiveActionRows(tx,id).some(row=>row.unresolved)) return 'ACTION_UNCERTAIN';
  const models = effectiveModelRows(tx, id);
  if (models.some(row => row.budgetViolation)) return 'BUDGET_VIOLATION';
  if (models.some(row => row.pendingApplication)) return 'PENDING_RESPONSE';
  if (models.some(row => row.disputed || row.outstandingReservation && ['DISPATCH_INTENT','REVIEW_REQUIRED'].includes(String(row.historical.state)))) return 'MODEL_UNCERTAIN';
  if (Object.values(s.tasks).some(task => s.sessions[task.sessionId]?.contextRef?.startsWith('map.runner.v1:') && !tx.get('SELECT task_id FROM execution_ledger WHERE workflow_run_id=? AND task_id=?', id, task.taskId))) return 'LEGACY_COVERAGE';
  for (const r of tx.all('SELECT prepared_action_json FROM pending_actions WHERE workflow_run_id=?', id)) {
    const action = parseJson<PreparedRunnerAction>(r.prepared_action_json);
    // An approval requirement is not satisfied by a Recovery authorization.
    if (s.events.some(e => e.type === 'WorkflowBlocked' && String((e.payload as {reason?:string}).reason).startsWith('RUNNER_NEEDS_USER:')) && !runnerActionApproved(s, action)) return 'ACTION_APPROVAL';
  }
}
export class RecoveryExecutionGate {
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  assertCanStart(workflowRunId: string): void { this.database.assertRecoveryExecution(this.lease, workflowRunId); }
}
/** Read-only SQLite predicate. It cannot install authority or clear a hold. */
export function recoveryStartAllowed(tx: DurableTransaction, id: string, route: string, target: string, verifiedPlanApplication = false): boolean {
  const reason = recoveryGateReason(tx, id);
  // Only the database's private, receipt-bound PLAN application scope can
  // permit registration before APPLIED. A saved pending response is not authority.
  if (reason && !(route === 'REGISTER' && reason === 'PENDING_RESPONSE' && verifiedPlanApplication)) return false;
  const s = readJournal(tx,id).snapshot;
  if (s.run.status !== 'RUNNING') return false;
  if (route === 'ACTION') {
    const row=tx.get('SELECT prepared_action_json FROM pending_actions WHERE workflow_run_id=? AND action_id=?',id,target);
    if(!row)return false;
    const action=parseJson<PreparedRunnerAction>(row.prepared_action_json),risk=evaluateRunnerActionRisk(s,action);
    return risk!=='DENY' && (risk!=='NEEDS_USER'||runnerActionApproved(s,action));
  }
  return route === 'REGISTER' || route === 'MODEL';
}
