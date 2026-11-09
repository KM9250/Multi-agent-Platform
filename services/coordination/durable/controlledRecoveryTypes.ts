import type { RunnerActionExecutor } from '../runner/types';
import type { RecoveryApprovalPolicy, RecoveryRole } from './recoveryDecisionTypes';

export const CONTROLLED_RECOVERY_CONTRACT = 'COORD-5C-4B2:CONTROLLED_EXECUTION:1' as const;
export const CONTROLLED_OPERATION = 'ALLOW_PREPARED_DISPATCH' as const;
/** Host settings, never request/model parameters. Milliseconds; no lease extension. */
export const CONTROLLED_LIMITS = Object.freeze({
  sendTtlMs: 60_000, executionTimeoutMs: 30_000, resultGraceMs: 30_000,
  maxSendTtlMs: 300_000, maxExecutionTimeoutMs: 120_000, maxResultGraceMs: 120_000,
  evidenceCount: 16, evidenceBytes: 1024 * 1024,
});
export interface ControlledTiming { sendTtlMs: number; executionTimeoutMs: number; resultGraceMs: number }
/** Explicit host attestation. Ordinary executors are NOT implicitly opted in. */
export interface ControlledExecutorBinding {
  executor: RunnerActionExecutor; contractVersion: string; implementationDigest: string;
  sideEffectRetries: 'disabled';
}
export interface ControlledExecutorRegistry { get(executorId: string): ControlledExecutorBinding | undefined }
export interface ControlledPlanInput { workflowRunId: string; actionId: string }
export interface ControlledBinding extends ControlledPlanInput {
  operationKind: typeof CONTROLLED_OPERATION; operationContractVersion: typeof CONTROLLED_RECOVERY_CONTRACT;
  sessionId: string; taskId: string; fingerprint: string; payloadDigest: string; registrationDigest: string;
  executorId: string; executorContractVersion: string; executorBindingDigest: string;
  journalCursor: number; journalEventId: string; actionStateDigest: string; modelStateDigest: string;
  policyDigest: string; budgetPositionDigest: string; controlledStateDigest: string;
  recoveryHoldRevision: number; runtimeInstanceId: string; runtimeGeneration: number;
  approvalPolicy: RecoveryApprovalPolicy; reviewDigest: string;
  maxActionDispatches: 1; maxModelCalls: 0; maxRounds: 0;
  timing: ControlledTiming;
}
export interface ControlledPlan extends ControlledBinding {
  planId: string; createdByActorId: string; createdAt: number; sendDeadline: number; planDigest: string;
}
export interface ControlledGrantScope {
  workflowRunId: string; actionId: string; planDigest: string;
  operationKind: typeof CONTROLLED_OPERATION; operationContractVersion: typeof CONTROLLED_RECOVERY_CONTRACT;
}
export interface ControlledGrant extends ControlledGrantScope {
  authorizationId: string; planId: string; authorizedActorId: string; authorizerRole: RecoveryRole;
  authorizationSource: string; authorizedAt: number; expiresAt: number;
  runtimeInstanceId: string; runtimeGeneration: number;
  status: 'AUTHORIZED' | 'REVOKED' | 'CONSUMED' | 'EXPIRED'; consumedOperationId: string | null;
  revokedAt: number | null; revokedByActorId: string | null;
}
export interface DispatchIntent {
  operationId: string; planId: string; workflowRunId: string; sessionId: string; taskId: string; actionId: string;
  attemptId: string; planDigest: string; actorId: string; runtimeInstanceId: string; runtimeGeneration: number;
  grantIds: string[]; committedAt: number; sendDeadline: number; executionTimeoutMs: number;
  resultCollectionDeadline: number; expectedLedgerDigest: string; expectedStateDigest: string;
  resultRef: string; defaultEvidenceRef: string;
  operationKind: typeof CONTROLLED_OPERATION; operationContractVersion: typeof CONTROLLED_RECOVERY_CONTRACT;
}
export interface DispatchReceipt {
  operationId: string; planId: string; workflowRunId: string; actionId: string; attemptId: string;
  status: 'RESULT_RECORDED' | 'REVIEW_REQUIRED'; resultRef: string; resultDigest: string;
  recordedAt: number; reasonCode: string | null;
}
export interface DispatchInspection {
  plan: ControlledPlan; grants: ControlledGrant[]; intent?: DispatchIntent; receipt?: DispatchReceipt;
  status: 'NOT_STARTED' | 'INTENT_RECORDED' | 'RESULT_RECORDED' | 'REVIEW_REQUIRED';
  outcome: 'NOT_STARTED' | 'IN_PROGRESS_OR_UNKNOWN' | 'OUTCOME_UNKNOWN' | 'RESULT_AVAILABLE';
  taskStatus: string; finalizedEventId: string | null; executionAllowed: false;
}
export type ControlledCommand =
  | { kind: 'CREATE_PLAN'; input: ControlledPlanInput }
  | { kind: 'AUTHORIZE'; planId: string; scope: ControlledGrantScope; ttlMs?: number }
  | { kind: 'REVOKE'; authorizationId: string }
  | { kind: 'INSPECT'; planId: string };
