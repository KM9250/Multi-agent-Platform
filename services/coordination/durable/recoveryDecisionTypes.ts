import type { RecoveryAuthorizationRequirement } from './recoveryTypes';

export const RECOVERY_CONTRACT = 'COORD-5C-4A:RECORD_ONLY:1' as const;
export const RECOVERY_OPERATIONS = ['REFLECT_RECORDED_RESULT', 'CANCEL_UNSENT_MODEL', 'DISCARD_SETTLED_RESPONSE',
  'COMPLETE_SAFETY_STOP', 'ALLOW_PREPARED_DISPATCH', 'BOUNDED_CONTINUATION', 'RECONCILE_VERIFIED_USAGE'] as const;
export type RecoveryOperationKind = typeof RECOVERY_OPERATIONS[number];
export const RECOVERY_ROLES = ['RECOVERY_VIEWER', 'RECOVERY_OPERATOR', 'RECOVERY_APPROVER', 'RECOVERY_ADMIN'] as const;
export type RecoveryRole = typeof RECOVERY_ROLES[number];
export const RECOVERY_REASONS = ['LEASE_TAKEOVER', 'LEGACY_COVERAGE', 'ACTION_UNCERTAIN', 'MODEL_UNCERTAIN',
  'PENDING_RESPONSE', 'BUDGET_VIOLATION', 'EXPLICIT_STOP', 'SECURITY_REVIEW', 'EVIDENCE_REVIEW', 'ACTION_APPROVAL',
  'INTEGRITY_UNVERIFIED', 'STATE_CHANGED', 'OPERATOR_REVOKED', 'POLICY_CHANGED'] as const;
export type RecoveryReason = typeof RECOVERY_REASONS[number];

/** Trusted server composition dependency, never a request DTO. Default: no verifier. */
export interface RecoveryIdentityVerifier {
  verify(credential: unknown, databaseTime: number): VerifiedRecoveryIdentity | undefined;
}
export interface VerifiedRecoveryIdentity {
  actorId: string; roles: readonly RecoveryRole[]; source: string; authenticatedAt: number; expiresAt: number;
}
export interface RecoveryApprovalPolicy { minimumApprovers: number; forbidSelfApproval: boolean }
export type RecoveryAuthorizationPolicy = Partial<Record<RecoveryOperationKind, RecoveryApprovalPolicy>>;
export interface RecoveryRequirements {
  reviews: RecoveryAuthorizationRequirement[]; approvalPolicy: RecoveryApprovalPolicy;
}
export interface RecoveryPlanBinding {
  workflowRunId: string; operationKind: RecoveryOperationKind; targetId: string;
  journalCursor: number; journalEventId: string; runtimeInstanceId: string; runtimeGeneration: number;
  actionStateDigest: string; modelStateDigest: string; policyDigest: string; budgetPositionDigest: string;
  recoveryHoldRevision: number; authorizationRequirements: RecoveryRequirements;
  operationContractVersion: typeof RECOVERY_CONTRACT;
}
export interface RecoveryPlan extends RecoveryPlanBinding {
  recoveryPlanId: string; createdByActorId: string; createdAt: number; expiresAt: number; planDigest: string;
}
export interface RecoveryCandidate {
  operationKind: RecoveryOperationKind; targetId: string; reasonCodes: string[];
  authorizationRequirements: RecoveryRequirements; executable: false;
}
export interface RecoveryPreview {
  workflowRunId: string; candidates: RecoveryCandidate[]; prohibitedReasons: string[]; executionAllowed: false;
}
export interface CreateRecoveryPlan {
  workflowRunId: string; operationKind: RecoveryOperationKind; targetId: string; ttlMs?: number;
}
export interface RecoveryGrantScope {
  workflowRunId: string; operationKind: RecoveryOperationKind; targetId: string; planDigest: string;
  operationContractVersion: string;
}
export interface RecoveryAuthorization extends RecoveryGrantScope {
  authorizationId: string; recoveryPlanId: string; authorizedActorId: string; authorizerRole: RecoveryRole;
  authorizationSource: string; authorizedAt: number; expiresAt: number;
  runtimeInstanceId: string; runtimeGeneration: number;
  status: 'AUTHORIZED' | 'REVOKED' | 'EXPIRED' | 'CONSUMED'; revocationReason: RecoveryReason | null; revokedAt: number | null; revokedByActorId: string | null;
}
export type RecoveryDecisionCommand =
  | { kind: 'CREATE_PLAN'; input: CreateRecoveryPlan }
  | { kind: 'AUTHORIZE'; recoveryPlanId: string; scope: RecoveryGrantScope; ttlMs?: number }
  | { kind: 'REVOKE'; authorizationId: string; reason: 'OPERATOR_REVOKED' | 'POLICY_CHANGED' }
  | { kind: 'INVALIDATE'; recoveryPlanId: string };

export const DEFAULT_RECOVERY_TTL_MS = 600_000;
export const MAX_RECOVERY_TTL_MS = 1_800_000;
