import type { DurableDatabase, DurableTransaction } from './db';
import type { ReconciliationTarget, ReconciliationVerification } from './reconciliationTypes';
import { readJournal } from './restore';
import { effectiveAccounting, effectiveReservations, effectiveWorkflowUsage } from './reconciliationAccounting';
import { effectiveActionRows } from './reconciliationEffectiveState';
import { effectiveModelRows } from './safeRecoveryModelState';
import { readWorkflowControl } from './recoveryHoldLifecycle';
import { runnerEvidenceReviewReason, runnerSecurityReviewReason } from '../runner/dispatchGuard';
import { findExhaustedBudget } from '../policy';
import { recoveryTime } from './recoveryPlanner';
import { digest, parseJson, requireIntegrity } from './integrity';

/** Called after the host has checked VIEW_CASE. Returns IDs and normalized
 * facts only; candidate bodies and provider responses use separate ACL paths. */
export function inspectReconciliationInTransaction(tx: DurableTransaction, target: ReconciliationTarget) {
  const id = target.workflowRunId, snapshot = readJournal(tx,id).snapshot;
  const models = effectiveModelRows(tx,id), actions = effectiveActionRows(tx,id);
  const selected = target.targetKind === 'MODEL'
    ? models.find(row=>row.historical.model_call_id===target.targetId && row.historical.attempt_id===target.attemptId)
    : actions.find(row=>row.historical.action_id===target.targetId && row.historical.attempt_id===target.attemptId);
  requireIntegrity(selected);
  const accounting = {...effectiveAccounting(tx,id,snapshot),outstanding:effectiveReservations(tx,id)}, usage = effectiveWorkflowUsage(tx,id,snapshot), control = readWorkflowControl(tx,id);
  const obligations: Array<{targetKind:'MODEL'|'ACTION'|'WORKFLOW';targetId:string;reason:string}> = [];
  for(const row of models) {
    const add=(reason:string)=>obligations.push({targetKind:'MODEL',targetId:String(row.historical.model_call_id),reason});
    if(row.outstandingReservation)add('USAGE_UNSETTLED');
    if(row.pendingApplication)add(row.responseState==='UNAVAILABLE_REVIEW_REQUIRED'?'RESPONSE_UNAVAILABLE_REVIEW_REQUIRED':'RESPONSE_NOT_APPLIED');
    if(row.budgetViolation)add('BUDGET_VIOLATION');
    if(row.disputed)add('DISPUTED');
  }
  for(const row of actions)for(const reason of row.obligations)obligations.push({targetKind:'ACTION',targetId:String(row.historical.action_id),reason});
  const add=(reason:string)=>obligations.push({targetKind:'WORKFLOW',targetId:id,reason});
  if(tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?',id)?.coverage!=='TRACKED_FROM_CREATION')add('LEGACY_COVERAGE');
  if(runnerSecurityReviewReason(snapshot))add('SECURITY_REVIEW_REQUIRED');
  if(runnerEvidenceReviewReason(snapshot))add('EVIDENCE_REVIEW_REQUIRED');
  if(control.active_invocation_id)add('INVOCATION_ACTIVE');
  if(control.planning_review_pending)add('PLANNING_REVIEW_REQUIRED');
  if(findExhaustedBudget(snapshot.run.budget,usage,Math.max(0,recoveryTime(tx)-snapshot.run.createdAt)))add('BUDGET_EXHAUSTED');
  const caseObligations=obligations.filter(item=>item.targetKind===target.targetKind && item.targetId===target.targetId);
  const verifications=tx.all('SELECT * FROM reconciliation_verifications WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=? ORDER BY verified_at,verification_id',id,target.targetKind,target.targetId,target.attemptId).map(row=>{
    const receipt=parseJson<ReconciliationVerification>(row.receipt_json),{receiptDigest,...body}=receipt;
    requireIntegrity(receiptDigest===digest(body)&&row.digest===receiptDigest&&receipt.claimDigest===digest(receipt.claim));
    return {verificationId:receipt.verificationId,evidenceId:receipt.evidenceId,evidenceVersion:receipt.evidenceVersion,
      status:receipt.status,claimDigest:receipt.claimDigest,sourceEffectKey:receipt.sourceEffectKey,verifiedAt:receipt.verifiedAt,
      kind:receipt.claim.kind,completeness:receipt.claim.completeness,finality:receipt.claim.finality,
      outcome:receipt.claim.outcome,responseState:receipt.claim.responseState,reasonCodes:receipt.reasonCodes};
  });
  const disputes=tx.all('SELECT dispute_id,verification_id,prior_verification_id,reason_code,created_at FROM reconciliation_disputes WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=? ORDER BY created_at,dispute_id',id,target.targetKind,target.targetId,target.attemptId);
  return { target:{...target}, workflowStatus:snapshot.run.status, historical:selected.historical,
    verifications,disputes,
    models:models.map(row=>({modelCallId:String(row.historical.model_call_id),historicalState:row.historical.state,
      accountingState:row.accountingState,responseState:row.responseState,operationId:row.reconciliation?.operation_id??null,
      outstandingReservation:row.outstandingReservation,disputed:row.disputed})),
    actions:actions.map(row=>({actionId:String(row.historical.action_id),historicalState:row.historical.state,
      outcomeState:row.outcomeState,applicationState:row.applicationState,outcomeOperationId:row.outcome?.operation_id??null,
      applicationOperationId:row.application?.operation_id??null,obligations:row.obligations})),
    historicalUsage:{...snapshot.run.usage}, effectiveWorkflowUsage:usage, accounting,
    obligations, caseReconciled:caseObligations.length===0, recoveryReviewEligible:obligations.length===0 && !['RESOLVED','FAILED','CANCELLED'].includes(snapshot.run.status),
    holdState:control.hold_state, executionAllowed:false as const,
    nextOperations:caseObligations.some(item=>item.reason==='ACTION_RESULT_NOT_APPLIED')?['APPLY_RECONCILED_ACTION_RESULT_REQUIRES_NEW_APPROVAL']:[],
  };
}

/** Read only. No lookup, verification, Hold update, grant or lease acquisition. */
export class ReconciliationReader {
  constructor(readonly database:DurableDatabase) {}
  inspect(target:ReconciliationTarget,credential:unknown):ReturnType<typeof inspectReconciliationInTransaction> {
    return this.database.reconciliationDecision(undefined,credential,{kind:'INSPECT',target}) as ReturnType<typeof inspectReconciliationInTransaction>;
  }
}
