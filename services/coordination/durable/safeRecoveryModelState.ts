import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import type { RecoveryOperationReceipt, RecoveryExecutionPlan } from './safeRecoveryTypes';
import { readSafeRecoveryReceipt } from './safeRecoveryStore';

const CONTRACT = 'COORD-5C-4B:EXECUTE:1';

/** Historical rows remain authoritative. A resolution affects current obligations
 * only when its unchanged source and committed recovery provenance all agree. */
export function readModelRecoveryResolution(tx: DurableTransaction, workflowRunId: string, modelCallId: string): Row | undefined {
  const resolution = tx.get('SELECT * FROM recovery_model_resolutions WHERE workflow_run_id=? AND model_call_id=?', workflowRunId, modelCallId);
  if (!resolution) return;
  const model = tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?', workflowRunId, modelCallId);
  const attempts = tx.all('SELECT * FROM model_call_attempts WHERE workflow_run_id=? AND model_call_id=?', workflowRunId, modelCallId);
  requireIntegrity(model && attempts.length === 1);
  const attempt = attempts[0], source = parseJson<{ model: Row; attempt: Row }>(resolution.source_json);
  requireIntegrity(resolution.source_digest === digest(source)
    && canonicalJson(source) === canonicalJson({ model, attempt })
    && resolution.attempt_id === model.attempt_id && attempt.attempt_id === model.attempt_id
    && resolution.original_runtime_instance_id === model.runtime_instance_id && resolution.original_generation === model.generation
    && attempt.runtime_instance_id === model.runtime_instance_id && attempt.generation === model.generation);
  requireIntegrity(canonicalJson(parseJson(resolution.reservation_json)) === canonicalJson({ llmCalls: model.reserved_calls,
    inputTokens: model.reserved_input, outputTokens: model.reserved_output, costMicros: model.reserved_cost }));
  const cancelled = resolution.resolution_kind === 'CANCELLED_UNSENT';
  requireIntegrity(cancelled || resolution.resolution_kind === 'DISCARDED_BY_RECOVERY');
  requireIntegrity(cancelled
    ? model.state === 'RESERVED' && attempt.state === 'RESERVED' && attempt.attempt_number === 1 && attempt.dispatch_intent_at === null
    : model.state === 'SETTLED' && model.completeness === 'COMPLETE' && model.application_status === 'PENDING_APPLICATION'
      && model.application_event_id === null && model.application_digest === null && model.application_start_cursor === null);
  const operation = tx.get('SELECT * FROM recovery_execution_operations WHERE workflow_run_id=? AND operation_id=?', workflowRunId, resolution.operation_id);
  requireIntegrity(operation && operation.result_state === 'COMMITTED' && operation.contract_version === CONTRACT
    && operation.target_id === modelCallId && operation.operation_kind === (cancelled ? 'CANCEL_UNSENT_MODEL' : 'DISCARD_SETTLED_RESPONSE')
    && operation.receipt_digest === digest(parseJson(operation.receipt_json)));
  const receipt = parseJson<RecoveryOperationReceipt>(operation.receipt_json);
  requireIntegrity(receipt.operationId === operation.operation_id && receipt.workflowRunId === workflowRunId
    && receipt.executionPlanId === operation.execution_plan_id && receipt.planDigest === operation.plan_digest
    && receipt.operationKind === operation.operation_kind && receipt.targetId === modelCallId && receipt.status === 'COMMITTED'
    && receipt.operationContractVersion === CONTRACT && receipt.runtimeInstanceId === operation.runtime_instance_id
    && receipt.runtimeGeneration === operation.runtime_generation && receipt.committedAt === operation.committed_at
    && receipt.actorId === operation.actor_id && receipt.resolutionKind === resolution.resolution_kind
    && Array.isArray(receipt.grantIds) && receipt.grantIds.every(id => typeof id === 'string'));
  const plan = tx.get('SELECT * FROM recovery_execution_plans WHERE workflow_run_id=? AND execution_plan_id=?', workflowRunId, operation.execution_plan_id);
  requireIntegrity(plan && plan.contract_version === CONTRACT && plan.plan_digest === operation.plan_digest
    && plan.target_id === modelCallId && plan.operation_kind === operation.operation_kind
    && plan.runtime_instance_id === operation.runtime_instance_id && plan.runtime_generation === operation.runtime_generation);
  const savedPlan = parseJson<RecoveryExecutionPlan>(plan.plan_json), { planDigest, ...planBody } = savedPlan;
  requireIntegrity(planDigest === digest(planBody) && planDigest === operation.plan_digest
    && Number.isSafeInteger(savedPlan.authorizationRequirements?.approvalPolicy?.minimumApprovers)
    && savedPlan.authorizationRequirements.approvalPolicy.minimumApprovers >= 1);
  const links = tx.all('SELECT * FROM recovery_operation_grants WHERE workflow_run_id=? AND operation_id=?', workflowRunId, operation.operation_id);
  requireIntegrity(links.length >= savedPlan.authorizationRequirements.approvalPolicy.minimumApprovers
    && canonicalJson(links.map(link => link.authorization_id).sort()) === canonicalJson([...receipt.grantIds].sort()));
  const actors = new Set<string>();
  for (const link of links) {
    const grant = tx.get('SELECT * FROM recovery_execution_grants WHERE workflow_run_id=? AND authorization_id=?', workflowRunId, link.authorization_id);
    requireIntegrity(grant && link.execution_plan_id === operation.execution_plan_id && grant.execution_plan_id === operation.execution_plan_id
      && grant.status === 'CONSUMED' && grant.consumed_operation_id === operation.operation_id && grant.plan_digest === operation.plan_digest
      && grant.operation_kind === operation.operation_kind && grant.target_id === modelCallId && grant.contract_version === CONTRACT);
    requireIntegrity(!actors.has(String(grant.authorized_actor_id))
      && (!savedPlan.authorizationRequirements.approvalPolicy.forbidSelfApproval || grant.authorized_actor_id !== savedPlan.createdByActorId));
    actors.add(String(grant.authorized_actor_id));
    const audit = tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND execution_authorization_id=? AND recovery_operation_id=? AND event_kind='RECOVERY_GRANT_CONSUMED'", workflowRunId, grant.authorization_id, operation.operation_id);
    requireIntegrity(audit.length === 1 && audit[0].execution_plan_id === operation.execution_plan_id);
  }
  for (const kind of ['RECOVERY_OPERATION_COMMITTED', cancelled ? 'RECOVERY_MODEL_CANCELLED_UNSENT' : 'RECOVERY_MODEL_RESPONSE_DISCARDED', 'RECOVERY_HOLD_STEP_APPLIED']) {
    const audits = tx.all('SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND recovery_operation_id=? AND event_kind=?', workflowRunId, operation.operation_id, kind);
    requireIntegrity(audits.length === 1 && audits[0].execution_plan_id === operation.execution_plan_id
      && audits[0].runtime_instance_id === operation.runtime_instance_id && audits[0].runtime_generation === operation.runtime_generation);
  }
  const transition = tx.get('SELECT * FROM recovery_hold_transitions WHERE workflow_run_id=? AND operation_id=?', workflowRunId, operation.operation_id);
  requireIntegrity(transition && transition.revision === receipt.holdRevision && transition.previous_revision === receipt.previousHoldRevision
    && transition.state === receipt.holdState && transition.revision === Number(transition.previous_revision) + 1);
  requireIntegrity(readSafeRecoveryReceipt(tx, String(operation.execution_plan_id))?.operationId === operation.operation_id);
  return resolution;
}

export interface EffectiveModelRow {
  historical: Row; resolution?: Row;
  outstandingReservation: boolean; pendingApplication: boolean; unresolved: boolean;
}

/** Shared by budget accounting, coordinators, gates and recovery diagnostics. */
export function effectiveModelRows(tx: DurableTransaction, workflowRunId: string): EffectiveModelRow[] {
  return tx.all('SELECT * FROM model_call_ledger WHERE workflow_run_id=? ORDER BY model_call_id', workflowRunId).map(historical => {
    const resolution = readModelRecoveryResolution(tx, workflowRunId, String(historical.model_call_id));
    const outstandingReservation = ['RESERVED', 'DISPATCH_INTENT', 'REVIEW_REQUIRED'].includes(String(historical.state))
      && resolution?.resolution_kind !== 'CANCELLED_UNSENT';
    const pendingApplication = historical.application_status === 'PENDING_APPLICATION' && resolution?.resolution_kind !== 'DISCARDED_BY_RECOVERY';
    return { historical, resolution, outstandingReservation, pendingApplication,
      unresolved: outstandingReservation || pendingApplication || historical.budget_violation === 1 };
  });
}
