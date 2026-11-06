import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import { DurableStoreError } from './integrity';
import { previewSafeRecovery } from './safeRecoveryPlanner';
import type { CreateRecoveryExecutionPlan, RecoveryExecutionGrant, RecoveryExecutionGrantScope, RecoveryExecutionPlan, RecoveryOperationReceipt } from './safeRecoveryTypes';
export { SAFE_RECOVERY_CONTRACT, SAFE_RECOVERY_OPERATIONS } from './safeRecoveryTypes';
export type { RecoveryExecutionPlan, RecoveryExecutionGrant, RecoveryExecutionGrantScope, RecoveryOperationReceipt } from './safeRecoveryTypes';
export { executionScopeOf } from './safeRecoveryStore';

export class SafeRecoveryPlanner {
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  preview(workflowRunId: string) { return this.database.read(tx => previewSafeRecovery(this.database, tx, workflowRunId)); }
  createPlan(input: CreateRecoveryExecutionPlan, credential: unknown): RecoveryExecutionPlan {
    // Persist the original gate hold before binding its revision. Never invent a
    // recovery exception inside an ordinary writer or clear this historical hold.
    try { this.database.assertRecoveryExecution(this.lease, input.workflowRunId); }
    catch (error) { if (!(error instanceof DurableStoreError) || error.code !== 'RECOVERY_HELD') throw error; }
    return this.database.safeRecoveryDecision(this.lease, credential, { kind: 'CREATE_PLAN', input }) as RecoveryExecutionPlan;
  }
}
export class SafeRecoveryAuthorizer {
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  authorize(executionPlanId: string, scope: RecoveryExecutionGrantScope, credential: unknown, ttlMs?: number): RecoveryExecutionGrant {
    return this.database.safeRecoveryDecision(this.lease, credential, { kind: 'AUTHORIZE', executionPlanId, scope, ttlMs }) as RecoveryExecutionGrant;
  }
  revoke(authorizationId: string, credential: unknown, reason: 'OPERATOR_REVOKED' | 'POLICY_CHANGED' = 'OPERATOR_REVOKED'): RecoveryExecutionGrant {
    return this.database.safeRecoveryDecision(this.lease, credential, { kind: 'REVOKE', authorizationId, reason }) as RecoveryExecutionGrant;
  }
}
/** No executors, providers, arbitrary events, SQL, or application callbacks are accepted. */
export class SafeRecoveryExecutor {
  constructor(readonly database: DurableDatabase, readonly lease?: WorkflowLease) {}
  executeAuthorized(executionPlanId: string, credential: unknown): RecoveryOperationReceipt {
    try {
      return this.database.safeRecoveryDecision(this.lease, credential, { kind: 'EXECUTE', executionPlanId }) as RecoveryOperationReceipt;
    } catch (error) {
      if (error instanceof DurableStoreError && ['RECOVERY_UNAUTHENTICATED','RECOVERY_UNAUTHORIZED','LEASE_FENCED'].includes(error.code)) throw error;
      // A committed receipt is the only recovery from a missing COMMIT ACK.
      // This path cannot recreate a scope or re-enter the fixed operation.
      try { const saved = this.inspectReceipt(executionPlanId, credential); if (saved) return saved; } catch { /* Preserve the original fixed error. */ }
      throw error;
    }
  }
  inspectReceipt(executionPlanId: string, credential: unknown): RecoveryOperationReceipt | undefined {
    return this.database.safeRecoveryDecision(this.lease, credential, { kind: 'RECEIPT', executionPlanId }) as RecoveryOperationReceipt | undefined;
  }
}
