import type { DurableDatabase } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { ReconciliationOperationReceipt } from './reconciliationTypes';
import { DurableStoreError } from './integrity';
/** No provider, executor, event array, SQL or arbitrary callback is accepted. */
export class ReconciliationExecutor {
 constructor(readonly database:DurableDatabase,readonly lease?:WorkflowLease){}
 executeAuthorized(planId:string,credential:unknown):ReconciliationOperationReceipt {
  try{return this.database.reconciliationDecision(this.lease,credential,{kind:'EXECUTE',planId}) as ReconciliationOperationReceipt;}
  catch(error) {
   // Authentication/ownership failures must never turn into successful ACK recovery.
   if(error instanceof DurableStoreError&&['RECOVERY_UNAUTHENTICATED','RECOVERY_UNAUTHORIZED','LEASE_FENCED'].includes(error.code))throw error;
   try{const receipt=this.inspectReceipt(planId,credential);if(receipt)return receipt;}catch{/* Preserve fixed original failure. */}
   throw error;
  }
 }
 inspectReceipt(planId:string,credential:unknown):ReconciliationOperationReceipt|undefined {
  return this.database.reconciliationDecision(this.lease,credential,{kind:'RECEIPT',planId}) as ReconciliationOperationReceipt|undefined;
 }
}
