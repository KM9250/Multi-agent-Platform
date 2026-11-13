import type { DurableDatabase, DurableTransaction, Row } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { RecoveryApprovalPolicy, RecoveryIdentityVerifier, VerifiedRecoveryIdentity } from './recoveryDecisionTypes';
import type { RunnerModelUsage, RunnerExecutionResult } from '../runner/types';

export const RECONCILIATION_CONTRACT = 'COORD-5C-4C:RECONCILIATION:1' as const;
export const RECONCILIATION_OPERATIONS = ['RECORD_VERIFIED_ACTION_OUTCOME','SETTLE_VERIFIED_MODEL_USAGE','APPLY_RECONCILED_ACTION_RESULT'] as const;
export type ReconciliationOperationKind = typeof RECONCILIATION_OPERATIONS[number];
export type ReconciliationPermission = 'SUBMIT_EVIDENCE'|'VIEW_CASE'|'VIEW_EVIDENCE_BODY'|'VERIFY_EVIDENCE'|'CREATE_RECONCILIATION_PLAN'|'APPROVE_RECONCILIATION'|'APPLY_RECONCILIATION'|'REVOKE_GRANT'|'USE_EVIDENCE'|'SEND_RECONCILED_FACT';
export interface ReconciliationTarget { workflowRunId:string; targetKind:'ACTION'|'MODEL'; targetId:string; attemptId:string }
export interface ReconciliationSource { authorityDomain:string; sourceSystem:string; account:string; environment:string; externalOperationId:string; effectUnit:string }
export type ReconciliationActionOutcome = 'EXECUTED_FINAL'|'NOT_EXECUTED_FINAL'|'PARTIAL_EFFECT'|'UNKNOWN';
export interface ReconciliationClaim {
  kind:'ACTION_OUTCOME'|'MODEL_USAGE'; completeness:'COMPLETE'|'PARTIAL'|'UNKNOWN'; finality:'FINAL'|'PENDING'|'UNKNOWN';
  outcome?:ReconciliationActionOutcome; usage?:Partial<RunnerModelUsage>; pricingId?:string; currency?:'USD';
  responseState?:'NOT_APPLICABLE_VERIFIED'|'UNAVAILABLE_REVIEW_REQUIRED'; result?:RunnerExecutionResult;
  requestClosed?:boolean; exhaustive?:boolean; evidenceFields:string[];
}
export interface ReconciliationVerifierResult {
  target:ReconciliationTarget; targetDigest:string; source:ReconciliationSource; claim:ReconciliationClaim;
  status:'VERIFIED'|'INCOMPLETE'|'REJECTED'; reasonCodes:string[]; expiresAt:number;
}
export interface ReconciliationVerifierRequest {
  target:ReconciliationTarget; targetDigest:string; targetSnapshot:Readonly<Record<string,unknown>>;
  evidenceId:string; evidenceVersion:number; candidateDigest:string; body:unknown; signal:AbortSignal;
}
export interface ReconciliationVerifierBinding {
  verifierId:string; contractVersion:string; implementationDigest:string;
  authorityDomain:string; sourceSystem:string; account:string; environment:string;
  claims:readonly ('ACTION_OUTCOME'|'MODEL_USAGE')[];
  lookup:'NONE'; usageDefinition:string; pricingIds:readonly string[];
  verify(request:ReconciliationVerifierRequest):Promise<ReconciliationVerifierResult>|ReconciliationVerifierResult;
}
export interface ReconciliationVerifierRegistry { get(verifierId:string):ReconciliationVerifierBinding|undefined; isRevoked?(verifierId:string,bindingDigest:string):boolean }
export interface ReconciliationContentContext { stage:'ACCEPT'|'VERIFY'|'NORMALIZED'|'OUTPUT'; dataClass:string; ownerId:string; target:ReconciliationTarget }
export interface ReconciliationPolicy {
  version:string; authorityDomain:string;
  approvals:Partial<Record<ReconciliationOperationKind,RecoveryApprovalPolicy>>;
  canAccess(actor:VerifiedRecoveryIdentity,target:ReconciliationTarget,permission:ReconciliationPermission,ownerId?:string):boolean;
  /** Optional production boundary; absent denies sending reconciled facts to a model. */
  canSend?(actor:VerifiedRecoveryIdentity,target:ReconciliationTarget,destination:string,verification:ReconciliationVerification):boolean;
  inspectContent(value:unknown,context:ReconciliationContentContext):boolean;
}
export interface ReconciliationLimits {
  maxCandidateBytes:number; maxClaimBytes:number; maxReceiptBytes:number; maxDepth:number;
  maxCandidatesPerWorkflow:number; maxStoredBytesPerWorkflow:number; maxConcurrentVerifications:number;
  verificationTimeoutMs:number; collectionGraceMs:number; planTtlMs:number; maxPlanTtlMs:number;
}
export interface ReconciliationOptions { policy?:ReconciliationPolicy; verifiers?:ReconciliationVerifierRegistry; limits?:Partial<ReconciliationLimits> }
export interface SubmitReconciliationEvidence {
  target:ReconciliationTarget; logicalId?:string; body:unknown; dataClass:string; contentType:'application/json'|'text/plain';
}
export interface ReconciliationEvidence {
  evidenceId:string; logicalId:string; version:number; target:ReconciliationTarget; candidateDigest:string;
  evidenceOwnerId:string; submittedBy:string; dataClass:string; contentType:'application/json'|'text/plain'; sizeBytes:number; createdAt:number;
}
export interface ReconciliationVerification {
  verificationId:string; evidenceId:string; evidenceVersion:number; candidateDigest:string; target:ReconciliationTarget; targetDigest:string;
  verifierId:string; verifierContract:string; bindingDigest:string; status:'VERIFIED'|'INCOMPLETE'|'REJECTED';
  source:ReconciliationSource; sourceEffectKey:string; claim:ReconciliationClaim; claimDigest:string;
  reasonCodes:string[]; verifiedAt:number; expiresAt:number; verifiedBy:string; receiptDigest:string;
}
export interface VerifyReconciliationEvidence { evidenceId:string; verifierId:string }
export type ReconciliationEvidenceCommand =
 | {kind:'RUNNER_CONTEXT';workflowRunId:string;destination:string}
 | {kind:'SUBMIT_EVIDENCE';input:SubmitReconciliationEvidence}
 | {kind:'VIEW_EVIDENCE_BODY';evidenceId:string}
 | {kind:'VIEW_EVIDENCE';evidenceId:string}
 | {kind:'VIEW_VERIFICATION';verificationId:string}
 | {kind:'CANCEL_VERIFICATION';jobId:string}
 | {kind:'REVOKE_VERIFICATION';verificationId:string};
