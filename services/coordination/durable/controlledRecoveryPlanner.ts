import { assertLegacyControl } from './recoveryHoldLifecycle';
import type { DurableDatabase, DurableTransaction } from './db';
import type { ControlledBinding, ControlledExecutorRegistry, ControlledPlan, ControlledPlanInput, ControlledTiming } from './controlledRecoveryTypes';
import { CONTROLLED_LIMITS, CONTROLLED_OPERATION, CONTROLLED_RECOVERY_CONTRACT } from './controlledRecoveryTypes';
import { canonicalJson, digest, DurableStoreError, requireIntegrity } from './integrity';
import { readJournal } from './restore';
import { readPendingActionInTransaction, validateActionOwner } from './pendingActionStore';
import { readExecution } from './executionLedger';
import { RecoveryReader } from './recoveryReader';
import { effectiveHoldRevision } from './safeRecoveryPlanner';
import { effectiveModelRows } from './safeRecoveryModelState';
import { modelBudgetPosition } from './modelCallLedger';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { recoveryTime } from './recoveryPlanner';
import { findExhaustedBudget } from '../policy';
import { runnerActionApproved, runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { evaluateRunnerActionRisk } from '../runner/policyGuard';
import { effectiveWorkflowUsage, reconciliationStateDigest } from './reconciliationAccounting';
import { effectiveActionRows } from './reconciliationEffectiveState';

export function controlledTiming(input: Partial<ControlledTiming> = {}): ControlledTiming {
  requireIntegrity(Object.keys(input).every(k => ['sendTtlMs','executionTimeoutMs','resultGraceMs'].includes(k)));
  const timing = { sendTtlMs: input.sendTtlMs ?? CONTROLLED_LIMITS.sendTtlMs,
    executionTimeoutMs: input.executionTimeoutMs ?? CONTROLLED_LIMITS.executionTimeoutMs,
    resultGraceMs: input.resultGraceMs ?? CONTROLLED_LIMITS.resultGraceMs };
  for (const [key, max] of [['sendTtlMs',CONTROLLED_LIMITS.maxSendTtlMs],['executionTimeoutMs',CONTROLLED_LIMITS.maxExecutionTimeoutMs],['resultGraceMs',CONTROLLED_LIMITS.maxResultGraceMs]] as const)
    if (!Number.isSafeInteger(timing[key]) || timing[key] <= 0 || timing[key] > max) throw new DurableStoreError('INVALID_CONFIGURATION');
  return Object.freeze(timing);
}
export function resolveControlledExecutor(registry: ControlledExecutorRegistry | undefined, executorId: string) {
  const b = registry?.get(executorId);
  requireIntegrity(b && b.executor?.id === executorId && typeof b.executor.execute === 'function'
    && b.sideEffectRetries === 'disabled' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(b.contractVersion)
    && /^[a-f0-9]{64}$/.test(b.implementationDigest));
  return Object.freeze({ executorId, contractVersion: b.contractVersion,
    bindingDigest: digest({ executorId, contractVersion: b.contractVersion, implementationDigest: b.implementationDigest, sideEffectRetries: b.sideEffectRetries }),
    execute: b.executor.execute.bind(b.executor) });
}
/** Excludes decision metadata and lease heartbeats. Includes every business state. */
export function controlledState(tx: DurableTransaction, id: string) {
  const rows = (table: string) => tx.all(`SELECT * FROM ${table} WHERE workflow_run_id=? ORDER BY rowid`, id);
  return {
    actionStateDigest: digest({ ledger: rows('execution_ledger'), actions: rows('pending_actions'), results: rows('execution_results'), evidence: rows('runner_evidence'), reconciliation: reconciliationStateDigest(tx,id) }),
    modelStateDigest: digest({ ledger: rows('model_call_ledger'), attempts: rows('model_call_attempts'), resolutions: rows('recovery_model_resolutions'), coverage: rows('model_call_coverage'), reconciliation: reconciliationStateDigest(tx,id) }),
    controlledStateDigest: digest({ intents: rows('recovery_dispatch_intents'), receipts: rows('recovery_dispatch_receipts'), evidence: rows('recovery_dispatch_evidence') }),
  };
}
/** Expected post-reservation state, without the self-referential Intent. */
export function dispatchPostState(tx: DurableTransaction, id: string): string {
  const s = readJournal(tx,id).snapshot;
  const { actionStateDigest, modelStateDigest } = controlledState(tx,id);
  return digest({ actionStateDigest, modelStateDigest, cursor: s.events.length, head: s.events.at(-1),
    policy: s.policy, usage: effectiveWorkflowUsage(tx,id,s), hold: effectiveHoldRevision(tx,id) });
}
export function preparedEligibility(db: DurableDatabase, tx: DurableTransaction, input: ControlledPlanInput) {
  requireIntegrity(Object.keys(input).every(k => ['workflowRunId','actionId'].includes(k))
    && [input.workflowRunId,input.actionId].every(x => typeof x === 'string' && !!x.trim()));
  const id = input.workflowRunId, s = readJournal(tx,id).snapshot;
  const record = readPendingActionInTransaction(tx,id,input.actionId); requireIntegrity(record);
  validateActionOwner(s,record);
  const ledger = readExecution(tx,record);
  requireIntegrity(s.run.status === 'RUNNING' && s.run.executionMode === 'supervised_autonomous'
    && s.sessions[record.sessionId].state === 'OPEN' && s.tasks[record.taskId].status === 'ASSIGNED'
    && Object.values(s.sessions).filter(x => ['OPEN','SUSPENDED'].includes(x.state)).length === 1
    && ledger.state === 'PREPARED' && ledger.attempt_id === null && ledger.reserved_at === null
    && ledger.result_ref === null && ledger.finalized_event_id === null);
  requireIntegrity(!tx.get('SELECT operation_id FROM recovery_dispatch_intents WHERE workflow_run_id=? AND action_id=?',id,input.actionId)
    && !tx.get('SELECT result_ref FROM execution_results WHERE workflow_run_id=? AND action_id=?',id,input.actionId)
    && !tx.get('SELECT evidence_ref FROM runner_evidence WHERE workflow_run_id=? AND action_id=?',id,input.actionId)
    && !tx.get("SELECT audit_sequence FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND event_kind='EXECUTION_CHANGED' AND (attempt_id IS NOT NULL OR next_state<>'PREPARED')",id,input.actionId));
  requireIntegrity(!effectiveActionRows(tx,id).some(r=>r.historical.action_id!==input.actionId && (r.unresolved || r.historical.state==='PREPARED'))
    && !runnerSecurityReviewReason(s) && !runnerEvidenceReviewReason(s)
    && tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?',id)?.coverage === 'TRACKED_FROM_CREATION'
    && !effectiveModelRows(tx,id).some(m => m.unresolved));
  requireIntegrity(Object.values(s.tasks).every(task => tx.get('SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND task_id=?',id,task.taskId)));
  const risk = evaluateRunnerActionRisk(s,record.action);
  requireIntegrity(risk !== 'DENY' && (risk !== 'NEEDS_USER' || runnerActionApproved(s,record.action)));
  assertControlledBudget(tx,id);
  const inspection = new RecoveryReader(db).inspectInTransaction(tx,id,recoveryTime(tx),false);
  requireIntegrity(inspection.disposition !== 'RECOVERY_FAILED' && !inspection.authorizationRequirements.some(r => !r.satisfied));
  // Reader verifies the full audit chain; explicitly require a tracked registration.
  const prepared = tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND event_kind='EXECUTION_CHANGED'",id,input.actionId);
  requireIntegrity(prepared.length === 1 && prepared[0].previous_state === null && prepared[0].next_state === 'PREPARED');
  const saved = tx.get('SELECT * FROM pending_actions WHERE workflow_run_id=? AND action_id=?',id,input.actionId)!;
  const sessionEvent = s.events.find(e => e.type === 'SessionStarted' && e.sessionId === record.sessionId)!;
  const taskEvent = s.events.find(e => e.type === 'TaskAssigned' && (e.payload as {taskId?:string}).taskId === record.taskId)!;
  requireIntegrity(sessionEvent && taskEvent && taskEvent.sequence === sessionEvent.sequence+1
    && saved.registration_digest === digest([record,s.events[sessionEvent.sequence-2],s.policy,sessionEvent,taskEvent]));
  return { record, ledger, snapshot: s, inspection, saved };
}
export function assertControlledBudget(tx: DurableTransaction, id: string): void {
  const s = readJournal(tx,id).snapshot;
  requireIntegrity(!findExhaustedBudget(s.run.budget,effectiveWorkflowUsage(tx,id,s),Math.max(0,recoveryTime(tx)-s.run.createdAt)));
}
export function controlledBinding(db: DurableDatabase, tx: DurableTransaction, input: ControlledPlanInput,
  registry: ControlledExecutorRegistry | undefined, timing: ControlledTiming): { binding: ControlledBinding; executor: ReturnType<typeof resolveControlledExecutor> } {
  const { record, snapshot: s, saved, inspection } = preparedEligibility(db,tx,input);
  const executor = resolveControlledExecutor(registry,record.action.executorId), id = input.workflowRunId;
  const budget = modelBudgetPosition(tx,new SqliteCoordinationRunnerStore(db),id);
  requireIntegrity(Object.keys(budget.limit).every(key => budget.committed[key as keyof typeof budget.limit]
    + budget.outstanding[key as keyof typeof budget.limit] <= budget.limit[key as keyof typeof budget.limit]));
  const lease = tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?',id);
  if (!lease || lease.lease_state !== 'ACTIVE' || Number(lease.expires_at) <= recoveryTime(tx)) throw new DurableStoreError('LEASE_FENCED');
  return { executor, binding: { ...input, operationKind: CONTROLLED_OPERATION, operationContractVersion: CONTROLLED_RECOVERY_CONTRACT,
    sessionId: record.sessionId, taskId: record.taskId, fingerprint: record.action.fingerprint,
    payloadDigest: digest(record.action.payload), registrationDigest: String(saved.registration_digest),
    executorId: executor.executorId, executorContractVersion: executor.contractVersion, executorBindingDigest: executor.bindingDigest,
    journalCursor: s.events.length, journalEventId: s.events.at(-1)!.eventId, ...controlledState(tx,id),
    policyDigest: digest({ workflow: s.policy, recovery: db.recoveryPolicy }),
    budgetPositionDigest: digest({ budget, usage: effectiveWorkflowUsage(tx,id,s) }),
    recoveryHoldRevision: effectiveHoldRevision(tx,id), runtimeInstanceId: String(lease.owner_instance_id), runtimeGeneration: Number(lease.generation),
    approvalPolicy: db.recoveryPolicy.ALLOW_PREPARED_DISPATCH ?? { minimumApprovers: 1, forbidSelfApproval: true },
    reviewDigest: digest(inspection.authorizationRequirements), maxActionDispatches: 1, maxModelCalls: 0, maxRounds: 0, timing } };
}
export function assertControlledPlanCurrent(db: DurableDatabase, tx: DurableTransaction, plan: ControlledPlan,
  registry: ControlledExecutorRegistry | undefined, timing: ControlledTiming) {
  assertLegacyControl(tx,plan.workflowRunId,'recovery_controlled_plans',plan.planId);
  const { planId, planDigest, createdByActorId, createdAt, sendDeadline, ...saved } = plan;
  const current = controlledBinding(db,tx,{workflowRunId:plan.workflowRunId,actionId:plan.actionId},registry,timing);
  if (sendDeadline <= recoveryTime(tx) || canonicalJson(saved) !== canonicalJson(current.binding)) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  return current.executor;
}
