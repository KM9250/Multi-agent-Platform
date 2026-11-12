import type { PreparedRunnerAction, RunnerExecutionResult } from '../runner/types';
import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import { readJournal } from './restore';
import { readReconciliationReceipt } from './reconciliationStore';

/** This validates the original rows and an immutable operation receipt. It does
 * not reinterpret the old execution Result or rewrite its historical meaning. */
export function readReconciledActionOutcome(tx: DurableTransaction, workflowRunId: string, actionId: string): Row | undefined {
  const row = tx.get('SELECT * FROM reconciled_action_outcomes WHERE workflow_run_id=? AND action_id=?', workflowRunId, actionId);
  if (!row) return;
  const ledger = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id=? AND action_id=?', workflowRunId, actionId);
  const pending = tx.get('SELECT * FROM pending_actions WHERE workflow_run_id=? AND action_id=?', workflowRunId, actionId);
  const source = parseJson<{ ledger: Row; pending: Row }>(row.source_json);
  requireIntegrity(ledger && pending && ledger.attempt_id === row.attempt_id && row.source_digest === digest(source)
    && canonicalJson(source) === canonicalJson({ ledger, pending }));
  const operation = tx.get('SELECT * FROM reconciliation_operations WHERE workflow_run_id=? AND operation_id=?', workflowRunId, row.operation_id);
  requireIntegrity(operation && operation.operation_kind === 'RECORD_VERIFIED_ACTION_OUTCOME'
    && readReconciliationReceipt(tx, String(operation.plan_id))?.operationId === row.operation_id);
  return row;
}

export function readReconciledActionApplication(tx: DurableTransaction, workflowRunId: string, actionId: string): Row | undefined {
  const application = tx.get('SELECT * FROM reconciled_action_applications WHERE workflow_run_id=? AND action_id=?', workflowRunId, actionId);
  if (!application) return;
  const outcome = readReconciledActionOutcome(tx, workflowRunId, actionId);
  requireIntegrity(outcome && application.outcome_operation_id === outcome.operation_id && application.attempt_id === outcome.attempt_id);
  const result = parseJson<RunnerExecutionResult>(application.result_json);
  requireIntegrity(application.result_digest === digest(result) && result.resultRef === application.result_ref);
  const event = readJournal(tx, workflowRunId).snapshot.events.find(e => e.eventId === application.event_id);
  requireIntegrity(event && ['TaskCompleted', 'TaskFailed'].includes(event.type)
    && (event.payload as { taskId?: string }).taskId === application.task_id);
  const operation = tx.get('SELECT * FROM reconciliation_operations WHERE workflow_run_id=? AND operation_id=?', workflowRunId, application.operation_id);
  requireIntegrity(operation && operation.operation_kind === 'APPLY_RECONCILED_ACTION_RESULT'
    && readReconciliationReceipt(tx, String(operation.plan_id))?.operationId === application.operation_id);
  return application;
}

export interface EffectiveActionRow {
  historical: Row; outcome?: Row; application?: Row;
  outcomeState: string; applicationState: string;
  disputed: boolean; unresolved: boolean; obligations: string[];
}

export function effectiveActionRows(tx: DurableTransaction, workflowRunId: string): EffectiveActionRow[] {
  const snapshot = readJournal(tx, workflowRunId).snapshot;
  return tx.all('SELECT * FROM execution_ledger WHERE workflow_run_id=? ORDER BY action_id', workflowRunId).map(historical => {
    const actionId = String(historical.action_id), outcome = readReconciledActionOutcome(tx, workflowRunId, actionId);
    const application = readReconciledActionApplication(tx, workflowRunId, actionId);
    const disputed = !!tx.get("SELECT dispute_id FROM reconciliation_disputes WHERE workflow_run_id=? AND target_kind='ACTION' AND target_id=?", workflowRunId, actionId);
    const obligations: string[] = [];
    const final = !!outcome && ['EXECUTED_FINAL', 'NOT_EXECUTED_FINAL'].includes(String(outcome.outcome_kind));
    if (disputed) obligations.push('DISPUTED');
    if (!final && ['DISPATCH_RESERVED', 'REVIEW_REQUIRED'].includes(String(historical.state))) obligations.push('ACTION_OUTCOME_UNKNOWN');
    if (historical.review_reason === 'SECURITY_REVIEW_REQUIRED') obligations.push('SECURITY_REVIEW_REQUIRED');
    let applicationState = application ? 'APPLIED' : historical.state === 'FINALIZED' ? 'APPLIED' : 'NOT_APPLIED';
    if (outcome && !application && historical.state !== 'FINALIZED') {
      const task = snapshot.tasks[String(historical.task_id)], session = snapshot.sessions[String(historical.session_id)];
      if (!outcome.result_json) obligations.push('RESULT_DETAILS_MISSING');
      if (task?.status !== 'ASSIGNED' || session?.state !== 'OPEN' || snapshot.run.status !== 'RUNNING') {
        applicationState = 'APPLICATION_INELIGIBLE'; obligations.push('APPLICATION_INELIGIBLE');
      } else obligations.push('ACTION_RESULT_NOT_APPLIED');
    } else if (!application && historical.state === 'RESULT_RECORDED') obligations.push('ACTION_RESULT_NOT_APPLIED');
    return { historical, outcome, application, disputed, obligations, unresolved: obligations.length > 0,
      outcomeState: disputed ? 'DISPUTED' : outcome ? String(outcome.outcome_kind) : String(historical.state), applicationState };
  });
}

export function reconciliationHasDisputes(tx: DurableTransaction, workflowRunId: string): boolean {
  return !!tx.get('SELECT dispute_id FROM reconciliation_disputes WHERE workflow_run_id=? LIMIT 1', workflowRunId);
}

/** Exact structural match is a conservative replay stop, not a claim about
 * semantic equality or an external provider's idempotency guarantees. */
export function hasReconciledActionRepeat(tx: DurableTransaction, workflowRunId: string, action: PreparedRunnerAction): boolean {
  for(const row of tx.all(`SELECT p.action_id,p.prepared_action_json FROM pending_actions p JOIN reconciled_action_outcomes o
    ON o.workflow_run_id=p.workflow_run_id AND o.action_id=p.action_id WHERE p.workflow_run_id=? AND p.action_id<>?
    AND p.executor_id=? AND p.operation=? AND p.fingerprint=?`,workflowRunId,action.actionId,action.executorId,action.operation,action.fingerprint)) {
    const prior=parseJson<PreparedRunnerAction>(row.prepared_action_json);
    if(digest(prior.payload)===digest(action.payload)) {
      requireIntegrity(readReconciledActionOutcome(tx,workflowRunId,String(row.action_id)));
      return true;
    }
  }
  return false;
}
