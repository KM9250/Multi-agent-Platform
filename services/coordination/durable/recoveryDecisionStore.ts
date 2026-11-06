import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import { canonicalJson, digest, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { assertPlanCurrent, buildRecoveryPlan, recoveryExpiry, recoveryTime, verifyPlanDigest } from './recoveryPlanner';
import { RECOVERY_CONTRACT } from './recoveryDecisionTypes';
import type { RecoveryAuthorization, RecoveryDecisionCommand, RecoveryGrantScope, RecoveryPlan, VerifiedRecoveryIdentity } from './recoveryDecisionTypes';

export function readRecoveryPlan(tx: DurableTransaction, id: string): RecoveryPlan {
  const row = tx.get('SELECT * FROM recovery_plans WHERE recovery_plan_id=?', id);
  if (!row) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const plan = parseJson<RecoveryPlan>(row.plan_json); verifyPlanDigest(plan);
  requireIntegrity(row.recovery_plan_id === plan.recoveryPlanId && row.workflow_run_id === plan.workflowRunId
    && row.operation_kind === plan.operationKind && row.target_id === plan.targetId && row.plan_digest === plan.planDigest
    && row.runtime_instance_id === plan.runtimeInstanceId && row.runtime_generation === plan.runtimeGeneration
    && row.journal_cursor === plan.journalCursor && row.hold_revision === plan.recoveryHoldRevision
    && row.contract_version === plan.operationContractVersion && row.created_at === plan.createdAt && row.expires_at === plan.expiresAt);
  const audits = tx.all("SELECT * FROM runtime_audit_events WHERE recovery_plan_id=? AND event_kind='RECOVERY_PLAN_CREATED'", id);
  requireIntegrity(audits.length === 1 && audits[0].recovery_record_digest === plan.planDigest && audits[0].recovery_actor_id === plan.createdByActorId);
  const invalidation = tx.get('SELECT * FROM recovery_plan_invalidations WHERE recovery_plan_id=?', id);
  const invalidations = tx.all("SELECT * FROM runtime_audit_events WHERE recovery_plan_id=? AND event_kind='RECOVERY_PLAN_INVALIDATED'", id);
  requireIntegrity(invalidations.length === (invalidation ? 1 : 0));
  if (invalidation) requireIntegrity(invalidations[0].recovery_actor_id === invalidation.invalidated_actor_id && invalidations[0].reason_code === invalidation.reason_code);
  return plan;
}
function grantBody(row: Row): Omit<RecoveryAuthorization, 'status' | 'revocationReason' | 'revokedAt' | 'revokedByActorId'> {
  return { authorizationId: String(row.authorization_id), recoveryPlanId: String(row.recovery_plan_id), workflowRunId: String(row.workflow_run_id),
    operationKind: row.operation_kind as RecoveryAuthorization['operationKind'], targetId: String(row.target_id), planDigest: String(row.plan_digest),
    authorizedActorId: String(row.authorized_actor_id), authorizerRole: row.authorizer_role as RecoveryAuthorization['authorizerRole'],
    authorizationSource: String(row.authorization_source), authorizedAt: Number(row.authorized_at), expiresAt: Number(row.expires_at),
    runtimeInstanceId: String(row.runtime_instance_id), runtimeGeneration: Number(row.runtime_generation), operationContractVersion: String(row.contract_version) };
}
export function readRecoveryAuthorization(tx: DurableTransaction, id: string): RecoveryAuthorization {
  const row = tx.get('SELECT * FROM recovery_authorizations WHERE authorization_id=?', id);
  if (!row) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const body = grantBody(row), plan = readRecoveryPlan(tx, body.recoveryPlanId);
  requireIntegrity(row.grant_digest === digest(body) && body.operationContractVersion === RECOVERY_CONTRACT
    && body.expiresAt <= plan.expiresAt && body.expiresAt === recoveryExpiry(body.authorizedAt, body.expiresAt - body.authorizedAt));
  assertScope(body, scopeOf(plan));
  requireIntegrity(body.runtimeInstanceId === plan.runtimeInstanceId && body.runtimeGeneration === plan.runtimeGeneration);
  const audits = tx.all('SELECT * FROM runtime_audit_events WHERE recovery_authorization_id=? ORDER BY audit_sequence', id);
  requireIntegrity(audits.length === (row.status === 'REVOKED' ? 2 : 1) && audits[0].event_kind === 'RECOVERY_AUTHORIZED'
    && audits.every(a => a.recovery_record_digest === row.grant_digest) && audits[0].recovery_actor_id === body.authorizedActorId);
  if (row.status === 'REVOKED') requireIntegrity(audits[1].event_kind === 'RECOVERY_REVOKED' && audits[1].reason_code === row.revocation_reason && audits[1].recovery_actor_id === row.revoked_actor_id);
  requireIntegrity(['AUTHORIZED','REVOKED'].includes(String(row.status)));
  const status = row.status === 'REVOKED' ? 'REVOKED' : recoveryTime(tx) >= body.expiresAt ? 'EXPIRED' : 'AUTHORIZED';
  return { ...body, status, revocationReason: row.revocation_reason as RecoveryAuthorization['revocationReason'], revokedAt: row.revoked_at as number | null, revokedByActorId: row.revoked_actor_id as string | null };
}
export const scopeOf = (plan: RecoveryPlan): RecoveryGrantScope => ({ workflowRunId: plan.workflowRunId, operationKind: plan.operationKind,
  targetId: plan.targetId, planDigest: plan.planDigest, operationContractVersion: plan.operationContractVersion });
function assertScope(grant: RecoveryGrantScope, scope: RecoveryGrantScope): void {
  if (canonicalJson(scopeOf(grant as RecoveryPlan)) !== canonicalJson(scope) || scope.operationContractVersion !== RECOVERY_CONTRACT) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
}
/** Called only by DurableDatabase after verifier, lease and clock checks. SQL checks its private context too. */
export function persistRecoveryDecision(db: DurableDatabase, tx: DurableTransaction, command: RecoveryDecisionCommand, identity: VerifiedRecoveryIdentity,
  setIntent: (kind: string, id: string, planId?: string) => void): RecoveryPlan | RecoveryAuthorization | undefined {
  const now = recoveryTime(tx);
  if (command.kind === 'CREATE_PLAN') {
    const plan = buildRecoveryPlan(db, tx, command.input, identity.actorId, db.recoveryPolicy);
    setIntent(command.kind, plan.recoveryPlanId, plan.recoveryPlanId);
    tx.run('INSERT INTO recovery_plans VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', plan.recoveryPlanId, plan.workflowRunId, plan.operationKind, plan.targetId,
      canonicalJson(plan), plan.planDigest, plan.runtimeInstanceId, plan.runtimeGeneration, plan.journalCursor, plan.recoveryHoldRevision, plan.operationContractVersion, plan.createdAt, plan.expiresAt);
    return readRecoveryPlan(tx, plan.recoveryPlanId);
  }
  if (command.kind === 'REVOKE') {
    const grant = readRecoveryAuthorization(tx, command.authorizationId);
    if (!['OPERATOR_REVOKED','POLICY_CHANGED'].includes(command.reason)) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    if (grant.authorizedActorId !== identity.actorId && !identity.roles.includes('RECOVERY_ADMIN')) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    if (grant.status === 'REVOKED') {
      if (grant.revocationReason !== command.reason) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
      return grant;
    }
    setIntent(command.kind, grant.authorizationId, grant.recoveryPlanId);
    tx.run("UPDATE recovery_authorizations SET status='REVOKED',revocation_reason=?,revoked_at=?,revoked_actor_id=? WHERE authorization_id=?", command.reason, now, identity.actorId, grant.authorizationId);
    return readRecoveryAuthorization(tx, grant.authorizationId);
  }
  const plan = readRecoveryPlan(tx, command.recoveryPlanId);
  if (command.kind === 'INVALIDATE') {
    try { assertPlanCurrent(db, tx, plan, db.recoveryPolicy); } catch (e) {
      if (!(e instanceof DurableStoreError) || e.code !== 'RECOVERY_INVALID_PLAN') throw e;
      if (!tx.get('SELECT recovery_plan_id FROM recovery_plan_invalidations WHERE recovery_plan_id=?', plan.recoveryPlanId)) {
        setIntent(command.kind, plan.recoveryPlanId, plan.recoveryPlanId);
        tx.run("INSERT INTO recovery_plan_invalidations VALUES (?,?,'STATE_CHANGED',?,?)", plan.recoveryPlanId, plan.workflowRunId, now, identity.actorId);
      }
      return;
    }
    throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  }
  assertPlanCurrent(db, tx, plan, db.recoveryPolicy); assertScope(plan, command.scope);
  const approval = plan.authorizationRequirements.approvalPolicy;
  if (approval.forbidSelfApproval && plan.createdByActorId === identity.actorId) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const prior = tx.get('SELECT authorization_id FROM recovery_authorizations WHERE recovery_plan_id=? AND authorized_actor_id=?', plan.recoveryPlanId, identity.actorId);
  if (prior) {
    const grant = readRecoveryAuthorization(tx, String(prior.authorization_id));
    if (grant.status !== 'AUTHORIZED') throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    return grant; // Idempotent duplicate never extends lifetime or revives a revoked grant.
  }
  const body = { authorizationId: randomUUID(), recoveryPlanId: plan.recoveryPlanId, ...scopeOf(plan),
    authorizedActorId: identity.actorId, authorizerRole: identity.roles.includes('RECOVERY_ADMIN') ? 'RECOVERY_ADMIN' as const : 'RECOVERY_APPROVER' as const,
    authorizationSource: identity.source, authorizedAt: now, expiresAt: Math.min(plan.expiresAt, identity.expiresAt, recoveryExpiry(now, command.ttlMs)),
    runtimeInstanceId: plan.runtimeInstanceId, runtimeGeneration: plan.runtimeGeneration };
  setIntent(command.kind, body.authorizationId, plan.recoveryPlanId);
  tx.run("INSERT INTO recovery_authorizations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'AUTHORIZED',NULL,NULL,NULL,?)",
    body.authorizationId, body.recoveryPlanId, body.workflowRunId, body.operationKind, body.targetId, body.planDigest,
    body.authorizedActorId, body.authorizerRole, body.authorizationSource, body.authorizedAt, body.expiresAt,
    body.runtimeInstanceId, body.runtimeGeneration, body.operationContractVersion, digest(body));
  return readRecoveryAuthorization(tx, body.authorizationId);
}
export function inspectGrant(db: DurableDatabase, tx: DurableTransaction, id: string, scope: RecoveryGrantScope) {
  const grant = readRecoveryAuthorization(tx, id); assertScope(grant, scope);
  const plan = readRecoveryPlan(tx, grant.recoveryPlanId);
  let valid = grant.status === 'AUTHORIZED';
  try { assertPlanCurrent(db, tx, plan, db.recoveryPolicy); } catch (e) {
    if (!(e instanceof DurableStoreError) || e.code !== 'RECOVERY_INVALID_PLAN') throw e;
    valid = false;
  }
  const grants = tx.all('SELECT authorization_id FROM recovery_authorizations WHERE recovery_plan_id=?', plan.recoveryPlanId)
    .map(r => readRecoveryAuthorization(tx, String(r.authorization_id))).filter(g => g.status === 'AUTHORIZED');
  return { authorization: grant, valid, approvalCount: grants.length,
    quorumSatisfied: valid && grants.length >= plan.authorizationRequirements.approvalPolicy.minimumApprovers,
    executionAllowed: false as const, reasonCode: 'RECOVERY_EXECUTION_DISABLED' as const };
}
export function recoveryDecisionSummary(tx: DurableTransaction, id: string) {
  const holds = tx.all('SELECT * FROM recovery_holds WHERE workflow_run_id=?', id);
  for (const hold of holds) {
    requireIntegrity(hold.active === 1 && hold.revision === 1);
    if (hold.origin === 'TAKEOVER') requireIntegrity(tx.get("SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id=? AND event_kind='LEASE_TAKEN_OVER' AND runtime_generation=?", id, hold.created_generation));
    if (hold.origin === 'ACQUIRE') requireIntegrity(tx.get("SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id=? AND event_kind='LEASE_ACQUIRED' AND runtime_generation=?", id, hold.created_generation));
    if (hold.origin === 'GATE') requireIntegrity(tx.get("SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id=? AND event_kind='RECOVERY_HOLD_CREATED' AND recovery_hold_revision=? AND reason_code=?", id, hold.revision, hold.reason_code));
  }
  const plans = tx.all('SELECT recovery_plan_id FROM recovery_plans WHERE workflow_run_id=? ORDER BY created_at,recovery_plan_id', id)
    .map(r => { const p = readRecoveryPlan(tx, String(r.recovery_plan_id)); return { recoveryPlanId: p.recoveryPlanId, planDigest: p.planDigest,
      status: tx.get('SELECT recovery_plan_id FROM recovery_plan_invalidations WHERE recovery_plan_id=?', p.recoveryPlanId) ? 'INVALIDATED' : recoveryTime(tx) >= p.expiresAt ? 'EXPIRED' : 'DRAFT',
      operationKind: p.operationKind, targetId: p.targetId, expiresAt: p.expiresAt }; });
  const authorizations = tx.all('SELECT authorization_id FROM recovery_authorizations WHERE workflow_run_id=? ORDER BY authorized_at,authorization_id', id)
    .map(r => readRecoveryAuthorization(tx, String(r.authorization_id)));
  return { holds, plans, authorizations, executionAllowed: false as const };
}
export function validateRecoveryAudit(tx: DurableTransaction, row: Row): void {
  if (!String(row.event_kind).startsWith('RECOVERY_')) {
    requireIntegrity(['recovery_plan_id','recovery_authorization_id','recovery_hold_revision','recovery_record_digest','recovery_actor_id'].every(k => row[k] == null)); return;
  }
  requireIntegrity(row.entity_kind === 'WORKFLOW' && row.entity_id === row.workflow_run_id
    && ['session_id','task_id','action_id','attempt_id','model_call_id','journal_event_id','actor_agent_id','subject_agent_id'].every(k => row[k] === null));
  if (row.event_kind === 'RECOVERY_HOLD_CREATED') {
    const hold = tx.get('SELECT * FROM recovery_holds WHERE workflow_run_id=?', row.workflow_run_id);
    requireIntegrity(hold && hold.origin === 'GATE' && hold.revision === row.recovery_hold_revision && hold.reason_code === row.reason_code
      && hold.created_generation === row.runtime_generation && row.next_state === 'HELD' && row.previous_state === null
      && row.recovery_plan_id === null && row.recovery_authorization_id === null && row.recovery_record_digest === null && row.recovery_actor_id === null);
    return;
  }
  const plan = readRecoveryPlan(tx, String(row.recovery_plan_id));
  requireIntegrity(plan.workflowRunId === row.workflow_run_id && row.recovery_hold_revision === null);
  if (row.event_kind === 'RECOVERY_PLAN_CREATED' || row.event_kind === 'RECOVERY_PLAN_INVALIDATED') {
    requireIntegrity(row.recovery_authorization_id === null && row.recovery_record_digest === plan.planDigest);
    if (row.event_kind === 'RECOVERY_PLAN_CREATED') requireIntegrity(row.recovery_actor_id === plan.createdByActorId && row.previous_state === null && row.next_state === 'DRAFT' && row.reason_code === null
      && row.runtime_instance_id === plan.runtimeInstanceId && row.runtime_generation === plan.runtimeGeneration);
    else requireIntegrity(row.previous_state === 'DRAFT' && row.next_state === 'INVALIDATED' && row.reason_code === 'STATE_CHANGED'
      && tx.get('SELECT recovery_plan_id FROM recovery_plan_invalidations WHERE recovery_plan_id=? AND invalidated_actor_id=?', plan.recoveryPlanId, row.recovery_actor_id));
    return;
  }
  requireIntegrity(['RECOVERY_AUTHORIZED','RECOVERY_REVOKED'].includes(String(row.event_kind)));
  const grant = readRecoveryAuthorization(tx, String(row.recovery_authorization_id));
  requireIntegrity(grant.recoveryPlanId === plan.recoveryPlanId);
  if (row.event_kind === 'RECOVERY_AUTHORIZED') requireIntegrity(row.previous_state === 'DRAFT' && row.next_state === 'AUTHORIZED' && row.reason_code === null
    && row.runtime_instance_id === grant.runtimeInstanceId && row.runtime_generation === grant.runtimeGeneration);
  else requireIntegrity(row.previous_state === 'AUTHORIZED' && row.next_state === 'REVOKED' && row.reason_code === grant.revocationReason);
}
export class RecoveryDecisionStore {
  constructor(readonly database: DurableDatabase) {}
  inspect(workflowRunId: string) { return this.database.read(tx => recoveryDecisionSummary(tx, workflowRunId)); }
  getPlan(recoveryPlanId: string) { return this.database.read(tx => readRecoveryPlan(tx, recoveryPlanId)); }
  view(workflowRunId: string, credential: unknown) { return this.database.viewRecoveryDecisions(credential, workflowRunId); }
}
