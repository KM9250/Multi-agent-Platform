import { findExhaustedBudget } from '../policy';
import { validateRunnerUsage } from '../runner/model';
import { randomUUID } from 'node:crypto';
import type { CoordinationEvent, CoordinationSnapshot } from '../types';
import type { RunnerModelUsage, RunnerModelApplicationResult, RunnerModelDiscardReason } from '../runner/types';
import { createRunnerEvent } from '../runner/eventFactory';
import { canonicalJson, digest, DurableStoreError, requireIntegrity } from './integrity';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import type { DurableTransaction, Row } from './db';
import { addAmounts, costMicros, safeAmount, usageAmounts, zeroAmounts } from './modelBudgetGuard';
import type { ModelAmounts } from './modelBudgetGuard';
export interface ModelBudgetQuote {
 providerId: string; modelId: string; maxAttempts: 1; inputTokens: number; maxOutputTokens: number;
 maxEstimatedCost: number; pricingId: string; conditions: string; requestDigest: string;
}
export interface ModelCallIdentity { workflowRunId: string; modelCallId: string; attemptId: string; providerId: string; modelId: string }
export interface ReserveModelCall extends ModelCallIdentity {
 roundKey: string; phase: 'PLAN' | 'VERIFY'; requestCursor: number; requestEventId: string; quote: ModelBudgetQuote;
}
export type ModelCallReason = 'USAGE_UNKNOWN' | 'USAGE_PARTIAL' | 'BUDGET_VIOLATION' | 'PRE_DISPATCH_CANCELLED' | 'INVALID_RESPONSE' | 'STALE_RESPONSE' | 'ABORTED' | 'API_ERROR' | 'BUDGET_EXHAUSTED' | 'WORKFLOW_STOPPED';
export function validateQuote(q: ModelBudgetQuote): ModelAmounts {
 requireIntegrity(q && q.maxAttempts===1 && /^[a-f0-9]{64}$/.test(q.requestDigest));
 for (const s of [q.providerId,q.modelId,q.pricingId,q.conditions]) requireIntegrity(typeof s==='string' && /^[a-zA-Z0-9_.:/ -]{1,160}$/.test(s));
 return {llmCalls:1,inputTokens:safeAmount(q.inputTokens),outputTokens:safeAmount(q.maxOutputTokens),costMicros:costMicros(q.maxEstimatedCost)};
}
export function modelBudgetPosition(tx: DurableTransaction, store: SqliteCoordinationRunnerStore, id: string) {
 const s=store.restoreWorkflowInTransaction(tx,id);
 let committed=zeroAmounts(),outstanding=zeroAmounts();
 // Journal remains authoritative, including non-model usage; round each event conservatively.
 for(const e of s.events) if(e.type==='UsageRecorded') {
  const u=e.payload as RunnerModelUsage;
  committed=addAmounts(committed,{llmCalls:safeAmount(u.llmCalls),inputTokens:safeAmount(u.inputTokens),outputTokens:safeAmount(u.outputTokens),costMicros:costMicros(u.estimatedCost)});
 }
 for(const r of tx.all("SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND state IN ('RESERVED','DISPATCH_INTENT','REVIEW_REQUIRED')",id))
  outstanding=addAmounts(outstanding,{llmCalls:Number(r.reserved_calls),inputTokens:Number(r.reserved_input),outputTokens:Number(r.reserved_output),costMicros:Number(r.reserved_cost)});
 const b=s.run.budget;
 return {committed,outstanding,limit:{llmCalls:b.maxLlmCalls,inputTokens:b.maxInputTokens,outputTokens:b.maxOutputTokens,costMicros:costMicros(b.maxEstimatedCost,'floor')}};
}
export class ModelCallLedger {
 constructor(readonly store: SqliteCoordinationRunnerStore, private readonly clock={now:Date.now}) {}
 inspect(id: string, callId?: string): Row[] {return this.store.database.read(tx=>tx.all(`SELECT * FROM model_call_ledger WHERE workflow_run_id=?${callId?' AND model_call_id=?':''} ORDER BY created_at,model_call_id`,...callId?[id,callId]:[id]));}
 getBudgetPosition(id: string) {return this.store.database.read(tx=>modelBudgetPosition(tx,this.store,id));}
 private owned(tx: DurableTransaction, x: ModelCallIdentity): Row {
  const r=tx.get('SELECT * FROM model_call_ledger WHERE model_call_id=? AND workflow_run_id=?',x.modelCallId,x.workflowRunId);
  requireIntegrity(r && r.attempt_id===x.attemptId && r.provider_id===x.providerId && r.model_id===x.modelId);
  if(r.runtime_instance_id!==this.store.lease?.runtimeInstanceId || r.generation!==this.store.lease?.generation) throw new DurableStoreError('LEASE_FENCED');
  return r;
 }
 /** Called only inside the lease-fenced writer: policy and reservations share one DB snapshot. */
 private assertBudget(tx: DurableTransaction, snapshot: CoordinationSnapshot, requested=zeroAmounts()): void {
  const now=this.clock.now(); requireIntegrity(Number.isFinite(now) && now>=0);
  const position=modelBudgetPosition(tx,this.store,snapshot.run.runId);
  // Reuse every policy stop condition, substituting integer micro-USD for the cost comparison.
  const exhausted=findExhaustedBudget(
   {...snapshot.run.budget,maxEstimatedCost:position.limit.costMicros},
   {...snapshot.run.usage,estimatedCost:position.committed.costMicros},
   Math.max(0,now-snapshot.run.createdAt));
  const total=addAmounts(addAmounts(position.committed,position.outstanding),requested);
  if(exhausted || (Object.keys(total) as (keyof ModelAmounts)[]).some(k=>total[k]>position.limit[k]))
   throw new DurableStoreError('MODEL_BUDGET_EXHAUSTED');
 }
 reserve(x: ReserveModelCall): Row {
  this.store.assertRecoveryExecution(x.workflowRunId, x.modelCallId);
  requireIntegrity(Object.keys(x.quote).every(k=>['providerId','modelId','maxAttempts','inputTokens','maxOutputTokens','maxEstimatedCost','pricingId','conditions','requestDigest'].includes(k)));
  const amounts=validateQuote(x.quote); requireIntegrity(x.quote.providerId===x.providerId && x.quote.modelId===x.modelId);
  return this.store.writeWorkflow(x.workflowRunId,tx=>{
   const prior=tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND round_key=? AND phase=?',x.workflowRunId,x.roundKey,x.phase);
   if(prior) { requireIntegrity(prior.model_call_id===x.modelCallId); const r=this.owned(tx,x); requireIntegrity(r.quote_json===canonicalJson(x.quote) && r.request_cursor===x.requestCursor && r.request_event_id===x.requestEventId); return r; }
   if(tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?',x.workflowRunId)?.coverage!=='TRACKED_FROM_CREATION') throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
   if(tx.get("SELECT model_call_id FROM model_call_ledger WHERE workflow_run_id=? AND (state IN ('DISPATCH_INTENT','REVIEW_REQUIRED') OR application_status='PENDING_APPLICATION' OR budget_violation=1)",x.workflowRunId)) throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
   const s=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId);
   requireIntegrity(s.run.status==='RUNNING' && s.run.executionMode==='supervised_autonomous');
   this.assertBudget(tx,s,amounts);
   if(s.events.at(-1)!.sequence!==x.requestCursor || s.events.at(-1)!.eventId!==x.requestEventId) throw new DurableStoreError('SEQUENCE_CONFLICT');
   const now=Date.now(),l=this.store.lease!;
   tx.run(`INSERT INTO model_call_ledger (model_call_id,workflow_run_id,round_key,phase,runtime_instance_id,generation,provider_id,model_id,request_cursor,request_event_id,attempt_id,quote_json,state,completeness,reserved_calls,reserved_input,reserved_output,reserved_cost,application_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'RESERVED','UNKNOWN',1,?,?,?,'NOT_APPLICABLE',?,?)`,x.modelCallId,x.workflowRunId,x.roundKey,x.phase,l.runtimeInstanceId,l.generation,x.providerId,x.modelId,x.requestCursor,x.requestEventId,x.attemptId,canonicalJson(x.quote),amounts.inputTokens,amounts.outputTokens,amounts.costMicros,now,now);
   tx.run("INSERT INTO model_call_attempts VALUES (?,?,?,?,?,1,NULL,'RESERVED','UNKNOWN',NULL)",x.attemptId,x.modelCallId,x.workflowRunId,l.runtimeInstanceId,l.generation);
   return this.owned(tx,x);
  });
 }
 markDispatchIntent(x: ModelCallIdentity): void {
  this.store.database.read(tx=>{ if(this.owned(tx,x).state!=='RESERVED') throw new DurableStoreError('MODEL_REVIEW_REQUIRED'); });
  this.store.assertRecoveryExecution(x.workflowRunId,x.modelCallId);this.store.writeWorkflow(x.workflowRunId,tx=>{
  const r=this.owned(tx,x); if(r.state!=='RESERVED') throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
  const s=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId);
  requireIntegrity(s.run.status==='RUNNING' && s.run.executionMode==='supervised_autonomous');
  // This call's reservation is already outstanding: do not add it twice.
  this.assertBudget(tx,s);
  requireIntegrity(s.events.at(-1)!.sequence===r.request_cursor && s.events.at(-1)!.eventId===r.request_event_id);
  if(tx.get("SELECT model_call_id FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id<>? AND (state IN ('DISPATCH_INTENT','REVIEW_REQUIRED') OR application_status='PENDING_APPLICATION' OR budget_violation=1)",x.workflowRunId,x.modelCallId)) throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
  tx.run("UPDATE model_call_ledger SET state='DISPATCH_INTENT',updated_at=? WHERE model_call_id=?",Date.now(),x.modelCallId);
 });}
 settle(x: ModelCallIdentity, usage: RunnerModelUsage, success: boolean): Row {
  usage=validateRunnerUsage(usage);
  const a=usageAmounts(usage), u=canonicalJson(usage);
  try { return this.store.writeWorkflow(x.workflowRunId,tx=>{
   const r=this.owned(tx,x);
   if(r.state==='SETTLED') {requireIntegrity(r.usage_json===u && (success ? r.application_status!=='NOT_APPLICABLE' : r.application_status==='NOT_APPLICABLE'));return r;}
   requireIntegrity(r.state==='DISPATCH_INTENT');
   const s=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId), now=Date.now();
   const event=createRunnerEvent(s,'UsageRecorded',{...usage,sourceRef:`map.runner.model.call.v1:${x.modelCallId}`},this.clock,{nextId:()=>randomUUID()});
   const violation=a.inputTokens>Number(r.reserved_input)||a.outputTokens>Number(r.reserved_output)||a.costMicros>Number(r.reserved_cost);
   tx.run("UPDATE model_call_ledger SET state='SETTLED',completeness='COMPLETE',usage_json=?,usage_cost=?,usage_event_id=?,application_status=?,budget_violation=?,reason_code=?,settled_at=?,updated_at=? WHERE model_call_id=?",u,a.costMicros,event.eventId,success?'PENDING_APPLICATION':'NOT_APPLICABLE',violation?1:0,violation?'BUDGET_VIOLATION':success?null:'API_ERROR',now,now,x.modelCallId);
   this.store.appendInTransaction(tx,event);
   return this.owned(tx,x);
  }); } catch(error) {
   // A COMMIT acknowledgement may be lost. Only an exact, current-owner receipt
   // can turn that uncertainty into success; otherwise retain the original stop.
   try {
    this.store.assertLease(x.workflowRunId);
    return this.store.database.read(tx=>{
     const r=this.owned(tx,x);
     requireIntegrity(r.state==='SETTLED' && r.usage_json===u && (success ? r.application_status!=='NOT_APPLICABLE' : r.application_status==='NOT_APPLICABLE'));
     const s=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId);
     requireIntegrity(s.events.some(e=>e.eventId===r.usage_event_id && e.type==='UsageRecorded'));
     return r;
    });
   } catch { throw error; }
  }
 }
 markReviewRequired(x: ModelCallIdentity, completeness: 'UNKNOWN'|'PARTIAL', usage?: Partial<RunnerModelUsage>): void {
  // Whitelist numeric facts only; never persist raw provider errors.
  const facts: Partial<RunnerModelUsage>={};
  for(const k of ['llmCalls','inputTokens','outputTokens','estimatedCost'] as const) if(usage?.[k]!==undefined) {
   if(k==='estimatedCost') costMicros(usage[k]!); else safeAmount(usage[k]!); facts[k]=usage[k];
  }
  this.store.writeWorkflow(x.workflowRunId,tx=>{const r=this.owned(tx,x);requireIntegrity(r.state==='DISPATCH_INTENT');
   tx.run("UPDATE model_call_ledger SET state='REVIEW_REQUIRED',completeness=?,usage_json=?,reason_code=?,updated_at=? WHERE model_call_id=?",completeness,canonicalJson(facts),completeness==='PARTIAL'?'USAGE_PARTIAL':'USAGE_UNKNOWN',Date.now(),x.modelCallId);
  });
 }
 cancelBeforeDispatch(x: ModelCallIdentity): void {this.store.writeWorkflow(x.workflowRunId,tx=>{const r=this.owned(tx,x);requireIntegrity(r.state==='RESERVED');tx.run("UPDATE model_call_ledger SET state='CANCELLED_PRE_DISPATCH',reason_code='PRE_DISPATCH_CANCELLED',updated_at=? WHERE model_call_id=?",Date.now(),x.modelCallId);});}
 /** The callback is synchronous and uses this same store. APPLIED requires new business events. */
 markApplied<T>(x: ModelCallIdentity, expectedCursor: number, apply: ()=>T): RunnerModelApplicationResult<T> {
  return this.store.atomicApplication(x.workflowRunId,tx=>{
   const r=this.owned(tx,x);
   if(r.application_status==='APPLIED') {
    const s=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId),end=s.events.findIndex(e=>e.eventId===r.application_event_id)+1;
    requireIntegrity(expectedCursor===r.application_start_cursor && end>expectedCursor && digest(s.events.slice(expectedCursor,end))===r.application_digest);
    return {status:'ALREADY_APPLIED',receipt:{modelCallId:x.modelCallId,startCursor:expectedCursor,eventId:String(r.application_event_id),digest:String(r.application_digest)}};
   }
   requireIntegrity(r.state==='SETTLED' && r.application_status==='PENDING_APPLICATION');
   const before=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId);requireIntegrity(before.events.length===expectedCursor && before.events.at(-1)!.eventId===r.usage_event_id && !r.budget_violation);
   const result=apply();if(result && typeof (result as {then?:unknown}).then==='function') throw new DurableStoreError('INVALID_TRANSACTION');
   const after=this.store.restoreWorkflowInTransaction(tx,x.workflowRunId), events=after.events.slice(expectedCursor);
   requireIntegrity(events.length>0 && events.every(e=>e.type!=='UsageRecorded'));
   tx.run("UPDATE model_call_ledger SET application_status='APPLIED',application_event_id=?,application_digest=?,application_start_cursor=?,updated_at=? WHERE model_call_id=?",events.at(-1)!.eventId,digest(events),expectedCursor,Date.now(),x.modelCallId);
   return {status:'APPLIED',value:result,receipt:{modelCallId:x.modelCallId,startCursor:expectedCursor,eventId:events.at(-1)!.eventId,digest:digest(events)}};
  });
 }
 /** Lost application ACK is resolved by the receipt; callback is never rerun. */
 inspectApplication(x: ModelCallIdentity, events: CoordinationEvent[]): boolean {return this.store.database.read(tx=>{const r=this.owned(tx,x);requireIntegrity(r.application_status==='APPLIED' && r.application_digest===digest(events));return true;});}
 markDiscarded(x: ModelCallIdentity, reason: RunnerModelDiscardReason): void {this.store.writeWorkflow(x.workflowRunId,tx=>{
  const r=this.owned(tx,x);if(r.application_status==='DISCARDED'){requireIntegrity(r.reason_code===reason);return;}
  requireIntegrity(r.state==='SETTLED' && r.application_status==='PENDING_APPLICATION');
  tx.run("UPDATE model_call_ledger SET application_status='DISCARDED',reason_code=?,updated_at=? WHERE model_call_id=?",reason,Date.now(),x.modelCallId);
 });}
}
