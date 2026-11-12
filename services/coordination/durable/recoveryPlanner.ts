import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction } from './db';
import type { WorkflowLease } from './runtimeLease';
import { RecoveryReader } from './recoveryReader';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { modelBudgetPosition } from './modelCallLedger';
import { canonicalJson, digest, DurableStoreError, requireIntegrity } from './integrity';
import { readJournal } from './restore';
import { DEFAULT_RECOVERY_TTL_MS, MAX_RECOVERY_TTL_MS, RECOVERY_CONTRACT, RECOVERY_OPERATIONS } from './recoveryDecisionTypes';
import type { CreateRecoveryPlan, RecoveryAuthorizationPolicy, RecoveryCandidate, RecoveryPlan, RecoveryPlanBinding, RecoveryPreview } from './recoveryDecisionTypes';
import { effectiveWorkflowUsage, reconciliationStateDigest } from './reconciliationAccounting';
import { effectiveModelRows } from './safeRecoveryModelState';
import { effectiveActionRows } from './reconciliationEffectiveState';

export function recoveryTime(tx: DurableTransaction): number {
  const now = tx.get('SELECT map_recovery_now() AS now')?.now;
  requireIntegrity(Number.isSafeInteger(now) && Number(now) >= 0);
  return Number(now);
}
export function recoveryExpiry(now: number, ttl = DEFAULT_RECOVERY_TTL_MS): number {
  requireIntegrity(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= MAX_RECOVERY_TTL_MS && Number.isSafeInteger(now + ttl));
  return now + ttl;
}
export function recoverySnapshot(db: DurableDatabase, tx: DurableTransaction, id: string, policy: RecoveryAuthorizationPolicy) {
  const inspection = new RecoveryReader(db).inspectInTransaction(tx, id, recoveryTime(tx), false);
  if (inspection.disposition === 'RECOVERY_FAILED') throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const snapshot = readJournal(tx, id).snapshot;
  const actions = tx.all('SELECT * FROM execution_ledger WHERE workflow_run_id=? ORDER BY action_id', id);
  const models = tx.all('SELECT * FROM model_call_ledger WHERE workflow_run_id=? ORDER BY model_call_id', id);
  const artifacts = ['pending_actions','execution_results','runner_evidence'].map(table => tx.all(`SELECT * FROM ${table} WHERE workflow_run_id=? ORDER BY rowid`, id));
  const lease = tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?', id);
  const hold = tx.get('SELECT * FROM recovery_holds WHERE workflow_run_id=?', id);
  const budget = modelBudgetPosition(tx, new SqliteCoordinationRunnerStore(db), id);
  const common = {
    workflowRunId: id, journalCursor: snapshot.events.at(-1)!.sequence, journalEventId: snapshot.events.at(-1)!.eventId,
    runtimeInstanceId: String(lease?.owner_instance_id ?? ''), runtimeGeneration: Number(lease?.generation ?? 0),
    actionStateDigest: digest({ actions, artifacts, reconciliation:reconciliationStateDigest(tx,id) }),
    modelStateDigest: digest({ models, attempts: tx.all('SELECT * FROM model_call_attempts WHERE workflow_run_id=? ORDER BY attempt_id', id), coverage: inspection.modelCallCoverage, reconciliation:reconciliationStateDigest(tx,id) }),
    policyDigest: digest({ workflow: snapshot.policy, recovery: policy }), budgetPositionDigest: digest({ budget, usage: effectiveWorkflowUsage(tx,id,snapshot) }),
    recoveryHoldRevision: Number(hold?.revision ?? 0), operationContractVersion: RECOVERY_CONTRACT,
  };
  const candidates: RecoveryCandidate[] = [];
  const add = (operationKind: RecoveryCandidate['operationKind'], targetId: string, reason: string) => candidates.push({
    operationKind, targetId, reasonCodes: [reason], executable: false,
    authorizationRequirements: { reviews: inspection.authorizationRequirements,
      approvalPolicy: policy[operationKind] ?? { minimumApprovers: 1, forbidSelfApproval: false } },
  });
  const terminal = ['RESOLVED','CANCELLED','FAILED'].includes(snapshot.run.status);
  if (!terminal) {
    for (const action of actions) {
      if (action.state === 'RESULT_RECORDED') add('REFLECT_RECORDED_RESULT', String(action.action_id), 'RECORDED_RESULT');
      if (action.state === 'PREPARED') add('ALLOW_PREPARED_DISPATCH', String(action.action_id), 'PREPARED_ONLY');
      if (action.state === 'REVIEW_REQUIRED' && action.result_ref) add('COMPLETE_SAFETY_STOP', String(action.action_id), 'SAFETY_STOP_ONLY');
    }
    for (const model of models) {
      if (model.state === 'RESERVED') add('CANCEL_UNSENT_MODEL', String(model.model_call_id), 'NO_DISPATCH_INTENT');
      if (model.state === 'SETTLED' && model.application_status === 'PENDING_APPLICATION') add('DISCARD_SETTLED_RESPONSE', String(model.model_call_id), 'SETTLED_RESPONSE');
    }
    if (!effectiveActionRows(tx,id).some(a => a.unresolved)
      && !effectiveModelRows(tx,id).some(m => m.unresolved)
      && inspection.modelCallCoverage === 'TRACKED_FROM_CREATION') add('BOUNDED_CONTINUATION', id, 'REVALIDATION_REQUIRED');
  }
  return { common, candidates, snapshot, inspection, lease };
}
export function planBinding(db: DurableDatabase, tx: DurableTransaction, input: CreateRecoveryPlan, policy: RecoveryAuthorizationPolicy): RecoveryPlanBinding {
  requireIntegrity(RECOVERY_OPERATIONS.includes(input.operationKind) && typeof input.targetId === 'string' && input.targetId.length > 0);
  const state = recoverySnapshot(db, tx, input.workflowRunId, policy);
  const candidate = state.candidates.find(c => c.operationKind === input.operationKind && c.targetId === input.targetId);
  if (!candidate || !state.lease || state.lease.lease_state !== 'ACTIVE' || Number(state.lease.expires_at) <= recoveryTime(tx)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  return { ...state.common, operationKind: input.operationKind, targetId: input.targetId, authorizationRequirements: candidate.authorizationRequirements };
}
export function buildRecoveryPlan(db: DurableDatabase, tx: DurableTransaction, input: CreateRecoveryPlan, actorId: string, policy: RecoveryAuthorizationPolicy): RecoveryPlan {
  const createdAt = recoveryTime(tx);
  const body = { ...planBinding(db, tx, input, policy), recoveryPlanId: randomUUID(), createdByActorId: actorId, createdAt, expiresAt: recoveryExpiry(createdAt, input.ttlMs) };
  return { ...body, planDigest: digest(body) };
}
export function verifyPlanDigest(plan: RecoveryPlan): void {
  const { planDigest, ...body } = plan;
  requireIntegrity(planDigest === digest(body) && plan.operationContractVersion === RECOVERY_CONTRACT
    && plan.expiresAt === recoveryExpiry(plan.createdAt, plan.expiresAt - plan.createdAt));
}
export function assertPlanCurrent(db: DurableDatabase, tx: DurableTransaction, plan: RecoveryPlan, policy: RecoveryAuthorizationPolicy): void {
  verifyPlanDigest(plan);
  if (recoveryTime(tx) >= plan.expiresAt || tx.get('SELECT recovery_plan_id FROM recovery_plan_invalidations WHERE recovery_plan_id=?', plan.recoveryPlanId)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const binding = planBinding(db, tx, plan, policy);
  const { recoveryPlanId, createdByActorId, createdAt, expiresAt, planDigest, ...saved } = plan;
  if (canonicalJson(binding) !== canonicalJson(saved)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
}
export class RecoveryPlanner {
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  preview(workflowRunId: string): RecoveryPreview {
    return this.database.read(tx => {
      const state = recoverySnapshot(this.database, tx, workflowRunId, this.database.recoveryPolicy);
      return { workflowRunId, candidates: state.candidates, prohibitedReasons: state.inspection.reasonCodes, executionAllowed: false };
    });
  }
  createPlan(input: CreateRecoveryPlan, credential: unknown): RecoveryPlan {
    return this.database.recoveryDecision(this.lease, credential, { kind: 'CREATE_PLAN', input }) as RecoveryPlan;
  }
}
