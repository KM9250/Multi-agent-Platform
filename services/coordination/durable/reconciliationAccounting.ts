import type { CoordinationSnapshot, WorkflowUsage } from '../types';
import type { RunnerModelUsage } from '../runner/types';
import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import { addAmounts, costMicros, safeAmount, usageAmounts, zeroAmounts } from './modelBudgetGuard';
import { readJournal } from './restore';
import { readReconciliationReceipt } from './reconciliationStore';
import { effectiveModelRows } from './safeRecoveryModelState';

/** A historical settlement remains valid after expiry, lease changes and later
 * business events. Only immutable provenance is checked here. */
export function readReconciledModelUsage(tx: DurableTransaction, workflowRunId: string, modelCallId: string): Row | undefined {
  const row = tx.get('SELECT * FROM reconciled_model_usages WHERE workflow_run_id=? AND model_call_id=?', workflowRunId, modelCallId);
  if (!row) return;
  const model = tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?', workflowRunId, modelCallId);
  const attempt = tx.get('SELECT * FROM model_call_attempts WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?', workflowRunId, modelCallId, row.attempt_id);
  requireIntegrity(model && attempt && model.attempt_id === row.attempt_id);
  const source = parseJson<{ model: Row; attempt: Row }>(row.source_json);
  requireIntegrity(row.source_digest === digest(source) && canonicalJson(source) === canonicalJson({ model, attempt }));
  const usage = parseJson<RunnerModelUsage>(row.usage_json), amounts = usageAmounts(usage);
  requireIntegrity(row.usage_digest === digest(usage) && row.llm_calls === 1 && row.input_tokens === amounts.inputTokens
    && row.output_tokens === amounts.outputTokens && row.cost_micros === amounts.costMicros);
  const authority = tx.get('SELECT * FROM model_usage_authorities WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?', workflowRunId, modelCallId, row.attempt_id);
  requireIntegrity(authority && authority.authority === 'RECONCILED' && authority.operation_id === row.operation_id
    && authority.usage_event_id === null && authority.usage_json === row.usage_json && authority.usage_digest === row.usage_digest
    && authority.cost_micros === row.cost_micros);
  const operation = tx.get('SELECT * FROM reconciliation_operations WHERE workflow_run_id=? AND operation_id=?', workflowRunId, row.operation_id);
  requireIntegrity(operation && operation.operation_kind === 'SETTLE_VERIFIED_MODEL_USAGE');
  const receipt = readReconciliationReceipt(tx, String(operation.plan_id));
  requireIntegrity(receipt?.operationId === row.operation_id);
  return row;
}

/** Journal usage includes legacy/non-model usage. Only RECONCILED authorities
 * contribute the additional amount; NORMAL authorities must never be summed. */
export function effectiveAccounting(tx: DurableTransaction, workflowRunId: string, snapshot = readJournal(tx, workflowRunId).snapshot) {
  let journal = zeroAmounts(), reconciled = zeroAmounts();
  for (const event of snapshot.events) if (event.type === 'UsageRecorded') {
    const usage = event.payload as RunnerModelUsage;
    journal = addAmounts(journal, { llmCalls: safeAmount(usage.llmCalls), inputTokens: safeAmount(usage.inputTokens),
      outputTokens: safeAmount(usage.outputTokens), costMicros: costMicros(usage.estimatedCost) });
  }
  for (const authority of tx.all("SELECT * FROM model_usage_authorities WHERE workflow_run_id=? AND authority='RECONCILED' ORDER BY model_call_id", workflowRunId)) {
    const row = readReconciledModelUsage(tx, workflowRunId, String(authority.model_call_id));
    requireIntegrity(row && row.operation_id === authority.operation_id);
    reconciled = addAmounts(reconciled, usageAmounts(parseJson<RunnerModelUsage>(row.usage_json)));
  }
  return { journal, reconciled, committed: addAmounts(journal, reconciled) };
}

export function effectiveReservations(tx: DurableTransaction, workflowRunId: string) {
  let outstanding = zeroAmounts();
  for (const { historical } of effectiveModelRows(tx,workflowRunId).filter(row=>row.outstandingReservation))
    outstanding = addAmounts(outstanding, { llmCalls:Number(historical.reserved_calls),inputTokens:Number(historical.reserved_input),
      outputTokens:Number(historical.reserved_output),costMicros:Number(historical.reserved_cost) });
  return outstanding;
}

/** Snapshot itself remains the replay result. Runtime budget policy uses this
 * separate projection, retaining all non-accounting counters from that replay. */
export function effectiveWorkflowUsage(tx: DurableTransaction, workflowRunId: string, snapshot?: CoordinationSnapshot): WorkflowUsage {
  const source = snapshot ?? readJournal(tx, workflowRunId).snapshot;
  const { committed } = effectiveAccounting(tx, workflowRunId, source);
  return { ...source.run.usage, llmCalls: committed.llmCalls, inputTokens: committed.inputTokens,
    outputTokens: committed.outputTokens, estimatedCost: committed.costMicros / 1_000_000 };
}

/** Includes decisions which change effective state, but deliberately excludes
 * candidate submission, Plans, Grants, audit appends and lease heartbeats. */
export function reconciliationStateDigest(tx: DurableTransaction, workflowRunId: string): string {
  const rows = (table: string) => tx.all(`SELECT * FROM ${table} WHERE workflow_run_id=? ORDER BY rowid`, workflowRunId);
  return digest({ usages: rows('reconciled_model_usages'), authorities: rows('model_usage_authorities'),
    outcomes: rows('reconciled_action_outcomes'), applications: rows('reconciled_action_applications'),
    disputes: rows('reconciliation_disputes'), seals: rows('reconciliation_target_seals') });
}
