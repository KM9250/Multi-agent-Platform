import type { DurableTransaction, Row } from './db';
import { digest, parseJson, requireIntegrity } from './integrity';
import type { RecoveryExecutionPlan, RecoveryOperationReceipt } from './safeRecoveryTypes';
import { SAFE_RECOVERY_CONTRACT } from './safeRecoveryTypes';

const events = ['RECOVERY_EXECUTION_PLAN_CREATED','RECOVERY_EXECUTION_AUTHORIZED','RECOVERY_EXECUTION_REVOKED',
  'RECOVERY_GRANT_CONSUMED','RECOVERY_OPERATION_COMMITTED','RECOVERY_HOLD_STEP_APPLIED',
  'RECOVERY_MODEL_CANCELLED_UNSENT','RECOVERY_MODEL_RESPONSE_DISCARDED','RECOVERY_SAFETY_STOP_COMPLETED'];

/** The v4B foreign keys never enter the v4A audit validator. Historical audits
 * remain valid after a grant is consumed, revoked, or its lease is superseded. */
export function validateSafeRecoveryAudit(tx: DurableTransaction, row: Row): boolean {
  if (!events.includes(String(row.event_kind))) {
    requireIntegrity(['execution_plan_id','execution_authorization_id','recovery_operation_id'].every(k => row[k] == null));
    return false;
  }
  requireIntegrity(row.recovery_plan_id === null && row.recovery_authorization_id === null
    && row.entity_kind === 'WORKFLOW' && row.entity_id === row.workflow_run_id
    && ['session_id','task_id','action_id','attempt_id','model_call_id','journal_event_id','journal_sequence','actor_agent_id','subject_agent_id'].every(k => row[k] === null));
  const p = tx.get('SELECT * FROM recovery_execution_plans WHERE execution_plan_id=? AND workflow_run_id=?', row.execution_plan_id, row.workflow_run_id);
  requireIntegrity(p && p.contract_version === SAFE_RECOVERY_CONTRACT);
  const plan = parseJson<RecoveryExecutionPlan>(p.plan_json), { planDigest, ...body } = plan;
  requireIntegrity(planDigest === p.plan_digest && digest(body) === planDigest
    && plan.operationContractVersion === SAFE_RECOVERY_CONTRACT && plan.executionPlanId === p.execution_plan_id
    && plan.workflowRunId === row.workflow_run_id && plan.operationKind === p.operation_kind && plan.targetId === p.target_id
    && plan.runtimeInstanceId === p.runtime_instance_id && plan.runtimeGeneration === p.runtime_generation);
  if (row.event_kind === 'RECOVERY_EXECUTION_PLAN_CREATED') {
    requireIntegrity(row.execution_authorization_id === null && row.recovery_operation_id === null && row.recovery_hold_revision === null
      && row.recovery_record_digest === plan.planDigest && row.recovery_actor_id === plan.createdByActorId
      && row.previous_state === null && row.next_state === 'DRAFT' && row.reason_code === null
      && row.runtime_instance_id === plan.runtimeInstanceId && row.runtime_generation === plan.runtimeGeneration);
    return true;
  }
  if (['RECOVERY_EXECUTION_AUTHORIZED','RECOVERY_EXECUTION_REVOKED','RECOVERY_GRANT_CONSUMED'].includes(String(row.event_kind))) {
    const grant = tx.get('SELECT * FROM recovery_execution_grants WHERE authorization_id=? AND execution_plan_id=? AND workflow_run_id=?',
      row.execution_authorization_id, row.execution_plan_id, row.workflow_run_id);
    requireIntegrity(grant && grant.contract_version === SAFE_RECOVERY_CONTRACT && grant.plan_digest === plan.planDigest
      && row.recovery_record_digest === grant.grant_digest && row.recovery_hold_revision === null);
    if (row.event_kind === 'RECOVERY_EXECUTION_AUTHORIZED') {
      requireIntegrity(row.recovery_operation_id === null && row.recovery_actor_id === grant.authorized_actor_id
        && row.previous_state === 'DRAFT' && row.next_state === 'AUTHORIZED' && row.reason_code === null
        && row.runtime_instance_id === grant.runtime_instance_id && row.runtime_generation === grant.runtime_generation);
      return true;
    }
    requireIntegrity(row.previous_state === 'AUTHORIZED');
    if (row.event_kind === 'RECOVERY_EXECUTION_REVOKED') {
      requireIntegrity(grant.status === 'REVOKED' && row.next_state === 'REVOKED' && row.recovery_operation_id === null
        && row.recovery_actor_id === grant.revoked_actor_id && row.reason_code === grant.revocation_reason);
      return true;
    }
    requireIntegrity(grant.status === 'CONSUMED' && row.next_state === 'CONSUMED' && row.reason_code === null
      && row.recovery_operation_id === grant.consumed_operation_id
      && tx.get('SELECT authorization_id FROM recovery_operation_grants WHERE operation_id=? AND authorization_id=? AND execution_plan_id=? AND workflow_run_id=?',
        row.recovery_operation_id, grant.authorization_id, plan.executionPlanId, row.workflow_run_id));
  } else requireIntegrity(row.execution_authorization_id === null && row.reason_code === null);
  const op = tx.get('SELECT * FROM recovery_execution_operations WHERE operation_id=? AND execution_plan_id=? AND workflow_run_id=?',
    row.recovery_operation_id, row.execution_plan_id, row.workflow_run_id);
  requireIntegrity(op && op.contract_version === SAFE_RECOVERY_CONTRACT && op.result_state === 'COMMITTED'
    && op.operation_kind === plan.operationKind && op.target_id === plan.targetId && op.plan_digest === plan.planDigest
    && row.recovery_actor_id === op.actor_id && row.runtime_instance_id === op.runtime_instance_id
    && row.runtime_generation === op.runtime_generation);
  const receipt = parseJson<RecoveryOperationReceipt>(op.receipt_json);
  requireIntegrity(digest(receipt) === op.receipt_digest && receipt.operationId === op.operation_id
    && receipt.executionPlanId === plan.executionPlanId && receipt.workflowRunId === row.workflow_run_id
    && receipt.operationContractVersion === SAFE_RECOVERY_CONTRACT && receipt.status === 'COMMITTED');
  if (row.event_kind === 'RECOVERY_GRANT_CONSUMED') return true;
  requireIntegrity(row.recovery_record_digest === op.receipt_digest);
  if (row.event_kind === 'RECOVERY_HOLD_STEP_APPLIED') {
    const transition = tx.get('SELECT * FROM recovery_hold_transitions WHERE workflow_run_id=? AND operation_id=?', row.workflow_run_id, op.operation_id);
    requireIntegrity(transition && transition.revision === row.recovery_hold_revision && transition.state === row.next_state
      && transition.previous_revision === plan.recoveryHoldRevision && row.previous_state === 'HELD'
      && receipt.holdRevision === transition.revision && receipt.holdState === transition.state);
    return true;
  }
  requireIntegrity(row.recovery_hold_revision === null && row.previous_state === null && row.next_state === 'COMMITTED');
  if (row.event_kind === 'RECOVERY_MODEL_CANCELLED_UNSENT' || row.event_kind === 'RECOVERY_MODEL_RESPONSE_DISCARDED') {
    const resolution = tx.get('SELECT * FROM recovery_model_resolutions WHERE operation_id=? AND model_call_id=? AND workflow_run_id=?',
      op.operation_id, plan.targetId, row.workflow_run_id);
    const cancel = row.event_kind === 'RECOVERY_MODEL_CANCELLED_UNSENT';
    requireIntegrity(resolution && plan.operationKind === (cancel ? 'CANCEL_UNSENT_MODEL' : 'DISCARD_SETTLED_RESPONSE')
      && resolution.resolution_kind === (cancel ? 'CANCELLED_UNSENT' : 'DISCARDED_BY_RECOVERY')
      && digest(parseJson(resolution.source_json)) === resolution.source_digest);
  }
  if (row.event_kind === 'RECOVERY_SAFETY_STOP_COMPLETED') requireIntegrity(plan.operationKind === 'COMPLETE_SAFETY_STOP');
  return true;
}