/** These closures are created inside DurableDatabase and never accepted from a public operation DTO. */
export interface ReconciliationHost {
  db:DurableDatabase; identityVerifier?:RecoveryIdentityVerifier;
  write<T>(lease:WorkflowLease,fn:(tx:DurableTransaction)=>T):T;
  scopedWrite(tx:DurableTransaction,lease:WorkflowLease,actorId:string,table:string,row:Row,old?:Row):void;
  outside<T>(fn:()=>T):T;
  notifyDrained(ids:readonly string[]):void;
}
export interface ReconciliationOperationContext {
  db:DurableDatabase; tx:DurableTransaction; lease:WorkflowLease; actor:VerifiedRecoveryIdentity; policy:ReconciliationPolicy; policyRevision:number; limits:ReconciliationLimits;
  authorize(credential:unknown,target:ReconciliationTarget,permission:ReconciliationPermission,ownerId?:string):VerifiedRecoveryIdentity;
  checkAccess(actor:VerifiedRecoveryIdentity,target:ReconciliationTarget,permission:ReconciliationPermission,ownerId?:string):void;
  validateVerification(id:string,target:ReconciliationTarget,actor?:VerifiedRecoveryIdentity):ReconciliationVerification;
  validateAdoptedActionVerification(id:string,target:ReconciliationTarget,actor?:VerifiedRecoveryIdentity):ReconciliationVerification;
  revalidateApproval(actorId:string,source:string,target:ReconciliationTarget):VerifiedRecoveryIdentity;
  write(table:string,row:Row,old?:Row):void;
}

export interface CreateReconciliationPlan {
  target:ReconciliationTarget; operationKind:ReconciliationOperationKind; verificationId:string; ttlMs?:number;
}
export interface ReconciliationPlanBinding {
  target:ReconciliationTarget; operationKind:ReconciliationOperationKind; verificationId:string;
  verificationDigest:string; sourceEffectKey:string; claimDigest:string; originalDigest:string;
  originalRuntimeInstanceId:string; originalGeneration:number;
  runtimeInstanceId:string; runtimeGeneration:number; journalCursor:number; journalEventId:string;
  holdEpoch:number; controlRevision:number; caseRevision:number; sealRevision:number;
  effectiveStateDigest:string; policyDigest:string; approvalPolicy:RecoveryApprovalPolicy;
  outcomeOperationId:string|null; plannedChanges:string[]; preserved:string[];
}
export interface ReconciliationPlan extends ReconciliationPlanBinding {
  planId:string; contract:typeof RECONCILIATION_CONTRACT; createdBy:string; createdAt:number; expiresAt:number; planDigest:string;
}
export interface ReconciliationGrantScope {
  planId:string; target:ReconciliationTarget; operationKind:ReconciliationOperationKind; planDigest:string; contract:typeof RECONCILIATION_CONTRACT;
}
export interface ReconciliationGrant extends ReconciliationGrantScope {
  grantId:string; approvedBy:string; authorizationSource:string; authorizedAt:number; expiresAt:number;
  status:'AUTHORIZED'|'CONSUMED'|'REVOKED'|'EXPIRED'; consumedOperationId:string|null; revokedAt:number|null; revokedBy:string|null;
}
export interface ReconciliationOperationReceipt {
  operationId:string; planId:string; contract:typeof RECONCILIATION_CONTRACT; target:ReconciliationTarget;
  operationKind:ReconciliationOperationKind; planDigest:string; verificationId:string; verificationDigest:string;
  sourceEffectKey:string; claimDigest:string; actorId:string; runtimeInstanceId:string; runtimeGeneration:number;
  committedAt:number; status:'COMMITTED'; grantIds:string[]; beforeJournalCursor:number; afterJournalCursor:number;
  journalEventIds:string[]; journalDigest:string; originalDigest:string; effectDigest:string;
  previousControlRevision:number; controlRevision:number; caseRevision:number;
}
export type ReconciliationOperationCommand =
 | {kind:'PREVIEW';target:ReconciliationTarget}
 | {kind:'INSPECT';target:ReconciliationTarget}
 | {kind:'CREATE_PLAN';input:CreateReconciliationPlan}
 | {kind:'AUTHORIZE';planId:string;scope:ReconciliationGrantScope;ttlMs?:number}
 | {kind:'REVOKE';grantId:string}
 | {kind:'EXECUTE'|'RECEIPT';planId:string};

export type ReconciliationCommand=ReconciliationEvidenceCommand|ReconciliationOperationCommand;
