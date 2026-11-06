import type { Row } from './db';
import type { CoordinationEvent } from '../types';
import type { RecoveryAuthorizationPolicy, RecoveryRequirements, RecoveryRole } from './recoveryDecisionTypes';

export const SAFE_RECOVERY_CONTRACT = 'COORD-5C-4B:EXECUTE:1' as const;
export const SAFE_RECOVERY_OPERATIONS = ['REFLECT_RECORDED_RESULT', 'CANCEL_UNSENT_MODEL', 'DISCARD_SETTLED_RESPONSE', 'COMPLETE_SAFETY_STOP'] as const;
export type SafeRecoveryOperationKind = typeof SAFE_RECOVERY_OPERATIONS[number];
export interface CreateRecoveryExecutionPlan { workflowRunId: string; operationKind: SafeRecoveryOperationKind; targetId: string; ttlMs?: number }
export interface RecoveryExecutionBinding {
  workflowRunId: string; operationKind: SafeRecoveryOperationKind; targetId: string;
  journalCursor: number; journalEventId: string; actionStateDigest: string; modelStateDigest: string;
  policyDigest: string; budgetPositionDigest: string; recoveryHoldRevision: number;
  runtimeInstanceId: string; runtimeGeneration: number; authorizationRequirements: RecoveryRequirements;
  plannedChanges: string[]; operationContractVersion: typeof SAFE_RECOVERY_CONTRACT;
}
export interface RecoveryExecutionPlan extends RecoveryExecutionBinding {
  executionPlanId: string; createdByActorId: string; createdAt: number; expiresAt: number; planDigest: string;
}
export interface RecoveryExecutionGrantScope {
  workflowRunId: string; operationKind: SafeRecoveryOperationKind; targetId: string;
  planDigest: string; operationContractVersion: typeof SAFE_RECOVERY_CONTRACT;
}
export interface RecoveryExecutionGrant extends RecoveryExecutionGrantScope {
  authorizationId: string; executionPlanId: string; authorizedActorId: string; authorizerRole: RecoveryRole;
  authorizationSource: string; authorizedAt: number; expiresAt: number; runtimeInstanceId: string; runtimeGeneration: number;
  status: 'AUTHORIZED' | 'REVOKED' | 'EXPIRED' | 'CONSUMED'; consumedOperationId: string | null;
  revocationReason: 'OPERATOR_REVOKED' | 'POLICY_CHANGED' | null; revokedAt: number | null; revokedByActorId: string | null;
}
export interface RecoveryOperationReceipt {
  operationId: string; executionPlanId: string; workflowRunId: string; planDigest: string;
  operationKind: SafeRecoveryOperationKind; targetId: string; status: 'COMMITTED';
  operationContractVersion: typeof SAFE_RECOVERY_CONTRACT; actorId: string; runtimeInstanceId: string; runtimeGeneration: number;
  committedAt: number; grantIds: string[]; beforeJournalCursor: number; afterJournalCursor: number;
  journalEventIds: string[]; journalDigest: string; beforeTargetDigest: string; afterTargetDigest: string;
  resolutionKind: 'CANCELLED_UNSENT' | 'DISCARDED_BY_RECOVERY' | null;
  previousHoldRevision: number; holdRevision: number;
  holdState: 'RECOVERY_STEP_APPLIED' | 'READY_FOR_CONTINUATION_REVIEW';
}
export type SafeRecoveryCommand =
  | { kind: 'CREATE_PLAN'; input: CreateRecoveryExecutionPlan }
  | { kind: 'AUTHORIZE'; executionPlanId: string; scope: RecoveryExecutionGrantScope; ttlMs?: number }
  | { kind: 'REVOKE'; authorizationId: string; reason: 'OPERATOR_REVOKED' | 'POLICY_CHANGED' }
  | { kind: 'EXECUTE' | 'RECEIPT'; executionPlanId: string };
/** Passed only to a closure owned by DurableDatabase; never accepted from API callers. */
export interface SafeRecoveryIntent {
  kind: 'CREATE_PLAN' | 'AUTHORIZE' | 'REVOKE' | 'EXECUTE'; workflowRunId: string; id: string;
  executionPlanId: string; actorId: string; plan?: RecoveryExecutionPlan; operationId?: string;
  grantIds?: string[]; journalEvents?: CoordinationEvent[]; expectedTargetDigest?: string; expectedLedger?: Row;
}
export interface RecoveryExecutionPreview {
  workflowRunId: string; candidates: Array<{ operationKind: SafeRecoveryOperationKind; targetId: string; executable: false }>;
  executionAllowed: false;
}
export type SafeRecoveryPolicy = RecoveryAuthorizationPolicy;
