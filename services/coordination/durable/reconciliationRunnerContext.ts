import type { RunnerReconciledFact } from '../runner/types';
import type { DurableTransaction } from './db';
import type { ReconciliationPolicy, ReconciliationTarget, ReconciliationVerification, ReconciliationPermission } from './reconciliationTypes';
import type { VerifiedRecoveryIdentity } from './recoveryDecisionTypes';
import { readReconciledActionOutcome } from './reconciliationEffectiveState';
import { digest, parseJson, requireIntegrity } from './integrity';

/** Read-only, fixed metadata projection. Never includes submitted evidence text. */
export function reconciliationRunnerFacts(
  tx:DurableTransaction, workflowRunId:string, destination:string, policy:ReconciliationPolicy,
  authorize:(target:ReconciliationTarget,permission:ReconciliationPermission,ownerId?:string)=>VerifiedRecoveryIdentity,
):RunnerReconciledFact[] {
  requireIntegrity(typeof destination==='string'&&/^[A-Za-z0-9_.:@/-]{1,160}$/.test(destination));
  requireIntegrity(!tx.get('SELECT dispute_id FROM reconciliation_disputes WHERE workflow_run_id=?',workflowRunId));
  const facts:RunnerReconciledFact[]=[];
  for(const row of tx.all('SELECT * FROM reconciled_action_outcomes WHERE workflow_run_id=? ORDER BY action_id LIMIT 201',workflowRunId)) {
    requireIntegrity(facts.length<200);
    const target:ReconciliationTarget={workflowRunId,targetKind:'ACTION',targetId:String(row.action_id),attemptId:String(row.attempt_id)};
    authorize(target,'VIEW_CASE');
    const verificationRow=tx.get('SELECT * FROM reconciliation_verifications WHERE workflow_run_id=? AND verification_id=?',workflowRunId,row.verification_id);
    requireIntegrity(verificationRow);
    const verification=parseJson<ReconciliationVerification>(verificationRow.receipt_json);
    const {receiptDigest,...body}=verification;
    requireIntegrity(receiptDigest===digest(body));
    const evidence=tx.get('SELECT owner_id,data_class FROM reconciliation_evidence WHERE workflow_run_id=? AND evidence_id=?',workflowRunId,verification.evidenceId);
    requireIntegrity(evidence);
    authorize(target,'USE_EVIDENCE',String(evidence.owner_id));
    const actor=authorize(target,'SEND_RECONCILED_FACT',String(evidence.owner_id));
    requireIntegrity(policy.canSend?.(actor,target,destination,verification)===true);
    const checked=readReconciledActionOutcome(tx,workflowRunId,target.targetId);requireIntegrity(checked);
    const fact:RunnerReconciledFact={operationId:String(row.operation_id),targetId:target.targetId,attemptId:target.attemptId,
      verificationId:verification.verificationId,claimDigest:verification.claimDigest,outcome:String(row.outcome_kind)};
    if(row.result_json)fact.resultRef=parseJson<{resultRef:string}>(row.result_json).resultRef;
    requireIntegrity(policy.inspectContent(fact,{stage:'OUTPUT',dataClass:String(evidence.data_class),ownerId:String(evidence.owner_id),target}));
    facts.push(fact);
  }
  return facts;
}
