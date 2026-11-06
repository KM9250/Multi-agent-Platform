import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import { DurableStoreError, requireIntegrity } from './integrity';
import { RECOVERY_ROLES } from './recoveryDecisionTypes';
import type { RecoveryAuthorization, RecoveryDecisionCommand, RecoveryGrantScope, RecoveryIdentityVerifier, VerifiedRecoveryIdentity } from './recoveryDecisionTypes';

export function verifyRecoveryIdentity(verifier: RecoveryIdentityVerifier | undefined, credential: unknown, now: number, kind: RecoveryDecisionCommand['kind'] | 'VIEW'): VerifiedRecoveryIdentity {
  let identity: VerifiedRecoveryIdentity | undefined;
  try { identity = verifier?.verify(credential, now); } catch { /* Fixed error; no raw verifier error or credential persists. */ }
  if (!identity || !Number.isSafeInteger(identity.authenticatedAt) || identity.authenticatedAt > now
    || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now) throw new DurableStoreError('RECOVERY_UNAUTHENTICATED');
  requireIntegrity([identity.actorId, identity.source].every(s => typeof s === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(s))
    && Array.isArray(identity.roles) && identity.roles.every(r => RECOVERY_ROLES.includes(r)));
  const roles = kind === 'VIEW' ? RECOVERY_ROLES : kind === 'CREATE_PLAN' || kind === 'INVALIDATE' ? ['RECOVERY_OPERATOR','RECOVERY_ADMIN'] : ['RECOVERY_APPROVER','RECOVERY_ADMIN'];
  if (!identity.roles.some(r => roles.includes(r))) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  return Object.freeze({ ...identity, roles: Object.freeze([...identity.roles]) });
}
export class RecoveryAuthorizer {
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  authorize(recoveryPlanId: string, scope: RecoveryGrantScope, credential: unknown, ttlMs?: number): RecoveryAuthorization {
    return this.database.recoveryDecision(this.lease, credential, { kind: 'AUTHORIZE', recoveryPlanId, scope, ttlMs }) as RecoveryAuthorization;
  }
  revoke(authorizationId: string, credential: unknown, reason: 'OPERATOR_REVOKED' | 'POLICY_CHANGED' = 'OPERATOR_REVOKED'): RecoveryAuthorization {
    return this.database.recoveryDecision(this.lease, credential, { kind: 'REVOKE', authorizationId, reason }) as RecoveryAuthorization;
  }
  invalidate(recoveryPlanId: string, credential: unknown): void {
    this.database.recoveryDecision(this.lease, credential, { kind: 'INVALIDATE', recoveryPlanId });
  }
  /** Diagnostic validation only. There is deliberately no consume or execute method. */
  inspect(authorizationId: string, scope: RecoveryGrantScope) { return this.database.inspectRecoveryAuthorization(authorizationId, scope); }
}
