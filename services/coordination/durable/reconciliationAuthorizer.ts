import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { ReconciliationGrant, ReconciliationGrantScope } from './reconciliationTypes';
export { reconciliationScopeOf } from './reconciliationStore';
export class ReconciliationAuthorizer {
 constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
 authorize(planId:string,scope:ReconciliationGrantScope,credential:unknown,ttlMs?:number):ReconciliationGrant {
  return this.database.reconciliationDecision(this.lease,credential,{kind:'AUTHORIZE',planId,scope,...(ttlMs===undefined?{}:{ttlMs})}) as ReconciliationGrant;
 }
 revoke(grantId:string,credential:unknown):ReconciliationGrant {
  return this.database.reconciliationDecision(this.lease,credential,{kind:'REVOKE',grantId}) as ReconciliationGrant;
 }
}
