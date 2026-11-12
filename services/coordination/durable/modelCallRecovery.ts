import type { DurableTransaction } from './db';
import type { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { requireIntegrity, canonicalJson, digest } from './integrity';
import { modelBudgetPosition } from './modelCallLedger';
import { costMicros } from './modelBudgetGuard';
import { effectiveModelRows } from './safeRecoveryModelState';
export function inspectModelCalls(tx:DurableTransaction,store:SqliteCoordinationRunnerStore,id:string) {
 const coverage=tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?',id)?.coverage;
 requireIntegrity(coverage==='TRACKED_FROM_CREATION'||coverage==='LEGACY_UNTRACKED');
 const rows=tx.all('SELECT * FROM model_call_ledger WHERE workflow_run_id=? ORDER BY updated_at,model_call_id',id);
 const snapshot=store.restoreWorkflowInTransaction(tx,id);
 for(const r of rows) {
  const attempts=tx.all('SELECT * FROM model_call_attempts WHERE model_call_id=?',r.model_call_id);
  requireIntegrity(attempts.length===1 && attempts[0].attempt_id===r.attempt_id && attempts[0].state===r.state && attempts[0].completeness===r.completeness && attempts[0].workflow_run_id===id);
  requireIntegrity(snapshot.events.some(e=>e.eventId===r.request_event_id && e.sequence===r.request_cursor));
  const audits=tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND model_call_id=? AND event_kind LIKE 'MODEL_%' ORDER BY audit_sequence",id,r.model_call_id);
  requireIntegrity(audits.length>0 && audits[0].event_kind==='MODEL_CALL_RESERVED' && audits.at(-1)!.next_state===r.state);
  if(r.state==='SETTLED') {
   const e=snapshot.events.find(e=>e.eventId===r.usage_event_id),u=JSON.parse(String(r.usage_json));
   requireIntegrity(e?.type==='UsageRecorded' && canonicalJson(e.payload)===canonicalJson({...u,sourceRef:`map.runner.model.call.v1:${r.model_call_id}`}) && costMicros(u.estimatedCost)===r.usage_cost);
  }
  if(r.application_status==='APPLIED') {
   const end=snapshot.events.findIndex(e=>e.eventId===r.application_event_id);
   // Application starts at the settled usage cursor (no asynchronous mutation is accepted).
   const start=Number(r.application_start_cursor);
   requireIntegrity(end>=start && digest(snapshot.events.slice(start,end+1))===r.application_digest);
  }
 }
 for(const event of snapshot.events) if(event.type==='UsageRecorded' && String((event.payload as {sourceRef?:string}).sourceRef).startsWith('map.runner.model.call.v1:')) requireIntegrity(rows.some(r=>r.usage_event_id===event.eventId && r.state==='SETTLED'));
 const count=(key:string,value:string)=>rows.filter(r=>r[key]===value).length;
 const effective=effectiveModelRows(tx,id);
 const summary={total:rows.length,settled:count('state','SETTLED'),reserved:count('state','RESERVED'),dispatchIntent:count('state','DISPATCH_INTENT'),
  reviewRequired:count('state','REVIEW_REQUIRED'),unknownUsage:rows.filter(r=>['DISPATCH_INTENT','REVIEW_REQUIRED'].includes(String(r.state))).length,
  plan:count('phase','PLAN'),verify:count('phase','VERIFY'),pendingApplication:count('application_status','PENDING_APPLICATION'),
  budgetViolations:rows.filter(r=>r.budget_violation===1).length,latestReasonCode:rows.filter(r=>r.reason_code).at(-1)?.reason_code as string|undefined,
  effectiveReserved:effective.filter(r=>r.historical.state==='RESERVED' && r.outstandingReservation).length,
  effectiveUnknownUsage:effective.filter(r=>r.outstandingReservation && ['DISPATCH_INTENT','REVIEW_REQUIRED'].includes(String(r.historical.state))).length,
  effectiveBudgetViolations:effective.filter(r=>r.budgetViolation).length,
  disputed:effective.filter(r=>r.disputed).length,
  effectivePendingApplication:effective.filter(r=>r.pendingApplication).length,
  reconciliations:effective.filter(r=>r.reconciliation).map(r=>({modelCallId:String(r.historical.model_call_id),
   historicalState:String(r.historical.state),historicalApplication:String(r.historical.application_status),
   accountingState:r.accountingState,responseState:r.responseState,operationId:String(r.reconciliation!.operation_id),
   originalRuntimeInstanceId:String(r.historical.runtime_instance_id),originalGeneration:Number(r.historical.generation),
   outstandingReservation:r.outstandingReservation,disputed:r.disputed})),
  recoveryResolutions:effective.filter(r=>r.resolution).map(r=>({modelCallId:String(r.historical.model_call_id),
   historicalState:String(r.historical.state),historicalApplication:String(r.historical.application_status),
   resolutionKind:r.resolution!.resolution_kind as 'CANCELLED_UNSENT'|'DISCARDED_BY_RECOVERY',operationId:String(r.resolution!.operation_id),
   originalRuntimeInstanceId:String(r.resolution!.original_runtime_instance_id),originalGeneration:Number(r.resolution!.original_generation),
   effectiveOutstandingReservation:r.outstandingReservation ? {llmCalls:Number(r.historical.reserved_calls),inputTokens:Number(r.historical.reserved_input),outputTokens:Number(r.historical.reserved_output),costMicros:Number(r.historical.reserved_cost)} : {llmCalls:0,inputTokens:0,outputTokens:0,costMicros:0},
   effectiveApplication:r.resolution!.resolution_kind==='DISCARDED_BY_RECOVERY'?'RESOLVED':String(r.historical.application_status)})),
  outstandingReservation:modelBudgetPosition(tx,store,id).outstanding};
 return {coverage:coverage as 'TRACKED_FROM_CREATION'|'LEGACY_UNTRACKED',summary};
}

export type ModelCallSummary = ReturnType<typeof inspectModelCalls>['summary'];
