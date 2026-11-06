import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { VerifiedRecoveryIdentity } from './recoveryDecisionTypes';
import { canonicalJson, digest, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { recoveryExpiry, recoveryTime } from './recoveryPlanner';
import { assertExecutionPlanCurrent, buildExecutionPlan, modelRecoveryTarget, verifyExecutionPlanDigest } from './safeRecoveryPlanner';
import { inspectSafeRecoveryAction, applySafeRecoveryAction, readValidatedRecoveryActionReceipt } from './safeRecoveryActions';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { readJournal } from './restore';
import { recordedResultEvent, inspectUncertainStop } from './executionReader';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { evaluateRunnerActionRisk } from '../runner/policyGuard';
import type { PreparedRunnerAction } from '../runner/types';
import { validateAuditRow } from './recoveryAudit';
import { findExhaustedBudget } from '../policy';
import { SAFE_RECOVERY_CONTRACT } from './safeRecoveryTypes';
import type { RecoveryExecutionGrant, RecoveryExecutionGrantScope, RecoveryExecutionPlan, RecoveryOperationReceipt, SafeRecoveryCommand, SafeRecoveryIntent } from './safeRecoveryTypes';

export const executionScopeOf = (plan: RecoveryExecutionGrantScope): RecoveryExecutionGrantScope => ({
  workflowRunId: plan.workflowRunId, operationKind: plan.operationKind, targetId: plan.targetId,
  planDigest: plan.planDigest, operationContractVersion: plan.operationContractVersion,
});
export function safeRecoveryOperationId(plan: RecoveryExecutionPlan): string {
  return `recovery-operation-${digest([SAFE_RECOVERY_CONTRACT, plan.executionPlanId, plan.planDigest])}`;
}
export function readExecutionPlan(tx: DurableTransaction, id: string): RecoveryExecutionPlan {
  const row = tx.get('SELECT * FROM recovery_execution_plans WHERE execution_plan_id=?', id);
  if (!row) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const plan = parseJson<RecoveryExecutionPlan>(row.plan_json); verifyExecutionPlanDigest(plan);
  requireIntegrity(row.execution_plan_id === plan.executionPlanId && row.workflow_run_id === plan.workflowRunId
    && row.operation_kind === plan.operationKind && row.target_id === plan.targetId && row.plan_digest === plan.planDigest
    && row.runtime_instance_id === plan.runtimeInstanceId && row.runtime_generation === plan.runtimeGeneration
    && row.journal_cursor === plan.journalCursor && row.hold_revision === plan.recoveryHoldRevision
    && row.contract_version === plan.operationContractVersion && row.created_at === plan.createdAt && row.expires_at === plan.expiresAt);
  const audits = tx.all("SELECT * FROM runtime_audit_events WHERE execution_plan_id=? AND event_kind='RECOVERY_EXECUTION_PLAN_CREATED'", id);
  requireIntegrity(audits.length === 1 && audits[0].recovery_record_digest === plan.planDigest
    && audits[0].recovery_actor_id === plan.createdByActorId && audits[0].runtime_instance_id === plan.runtimeInstanceId
    && audits[0].runtime_generation === plan.runtimeGeneration);
  return plan;
}
function grantBody(row: Row) {
  return { authorizationId: String(row.authorization_id), executionPlanId: String(row.execution_plan_id),
    workflowRunId: String(row.workflow_run_id), operationKind: row.operation_kind as RecoveryExecutionGrant['operationKind'],
    targetId: String(row.target_id), planDigest: String(row.plan_digest), operationContractVersion: row.contract_version as typeof SAFE_RECOVERY_CONTRACT,
    authorizedActorId: String(row.authorized_actor_id), authorizerRole: row.authorizer_role as RecoveryExecutionGrant['authorizerRole'],
    authorizationSource: String(row.authorization_source), authorizedAt: Number(row.authorized_at), expiresAt: Number(row.expires_at),
    runtimeInstanceId: String(row.runtime_instance_id), runtimeGeneration: Number(row.runtime_generation) };
}
export function readExecutionGrant(tx: DurableTransaction, id: string): RecoveryExecutionGrant {
  const row = tx.get('SELECT * FROM recovery_execution_grants WHERE authorization_id=?', id);
  if (!row) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const body = grantBody(row), plan = readExecutionPlan(tx, body.executionPlanId);
  requireIntegrity(row.grant_digest === digest(body) && body.operationContractVersion === SAFE_RECOVERY_CONTRACT
    && canonicalJson(executionScopeOf(body)) === canonicalJson(executionScopeOf(plan))
    && body.runtimeInstanceId === plan.runtimeInstanceId && body.runtimeGeneration === plan.runtimeGeneration
    && ['RECOVERY_APPROVER','RECOVERY_ADMIN'].includes(body.authorizerRole)
    && body.expiresAt <= plan.expiresAt && body.expiresAt === recoveryExpiry(body.authorizedAt, body.expiresAt - body.authorizedAt)
    && ['AUTHORIZED','REVOKED','CONSUMED'].includes(String(row.status)));
  const audits = tx.all('SELECT * FROM runtime_audit_events WHERE execution_authorization_id=? ORDER BY audit_sequence', id);
  requireIntegrity(audits.length === (row.status === 'AUTHORIZED' ? 1 : 2)
    && audits[0].event_kind === 'RECOVERY_EXECUTION_AUTHORIZED' && audits[0].recovery_actor_id === body.authorizedActorId
    && audits.every(a => a.recovery_record_digest === row.grant_digest && a.execution_plan_id === body.executionPlanId));
  if (row.status === 'REVOKED') requireIntegrity(audits[1].event_kind === 'RECOVERY_EXECUTION_REVOKED'
    && audits[1].recovery_actor_id === row.revoked_actor_id && audits[1].reason_code === row.revocation_reason && row.consumed_operation_id === null);
  if (row.status === 'CONSUMED') requireIntegrity(audits[1].event_kind === 'RECOVERY_GRANT_CONSUMED'
    && audits[1].recovery_operation_id === row.consumed_operation_id && typeof row.consumed_operation_id === 'string');
  if (row.status === 'AUTHORIZED') requireIntegrity(row.consumed_operation_id === null);
  return { ...body, status: row.status === 'AUTHORIZED' && recoveryTime(tx) >= body.expiresAt ? 'EXPIRED' : row.status as RecoveryExecutionGrant['status'],
    consumedOperationId: row.consumed_operation_id as string | null, revocationReason: row.revocation_reason as RecoveryExecutionGrant['revocationReason'],
    revokedAt: row.revoked_at as number | null, revokedByActorId: row.revoked_actor_id as string | null };
}
function targetDigest(tx: DurableTransaction, plan: RecoveryExecutionPlan): string {
  if (plan.operationKind === 'REFLECT_RECORDED_RESULT' || plan.operationKind === 'COMPLETE_SAFETY_STOP') {
    const row = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id=? AND action_id=?', plan.workflowRunId, plan.targetId);
    requireIntegrity(row); return digest(row);
  }
  const model = tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?', plan.workflowRunId, plan.targetId);
  const attempt = tx.get('SELECT * FROM model_call_attempts WHERE workflow_run_id=? AND model_call_id=?', plan.workflowRunId, plan.targetId);
  requireIntegrity(model && attempt);
  return digest({ model, attempt });
}
/** Verifies a committed receipt only. It never re-enters a business mutation callback. */
export function readSafeRecoveryReceipt(tx: DurableTransaction, executionPlanId: string): RecoveryOperationReceipt | undefined {
  const plan = readExecutionPlan(tx, executionPlanId);
  const row = tx.get('SELECT * FROM recovery_execution_operations WHERE execution_plan_id=?', executionPlanId);
  if (!row) return;
  const receipt = parseJson<RecoveryOperationReceipt>(row.receipt_json), operationId = safeRecoveryOperationId(plan);
  requireIntegrity(row.receipt_digest === digest(receipt) && row.operation_id === operationId && receipt.operationId === operationId
    && row.execution_plan_id === plan.executionPlanId && receipt.executionPlanId === plan.executionPlanId
    && row.workflow_run_id === plan.workflowRunId && receipt.workflowRunId === plan.workflowRunId
    && row.operation_kind === plan.operationKind && receipt.operationKind === plan.operationKind
    && row.target_id === plan.targetId && receipt.targetId === plan.targetId && row.plan_digest === plan.planDigest && receipt.planDigest === plan.planDigest
    && row.runtime_instance_id === plan.runtimeInstanceId && receipt.runtimeInstanceId === plan.runtimeInstanceId
    && row.runtime_generation === plan.runtimeGeneration && receipt.runtimeGeneration === plan.runtimeGeneration
    && row.contract_version === SAFE_RECOVERY_CONTRACT && receipt.operationContractVersion === SAFE_RECOVERY_CONTRACT
    && row.actor_id === receipt.actorId && row.committed_at === receipt.committedAt && row.result_state === 'COMMITTED'
    && receipt.status === 'COMMITTED' && receipt.beforeJournalCursor === plan.journalCursor
    && receipt.previousHoldRevision === plan.recoveryHoldRevision && receipt.holdRevision === plan.recoveryHoldRevision + 1);
  const links = tx.all('SELECT * FROM recovery_operation_grants WHERE operation_id=? ORDER BY authorization_id', operationId);
  requireIntegrity(canonicalJson(links.map(r => r.authorization_id)) === canonicalJson(receipt.grantIds)
    && links.length >= plan.authorizationRequirements.approvalPolicy.minimumApprovers);
  const actors = new Set<string>();
  for (const link of links) {
    requireIntegrity(link.workflow_run_id === plan.workflowRunId && link.execution_plan_id === executionPlanId);
    const grant = readExecutionGrant(tx, String(link.authorization_id));
    requireIntegrity(grant.status === 'CONSUMED' && grant.consumedOperationId === operationId && grant.executionPlanId === executionPlanId
      && grant.authorizedAt <= receipt.committedAt && receipt.committedAt < grant.expiresAt
      && (!plan.authorizationRequirements.approvalPolicy.forbidSelfApproval || grant.authorizedActorId !== plan.createdByActorId)
      && !actors.has(grant.authorizedActorId)); actors.add(grant.authorizedActorId);
    const consumedAudit = tx.all("SELECT * FROM runtime_audit_events WHERE execution_authorization_id=? AND event_kind='RECOVERY_GRANT_CONSUMED'", grant.authorizationId);
    requireIntegrity(consumedAudit.length === 1 && consumedAudit[0].recovery_actor_id === receipt.actorId
      && consumedAudit[0].runtime_instance_id === receipt.runtimeInstanceId && consumedAudit[0].runtime_generation === receipt.runtimeGeneration
      && consumedAudit[0].workflow_run_id === receipt.workflowRunId);
    validateAuditRow(tx, consumedAudit[0]);
  }
  const snapshot = readJournal(tx, plan.workflowRunId).snapshot;
  requireIntegrity(receipt.afterJournalCursor >= receipt.beforeJournalCursor && receipt.afterJournalCursor <= snapshot.events.length);
  const events = snapshot.events.slice(receipt.beforeJournalCursor, receipt.afterJournalCursor);
  requireIntegrity(canonicalJson(events.map(e => e.eventId)) === canonicalJson(receipt.journalEventIds)
    && digest(events) === receipt.journalDigest && targetDigest(tx, plan) === receipt.afterTargetDigest);
  const resolution = tx.get('SELECT * FROM recovery_model_resolutions WHERE operation_id=?', operationId);
  if (receipt.resolutionKind) {
    requireIntegrity(resolution && resolution.model_call_id === plan.targetId && resolution.workflow_run_id === plan.workflowRunId
      && resolution.resolution_kind === receipt.resolutionKind && resolution.source_digest === receipt.beforeTargetDigest
      && digest(parseJson(resolution.source_json)) === receipt.beforeTargetDigest && events.length === 0);
    requireIntegrity(receipt.beforeTargetDigest === receipt.afterTargetDigest
      && receipt.resolutionKind === (plan.operationKind === 'CANCEL_UNSENT_MODEL' ? 'CANCELLED_UNSENT' : plan.operationKind === 'DISCARD_SETTLED_RESPONSE' ? 'DISCARDED_BY_RECOVERY' : null));
    const source = parseJson<{model: Row; attempt: Row}>(resolution.source_json);
    requireIntegrity(resolution.attempt_id === source.model.attempt_id && source.attempt.attempt_id === source.model.attempt_id
      && resolution.original_runtime_instance_id === source.model.runtime_instance_id && resolution.original_generation === source.model.generation
      && source.model.model_call_id === plan.targetId && source.model.workflow_run_id === plan.workflowRunId
      && canonicalJson(parseJson(resolution.reservation_json)) === canonicalJson({llmCalls:source.model.reserved_calls,inputTokens:source.model.reserved_input,outputTokens:source.model.reserved_output,costMicros:source.model.reserved_cost}));
    if (receipt.resolutionKind === 'CANCELLED_UNSENT') requireIntegrity(source.model.state === 'RESERVED' && source.attempt.state === 'RESERVED' && source.attempt.dispatch_intent_at === null && source.attempt.attempt_number === 1);
    else requireIntegrity(source.model.state === 'SETTLED' && source.model.completeness === 'COMPLETE' && source.model.application_status === 'PENDING_APPLICATION' && source.model.application_event_id === null);
  } else {
    requireIntegrity(!resolution && events.length > 0);
    const action = tx.get('SELECT * FROM execution_ledger WHERE workflow_run_id=? AND action_id=?', plan.workflowRunId, plan.targetId)!;
    const { record, result } = readValidatedRecoveryActionReceipt(tx, snapshot, plan.targetId);
    requireIntegrity(!result.safetyHold);
    const expected = recordedResultEvent(snapshot, record, result, {now: () => receipt.committedAt});
    const finalized = snapshot.events.find(e => e.eventId === action.finalized_event_id);
    requireIntegrity(finalized && finalized.eventId === expected.eventId && finalized.type === expected.type
      && finalized.sessionId === expected.sessionId && finalized.actorAgentId === expected.actorAgentId
      && finalized.idempotencyKey === expected.idempotencyKey && canonicalJson(finalized.payload) === canonicalJson(expected.payload));
    requireIntegrity(plan.operationKind === 'REFLECT_RECORDED_RESULT' ? action.state === 'FINALIZED'
      && events.length === 1 && events[0].eventId === finalized.eventId
      : action.state === 'REVIEW_REQUIRED' && action.review_reason === 'EXECUTION_UNCERTAIN'
        && events.at(-1)?.type === 'WorkflowBlocked' && snapshot.tasks[String(action.task_id)]?.failureReason === 'EXECUTION_UNCERTAIN');
    if (plan.operationKind === 'COMPLETE_SAFETY_STOP') requireIntegrity(inspectUncertainStop(tx, snapshot, record, action, result, {now: () => receipt.committedAt})?.block?.eventId === events.at(-1)!.eventId);
    for (const event of events) {
      const audits = tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND event_kind='JOURNAL_APPENDED' AND journal_event_id=?", plan.workflowRunId, event.eventId);
      requireIntegrity(audits.length === 1 && audits[0].runtime_instance_id === receipt.runtimeInstanceId && audits[0].runtime_generation === receipt.runtimeGeneration);
      validateAuditRow(tx, audits[0]);
    }
    const finalizations = tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND event_kind='EXECUTION_CHANGED' AND journal_event_id=?", plan.workflowRunId, plan.targetId, finalized.eventId);
    requireIntegrity(finalizations.length === 1); validateAuditRow(tx, finalizations[0]);
    if (events.some(e => e.eventId === finalized.eventId)) requireIntegrity(finalizations[0].runtime_instance_id === receipt.runtimeInstanceId && finalizations[0].runtime_generation === receipt.runtimeGeneration);
  }
  const transition = tx.get('SELECT * FROM recovery_hold_transitions WHERE operation_id=?', operationId);
  requireIntegrity(transition && transition.workflow_run_id === plan.workflowRunId && transition.previous_revision === receipt.previousHoldRevision
    && transition.revision === receipt.holdRevision && transition.state === receipt.holdState && transition.created_at === receipt.committedAt);
  const committed = tx.all("SELECT * FROM runtime_audit_events WHERE recovery_operation_id=? AND event_kind='RECOVERY_OPERATION_COMMITTED'", operationId);
  const hold = tx.all("SELECT * FROM runtime_audit_events WHERE recovery_operation_id=? AND event_kind='RECOVERY_HOLD_STEP_APPLIED'", operationId);
  requireIntegrity(committed.length === 1 && hold.length === 1 && [...committed, ...hold].every(a =>
    a.execution_plan_id === executionPlanId && a.recovery_record_digest === row.receipt_digest && a.recovery_actor_id === receipt.actorId
      && a.runtime_instance_id === receipt.runtimeInstanceId && a.runtime_generation === receipt.runtimeGeneration));
  const kind = plan.operationKind === 'CANCEL_UNSENT_MODEL' ? 'RECOVERY_MODEL_CANCELLED_UNSENT'
    : plan.operationKind === 'DISCARD_SETTLED_RESPONSE' ? 'RECOVERY_MODEL_RESPONSE_DISCARDED'
    : plan.operationKind === 'COMPLETE_SAFETY_STOP' ? 'RECOVERY_SAFETY_STOP_COMPLETED' : undefined;
  if (kind) {
    const specific = tx.all('SELECT * FROM runtime_audit_events WHERE recovery_operation_id=? AND event_kind=?', operationId, kind);
    requireIntegrity(specific.length === 1 && specific[0].recovery_record_digest === row.receipt_digest
      && specific[0].recovery_actor_id === receipt.actorId && specific[0].runtime_instance_id === receipt.runtimeInstanceId
      && specific[0].runtime_generation === receipt.runtimeGeneration && specific[0].workflow_run_id === receipt.workflowRunId);
    validateAuditRow(tx, specific[0]);
  }
  for (const audit of [...committed, ...hold]) validateAuditRow(tx, audit);
  return receipt;
}
function nextHoldState(tx: DurableTransaction, id: string): RecoveryOperationReceipt['holdState'] {
  const unresolvedAction = tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED')", id);
  const unresolvedModel = tx.get(`SELECT m.model_call_id FROM model_call_ledger m WHERE m.workflow_run_id=? AND
    (m.budget_violation=1 OR (NOT EXISTS (SELECT 1 FROM recovery_model_resolutions r WHERE r.model_call_id=m.model_call_id)
      AND (m.state IN ('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED') OR m.application_status='PENDING_APPLICATION')))`, id);
  const snapshot = readJournal(tx, id).snapshot;
  const actions = tx.all('SELECT prepared_action_json FROM pending_actions WHERE workflow_run_id=?', id).map(r => parseJson<PreparedRunnerAction>(r.prepared_action_json));
  const missingHistory = Object.values(snapshot.tasks).some(t => !tx.get('SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND task_id=?', id, t.taskId));
  const review = runnerSecurityReviewReason(snapshot) || runnerEvidenceReviewReason(snapshot)
    || actions.some(a => evaluateRunnerActionRisk(snapshot, a) === 'DENY' || evaluateRunnerActionRisk(snapshot, a) === 'NEEDS_USER' && !runnerActionApproved(snapshot, a));
  const exhausted = findExhaustedBudget(snapshot.run.budget, snapshot.run.usage, Math.max(0, recoveryTime(tx) - snapshot.run.createdAt));
  return unresolvedAction || unresolvedModel || missingHistory || review || exhausted || snapshot.run.status !== 'RUNNING'
    || tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?', id)?.coverage !== 'TRACKED_FROM_CREATION'
    ? 'RECOVERY_STEP_APPLIED' : 'READY_FOR_CONTINUATION_REVIEW';
}
/** Internal fixed dispatcher. Public callers receive neither this closure nor its private SQL authority. */
export function persistSafeRecoveryDecision(db: DurableDatabase, tx: DurableTransaction, command: SafeRecoveryCommand,
  identity: VerifiedRecoveryIdentity, lease: WorkflowLease, setIntent: (intent: SafeRecoveryIntent) => void): RecoveryExecutionPlan | RecoveryExecutionGrant | RecoveryOperationReceipt | undefined {
  const now = recoveryTime(tx);
  if (command.kind === 'CREATE_PLAN') {
    const plan = buildExecutionPlan(db, tx, command.input, identity.actorId);
    setIntent({ kind: command.kind, workflowRunId: plan.workflowRunId, id: plan.executionPlanId, executionPlanId: plan.executionPlanId, actorId: identity.actorId, plan });
    tx.run(`INSERT INTO recovery_execution_plans (execution_plan_id,workflow_run_id,operation_kind,target_id,plan_json,plan_digest,
      runtime_instance_id,runtime_generation,journal_cursor,hold_revision,contract_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    plan.executionPlanId, plan.workflowRunId, plan.operationKind, plan.targetId, canonicalJson(plan), plan.planDigest, plan.runtimeInstanceId,
    plan.runtimeGeneration, plan.journalCursor, plan.recoveryHoldRevision, plan.operationContractVersion, plan.createdAt, plan.expiresAt);
    return readExecutionPlan(tx, plan.executionPlanId);
  }
  if (command.kind === 'REVOKE') {
    const grant = readExecutionGrant(tx, command.authorizationId);
    if (!['OPERATOR_REVOKED','POLICY_CHANGED'].includes(command.reason) || grant.status === 'CONSUMED'
      || grant.authorizedActorId !== identity.actorId && !identity.roles.includes('RECOVERY_ADMIN')) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    if (grant.status === 'REVOKED') { requireIntegrity(grant.revocationReason === command.reason); return grant; }
    setIntent({ kind: command.kind, workflowRunId: grant.workflowRunId, id: grant.authorizationId, executionPlanId: grant.executionPlanId, actorId: identity.actorId });
    tx.run("UPDATE recovery_execution_grants SET status='REVOKED',revocation_reason=?,revoked_at=?,revoked_actor_id=? WHERE authorization_id=?",
      command.reason, now, identity.actorId, grant.authorizationId);
    return readExecutionGrant(tx, grant.authorizationId);
  }
  const plan = readExecutionPlan(tx, command.executionPlanId);
  if (command.kind === 'RECEIPT') return readSafeRecoveryReceipt(tx, plan.executionPlanId);
  if (command.kind === 'EXECUTE' && tx.get('SELECT operation_id FROM recovery_execution_operations WHERE execution_plan_id=?', plan.executionPlanId))
    return readSafeRecoveryReceipt(tx, plan.executionPlanId);
  if (plan.runtimeInstanceId !== lease.runtimeInstanceId || plan.runtimeGeneration !== lease.generation) throw new DurableStoreError('LEASE_FENCED');
  assertExecutionPlanCurrent(db, tx, plan);
  if (command.kind === 'AUTHORIZE') {
    if (canonicalJson(command.scope) !== canonicalJson(executionScopeOf(plan))) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    if (plan.authorizationRequirements.approvalPolicy.forbidSelfApproval && plan.createdByActorId === identity.actorId) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    const prior = tx.get('SELECT authorization_id FROM recovery_execution_grants WHERE execution_plan_id=? AND authorized_actor_id=?', plan.executionPlanId, identity.actorId);
    if (prior) { const grant = readExecutionGrant(tx, String(prior.authorization_id)); if (grant.status !== 'AUTHORIZED') throw new DurableStoreError('RECOVERY_UNAUTHORIZED'); return grant; }
    const body = { authorizationId: randomUUID(), executionPlanId: plan.executionPlanId, ...executionScopeOf(plan), authorizedActorId: identity.actorId,
      authorizerRole: identity.roles.includes('RECOVERY_ADMIN') ? 'RECOVERY_ADMIN' as const : 'RECOVERY_APPROVER' as const,
      authorizationSource: identity.source, authorizedAt: now, expiresAt: Math.min(plan.expiresAt, identity.expiresAt, recoveryExpiry(now, command.ttlMs)),
      runtimeInstanceId: plan.runtimeInstanceId, runtimeGeneration: plan.runtimeGeneration };
    setIntent({ kind: command.kind, workflowRunId: plan.workflowRunId, id: body.authorizationId, executionPlanId: plan.executionPlanId, actorId: identity.actorId, plan });
    tx.run(`INSERT INTO recovery_execution_grants (authorization_id,execution_plan_id,workflow_run_id,operation_kind,target_id,plan_digest,
      authorized_actor_id,authorizer_role,authorization_source,authorized_at,expires_at,runtime_instance_id,runtime_generation,contract_version,
      status,revocation_reason,revoked_at,revoked_actor_id,grant_digest,consumed_operation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'AUTHORIZED',NULL,NULL,NULL,?,NULL)`,
    body.authorizationId, body.executionPlanId, body.workflowRunId, body.operationKind, body.targetId, body.planDigest, body.authorizedActorId,
    body.authorizerRole, body.authorizationSource, body.authorizedAt, body.expiresAt, body.runtimeInstanceId, body.runtimeGeneration, body.operationContractVersion, digest(body));
    return readExecutionGrant(tx, body.authorizationId);
  }
  if (command.kind !== 'EXECUTE') throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const grants = tx.all('SELECT authorization_id FROM recovery_execution_grants WHERE execution_plan_id=? ORDER BY authorization_id', plan.executionPlanId)
    .map(r => readExecutionGrant(tx, String(r.authorization_id))).filter(g => g.status === 'AUTHORIZED');
  const actors = new Set(grants.map(g => g.authorizedActorId));
  if (actors.size !== grants.length || grants.length < plan.authorizationRequirements.approvalPolicy.minimumApprovers
    || grants.some(g => plan.authorizationRequirements.approvalPolicy.forbidSelfApproval && g.authorizedActorId === plan.createdByActorId)) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const operationId = safeRecoveryOperationId(plan), grantIds = grants.map(g => g.authorizationId), beforeTargetDigest = targetDigest(tx, plan);
  const action = plan.operationKind === 'REFLECT_RECORDED_RESULT' || plan.operationKind === 'COMPLETE_SAFETY_STOP'
    ? inspectSafeRecoveryAction(db, tx, plan.workflowRunId, plan.targetId, plan.operationKind) : undefined;
  const model = action ? undefined : modelRecoveryTarget(tx, plan.workflowRunId, plan.targetId, plan.operationKind);
  setIntent({ kind: 'EXECUTE', workflowRunId: plan.workflowRunId, id: operationId, executionPlanId: plan.executionPlanId,
    actorId: identity.actorId, plan, operationId, grantIds, journalEvents: action?.journalEvents ?? [], expectedTargetDigest: beforeTargetDigest,
    expectedLedger: action?.row });
  let resolutionKind: RecoveryOperationReceipt['resolutionKind'] = null;
  if (action) applySafeRecoveryAction(new SqliteCoordinationRunnerStore(db, lease), tx, plan.workflowRunId, plan.targetId,
    plan.operationKind as 'REFLECT_RECORDED_RESULT' | 'COMPLETE_SAFETY_STOP');
  else {
    requireIntegrity(model);
    resolutionKind = plan.operationKind === 'CANCEL_UNSENT_MODEL' ? 'CANCELLED_UNSENT' : 'DISCARDED_BY_RECOVERY';
    tx.run(`INSERT INTO recovery_model_resolutions (model_call_id,workflow_run_id,attempt_id,operation_id,resolution_kind,
      original_runtime_instance_id,original_generation,source_digest,source_json,reservation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    plan.targetId, plan.workflowRunId, model.model.attempt_id, operationId, resolutionKind, model.model.runtime_instance_id, model.model.generation,
    model.sourceDigest, canonicalJson({ model: model.model, attempt: model.attempt }), canonicalJson(model.reservation), now);
  }
  if (recoveryTime(tx) >= Math.min(plan.expiresAt, identity.expiresAt, ...grants.map(g => g.expiresAt))) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  for (const grant of grants) tx.run("UPDATE recovery_execution_grants SET status='CONSUMED',consumed_operation_id=? WHERE authorization_id=? AND status='AUTHORIZED'", operationId, grant.authorizationId);
  const after = readJournal(tx, plan.workflowRunId).snapshot, events = after.events.slice(plan.journalCursor);
  const receipt: RecoveryOperationReceipt = { operationId, executionPlanId: plan.executionPlanId, workflowRunId: plan.workflowRunId,
    planDigest: plan.planDigest, operationKind: plan.operationKind, targetId: plan.targetId, status: 'COMMITTED', operationContractVersion: SAFE_RECOVERY_CONTRACT,
    actorId: identity.actorId, runtimeInstanceId: plan.runtimeInstanceId, runtimeGeneration: plan.runtimeGeneration, committedAt: now, grantIds,
    beforeJournalCursor: plan.journalCursor, afterJournalCursor: after.events.length, journalEventIds: events.map(e => e.eventId), journalDigest: digest(events),
    beforeTargetDigest, afterTargetDigest: targetDigest(tx, plan), resolutionKind, previousHoldRevision: plan.recoveryHoldRevision,
    holdRevision: plan.recoveryHoldRevision + 1, holdState: nextHoldState(tx, plan.workflowRunId) };
  tx.run(`INSERT INTO recovery_execution_operations (operation_id,execution_plan_id,workflow_run_id,operation_kind,target_id,plan_digest,
    receipt_json,receipt_digest,actor_id,runtime_instance_id,runtime_generation,committed_at,contract_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  operationId, plan.executionPlanId, plan.workflowRunId, plan.operationKind, plan.targetId, plan.planDigest, canonicalJson(receipt), digest(receipt),
  identity.actorId, plan.runtimeInstanceId, plan.runtimeGeneration, now, SAFE_RECOVERY_CONTRACT);
  for (const grant of grants) tx.run('INSERT INTO recovery_operation_grants (operation_id,authorization_id,workflow_run_id,execution_plan_id) VALUES (?,?,?,?)',
    operationId, grant.authorizationId, plan.workflowRunId, plan.executionPlanId);
  tx.run('INSERT INTO recovery_hold_transitions (workflow_run_id,revision,previous_revision,operation_id,state,created_at) VALUES (?,?,?,?,?,?)',
    plan.workflowRunId, receipt.holdRevision, receipt.previousHoldRevision, operationId, receipt.holdState, now);
  return readSafeRecoveryReceipt(tx, plan.executionPlanId);
}
