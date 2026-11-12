import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { CreateReconciliationPlan, ReconciliationPlan, ReconciliationTarget } from './reconciliationTypes';
export { reconciliationScopeOf } from './reconciliationStore';
export { RECONCILIATION_CONTRACT, RECONCILIATION_OPERATIONS } from './reconciliationTypes';
export class ReconciliationPlanner {
 constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
 preview(target:ReconciliationTarget,credential:unknown) {
  return this.database.reconciliationDecision(this.lease,credential,{kind:'PREVIEW',target});
 }
 createPlan(input:CreateReconciliationPlan,credential:unknown):ReconciliationPlan {
  return this.database.reconciliationDecision(this.lease,credential,{kind:'CREATE_PLAN',input}) as ReconciliationPlan;
 }
}
