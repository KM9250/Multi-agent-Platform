import { assertLegacyControl } from './recoveryHoldLifecycle';
import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction } from './db';
import { canonicalJson, digest, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { recoveryExpiry, recoveryTime } from './recoveryPlanner';
import { RecoveryReader } from './recoveryReader';
import { readJournal } from './restore';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { inspectModelCalls } from './modelCallRecovery';
import { modelBudgetPosition, validateQuote } from './modelCallLedger';
import { inspectSafeRecoveryAction } from './safeRecoveryActions';
import { SAFE_RECOVERY_CONTRACT, SAFE_RECOVERY_OPERATIONS } from './safeRecoveryTypes';
import type { CreateRecoveryExecutionPlan, RecoveryExecutionBinding, RecoveryExecutionPlan, RecoveryExecutionPreview, SafeRecoveryOperationKind } from './safeRecoveryTypes';

export function effectiveHoldRevision(tx: DurableTransaction, id: string): number {
  const original = tx.get('SELECT revision,active FROM recovery_holds WHERE workflow_run_id=?', id);
  requireIntegrity(original && original.active === 1 && original.revision === 1);
  const rows = tx.all('SELECT * FROM recovery_hold_transitions WHERE workflow_run_id=? ORDER BY revision', id);
  let revision = Number(original.revision);
  for (const row of rows) { requireIntegrity(row.previous_revision === revision && row.revision === revision + 1); revision++; }
  return revision;
}
export function modelRecoveryTarget(tx: DurableTransaction, id: string, target: string, kind: SafeRecoveryOperationKind) {
  requireIntegrity(kind === 'CANCEL_UNSENT_MODEL' || kind === 'DISCARD_SETTLED_RESPONSE');
  const model = tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?', id, target);
  requireIntegrity(model && !tx.get('SELECT model_call_id FROM recovery_model_resolutions WHERE model_call_id=?', target));
  const attempts = tx.all('SELECT * FROM model_call_attempts WHERE model_call_id=?', target), attempt = attempts[0];
  requireIntegrity(attempts.length === 1 && attempt.attempt_id === model.attempt_id && attempt.workflow_run_id === id
    && attempt.runtime_instance_id === model.runtime_instance_id && attempt.generation === model.generation && attempt.attempt_number === 1
    && attempt.state === model.state && attempt.completeness === model.completeness);
  const quote = parseJson<import('./modelCallLedger').ModelBudgetQuote>(model.quote_json), amounts = validateQuote(quote);
  requireIntegrity(quote.providerId === model.provider_id && quote.modelId === model.model_id
    && amounts.llmCalls === model.reserved_calls && amounts.inputTokens === model.reserved_input
    && amounts.outputTokens === model.reserved_output && amounts.costMicros === model.reserved_cost);
  requireIntegrity(tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?', id)?.coverage === 'TRACKED_FROM_CREATION'
    && tx.get("SELECT migration_id FROM schema_migrations WHERE schema_version=5")?.migration_id === '005_durable_model_call_budget');
  const snapshot = readJournal(tx, id).snapshot;
  if (kind === 'CANCEL_UNSENT_MODEL') {
    requireIntegrity(model.state === 'RESERVED' && attempt.state === 'RESERVED' && attempt.dispatch_intent_at === null
      && model.completeness === 'UNKNOWN' && model.usage_event_id === null && model.usage_json === null
      && model.application_status === 'NOT_APPLICABLE' && model.application_event_id === null);
  } else {
    requireIntegrity(model.state === 'SETTLED' && model.completeness === 'COMPLETE' && attempt.dispatch_intent_at !== null
      && model.application_status === 'PENDING_APPLICATION' && model.application_event_id === null
      && model.application_digest === null && model.application_start_cursor === null);
    const usageIndex = snapshot.events.findIndex(e => e.eventId === model.usage_event_id);
    requireIntegrity(usageIndex === Number(model.request_cursor) && usageIndex === snapshot.events.length - 1
      && snapshot.events[usageIndex]?.type === 'UsageRecorded'
      && snapshot.events[Number(model.request_cursor) - 1]?.eventId === model.request_event_id);
    // No event after the exact settlement cursor is treated as an innocent partial application.
  }
  return { model, attempt, sourceDigest: digest({ model, attempt }), reservation: amounts };
}
export function safeRecoveryBinding(db: DurableDatabase, tx: DurableTransaction, input: CreateRecoveryExecutionPlan): RecoveryExecutionBinding {
  if (!SAFE_RECOVERY_OPERATIONS.includes(input.operationKind)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  requireIntegrity(typeof input.targetId === 'string' && !!input.targetId && Object.keys(input).every(k => ['workflowRunId','operationKind','targetId','ttlMs'].includes(k)));
  const id = input.workflowRunId, snapshot = readJournal(tx, id).snapshot;
  const inspection = new RecoveryReader(db).inspectInTransaction(tx, id, recoveryTime(tx), false);
  if (inspection.disposition === 'RECOVERY_FAILED' || ['RESOLVED','CANCELLED','FAILED'].includes(snapshot.run.status)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const lease = tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?', id);
  if (!lease || lease.lease_state !== 'ACTIVE' || Number(lease.expires_at) <= recoveryTime(tx)) throw new DurableStoreError('LEASE_FENCED');
  const store = new SqliteCoordinationRunnerStore(db);
  inspectModelCalls(tx, store, id);
  if (input.operationKind === 'REFLECT_RECORDED_RESULT' || input.operationKind === 'COMPLETE_SAFETY_STOP') {
    inspectSafeRecoveryAction(db, tx, id, input.targetId, input.operationKind);
    if (input.operationKind === 'REFLECT_RECORDED_RESULT' && inspection.authorizationRequirements.some(r => r.kind !== 'EXPLICIT_RESUME' && !r.satisfied)) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  } else modelRecoveryTarget(tx, id, input.targetId, input.operationKind);
  const rows = (table: string) => tx.all(`SELECT * FROM ${table} WHERE workflow_run_id=? ORDER BY rowid`, id);
  return {
    workflowRunId: id, operationKind: input.operationKind, targetId: input.targetId,
    journalCursor: snapshot.events.at(-1)!.sequence, journalEventId: snapshot.events.at(-1)!.eventId,
    actionStateDigest: digest({ ledger: rows('execution_ledger'), actions: rows('pending_actions'), results: rows('execution_results'), evidence: rows('runner_evidence') }),
    modelStateDigest: digest({ ledger: rows('model_call_ledger'), attempts: rows('model_call_attempts'), resolutions: rows('recovery_model_resolutions'), coverage: rows('model_call_coverage') }),
    policyDigest: digest({ workflow: snapshot.policy, recovery: db.recoveryPolicy }),
    budgetPositionDigest: digest({ budget: modelBudgetPosition(tx, store, id), usage: snapshot.run.usage }),
    recoveryHoldRevision: effectiveHoldRevision(tx, id), runtimeInstanceId: String(lease.owner_instance_id), runtimeGeneration: Number(lease.generation),
    authorizationRequirements: { reviews: inspection.authorizationRequirements, approvalPolicy: db.recoveryPolicy[input.operationKind] ?? { minimumApprovers: 1, forbidSelfApproval: false } },
    plannedChanges: input.operationKind === 'REFLECT_RECORDED_RESULT' ? ['RECORDED_RESULT_EVENT','EXECUTION_FINALIZED']
      : input.operationKind === 'COMPLETE_SAFETY_STOP' ? ['UNCERTAIN_STOP_MISSING_SUFFIX'] : [input.operationKind === 'CANCEL_UNSENT_MODEL' ? 'CANCELLED_UNSENT_RESOLUTION' : 'DISCARDED_RESPONSE_RESOLUTION'],
    operationContractVersion: SAFE_RECOVERY_CONTRACT,
  };
}
export function buildExecutionPlan(db: DurableDatabase, tx: DurableTransaction, input: CreateRecoveryExecutionPlan, actorId: string): RecoveryExecutionPlan {
  const createdAt = recoveryTime(tx), binding = safeRecoveryBinding(db, tx, input);
  const body = { ...binding, executionPlanId: randomUUID(), createdByActorId: actorId, createdAt, expiresAt: recoveryExpiry(createdAt, input.ttlMs) };
  return { ...body, planDigest: digest(body) };
}
export function verifyExecutionPlanDigest(plan: RecoveryExecutionPlan): void {
  const { planDigest, ...body } = plan;
  requireIntegrity(planDigest === digest(body) && plan.operationContractVersion === SAFE_RECOVERY_CONTRACT
    && SAFE_RECOVERY_OPERATIONS.includes(plan.operationKind)
    && plan.expiresAt === recoveryExpiry(plan.createdAt, plan.expiresAt - plan.createdAt));
}
export function assertExecutionPlanCurrent(db: DurableDatabase, tx: DurableTransaction, plan: RecoveryExecutionPlan): void {
  assertLegacyControl(tx,plan.workflowRunId,'recovery_execution_plans',plan.executionPlanId);
  verifyExecutionPlanDigest(plan);
  if (recoveryTime(tx) >= plan.expiresAt) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const binding = safeRecoveryBinding(db, tx, { workflowRunId: plan.workflowRunId, operationKind: plan.operationKind, targetId: plan.targetId });
  const { executionPlanId, createdByActorId, createdAt, expiresAt, planDigest, ...saved } = plan;
  if (canonicalJson(binding) !== canonicalJson(saved)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
}
export function previewSafeRecovery(db: DurableDatabase, tx: DurableTransaction, id: string): RecoveryExecutionPreview {
  const candidates: RecoveryExecutionPreview['candidates'] = [];
  const targets = [...tx.all('SELECT action_id AS id FROM execution_ledger WHERE workflow_run_id=?', id).flatMap(r =>
    (['REFLECT_RECORDED_RESULT','COMPLETE_SAFETY_STOP'] as const).map(operationKind => ({ operationKind, targetId: String(r.id) }))),
    ...tx.all('SELECT model_call_id AS id FROM model_call_ledger WHERE workflow_run_id=?', id).flatMap(r =>
      (['CANCEL_UNSENT_MODEL','DISCARD_SETTLED_RESPONSE'] as const).map(operationKind => ({ operationKind, targetId: String(r.id) })))];
  for (const target of targets) {
    try { safeRecoveryBinding(db, tx, { workflowRunId: id, ...target }); candidates.push({ ...target, executable: false }); }
    catch (e) { if (!(e instanceof DurableStoreError) || ['DATABASE_ERROR','DATABASE_BUSY','INVALID_TRANSACTION'].includes(e.code)) throw e; }
  }
  return { workflowRunId: id, candidates, executionAllowed: false };
}
