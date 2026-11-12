import { validateRunnerUsage } from '../runner/model';
import { randomUUID } from 'node:crypto';
import type { RunnerSupervisorProvider, RunnerPlanRequest, RunnerVerifyRequest, RunnerModelResult, RunnerDurableModelCalls, RunnerModelApplicationResult, RunnerModelDiscardReason } from '../runner/types';
import { canonicalJson, digest, DurableStoreError, requireIntegrity } from './integrity';
import { ModelCallLedger, validateQuote } from './modelCallLedger';
import type { ModelBudgetQuote, ModelCallIdentity } from './modelCallLedger';
import type { SqliteCoordinationRunnerStore } from './durableCoordinationStore';

export interface DurableUsageReceipt {
 attemptId: string; providerId: string; modelId: string;
 completeness: 'COMPLETE'|'PARTIAL'|'UNKNOWN'; source: 'TEST_EXPLICIT';
}
type Prepared = { quote: ModelBudgetQuote; invoke(attemptId: string): Promise<RunnerModelResult<unknown> & { receipt: DurableUsageReceipt }> };
const adapters = new WeakMap<RunnerSupervisorProvider, (phase:'PLAN'|'VERIFY',request:RunnerPlanRequest|RunnerVerifyRequest)=>Prepared>();
/** Explicit in-memory test boundary. No production provider is implicitly certified.
 * The callback is trusted test code; it MUST NOT perform network I/O or internal retry.
 * Production adapters must be implemented/reviewed here, with transport retry disabled.
 */
export function createTestDurableModelAdapter(provider: RunnerSupervisorProvider, bounds: Omit<ModelBudgetQuote,'requestDigest'|'maxAttempts'>): RunnerSupervisorProvider {
 bounds=Object.freeze({...bounds});
 const wrapped: RunnerSupervisorProvider={...provider,plan:r=>provider.plan(r),verify:r=>provider.verify(r)};
 adapters.set(wrapped,(phase,request)=>{
  const {signal,...body}=request;
  const frozen=structuredClone(body);
  const quote={...bounds,maxAttempts:1 as const,requestDigest:digest({phase,request:frozen})};validateQuote(quote);
  return {quote,async invoke(attemptId){
   const call=phase==='PLAN'?()=>provider.plan({...structuredClone(frozen),signal} as RunnerPlanRequest):()=>provider.verify({...structuredClone(frozen),signal} as RunnerVerifyRequest);
   let result:RunnerModelResult<unknown>;
   try {result=await call();} catch(error) {
    const e=error as {usage?:RunnerModelResult<unknown>['usage'];testUsageCompleteness?:DurableUsageReceipt['completeness']};
    throw {usage:e?.usage,receipt:{attemptId,providerId:bounds.providerId,modelId:bounds.modelId,source:'TEST_EXPLICIT',completeness:e?.testUsageCompleteness ?? 'UNKNOWN'}};
   }
   return {...result,receipt:{attemptId,providerId:result.provider,modelId:result.model,completeness:'COMPLETE',source:'TEST_EXPLICIT'}};
  }};
 });
 return wrapped;
}
export class DurableModelCallCoordinator implements RunnerDurableModelCalls {
 readonly ledger: ModelCallLedger;
 constructor(readonly store: SqliteCoordinationRunnerStore,readonly provider:RunnerSupervisorProvider,clock={now:Date.now},readonly reconciliationContext?:{credential:unknown;destination:string}) {this.ledger=new ModelCallLedger(store,clock);}
 assertCanRun(id:string):void {
  this.store.assertRecoveryExecution(id);
  this.store.assertLease(id);
  const coverage=this.store.database.read(tx=>tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?',id)?.coverage);
  if(coverage!=='TRACKED_FROM_CREATION' || this.ledger.inspectEffective(id).some(r=>r.unresolved)) throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
 }
 getReconciledEvidence(id:string,task:import('../types').CoordinationTask,ref:string):import('../runner/types').RunnerEvidence|undefined {
  const facts=this.store.database.reconciliationDecision(undefined,this.reconciliationContext?.credential,
    {kind:'RUNNER_CONTEXT',workflowRunId:id,destination:this.reconciliationContext?.destination??'unconfigured'}) as import('../runner/types').RunnerReconciledFact[];
  const fact=facts.find(item=>item.resultRef===ref);if(!fact)return;
  return this.store.database.read(tx=>{
    const application=tx.get('SELECT * FROM reconciled_action_applications WHERE workflow_run_id=? AND action_id=? AND task_id=? AND result_ref=?',id,fact.targetId,task.taskId,ref);
    requireIntegrity(application&&application.attempt_id===fact.attemptId);
    return {kind:'reconciled-action-fact',content:fact,createdAt:Number(application.created_at)};
  });
 }
 async call(input: Parameters<RunnerDurableModelCalls['call']>[0]) {
  this.assertCanRun(input.workflowRunId);
  if(input.request.signal?.aborted) throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
  // All reconciled facts in the actual request are authenticated here. Callers
  // cannot inject a verified-looking DTO, and the final send rechecks the ACL.
  const readFacts=()=>this.store.database.reconciliationDecision(undefined,this.reconciliationContext?.credential,
    {kind:'RUNNER_CONTEXT',workflowRunId:input.workflowRunId,destination:this.reconciliationContext?.destination??'unconfigured'}) as import('../runner/types').RunnerReconciledFact[];
  const facts=readFacts();
  const request={...input.request,reconciledFacts:facts,effectiveUsage:this.store.getEffectiveUsage(input.workflowRunId)};
  const prepare=adapters.get(this.provider);if(!prepare)throw new DurableStoreError('MODEL_ADAPTER_UNSUPPORTED');
  const prepared=prepare(input.phase,request),q=prepared.quote;
  if(this.provider.scheduling) requireIntegrity(this.provider.scheduling.provider===q.providerId && this.provider.scheduling.model===q.modelId);
  const x={workflowRunId:input.workflowRunId,modelCallId:randomUUID(),attemptId:randomUUID(),providerId:q.providerId,modelId:q.modelId};
  this.ledger.reserve({...x,businessRoundKey:input.roundKey,roundKey:this.store.database.boundedInvocationActive ? `bounded:${x.modelCallId}:${input.roundKey}` : input.roundKey,phase:input.phase,requestCursor:input.requestCursor,requestEventId:input.requestEventId,quote:q});
  if(input.request.signal?.aborted){this.ledger.cancelBeforeDispatch(x);throw new DurableStoreError('MODEL_REVIEW_REQUIRED');}
  try { requireIntegrity(canonicalJson(readFacts())===canonicalJson(facts)); }
  catch(error) {this.ledger.cancelBeforeDispatch(x);throw error;}
  this.ledger.markDispatchIntent(x);
  this.store.assertLease(x.workflowRunId);
  if(input.request.signal?.aborted){this.ledger.markReviewRequired(x,'UNKNOWN');throw new DurableStoreError('MODEL_REVIEW_REQUIRED');}
  let response: Awaited<ReturnType<Prepared['invoke']>>;
  try {
   if(this.store.database.boundedInvocationActive) {
    const collected=await this.store.database.collectInvocationModel(()=>prepared.invoke(x.attemptId),input.request.signal);
    if(collected.timedOut||collected.aborted) {
      const late=collected.value;
      if(late&&this.matches(late.receipt,x)&&late.receipt.completeness==='COMPLETE')this.ledger.settle(x,late.usage,false);
      else this.ledger.markReviewRequired(x,'UNKNOWN');
      throw new DurableStoreError('CONTINUATION_EXPIRED');
    }
    if(!collected.value)throw collected.error??new DurableStoreError('MODEL_REVIEW_REQUIRED');
    response=collected.value;
   } else response=await prepared.invoke(x.attemptId);
  }
  catch(error) {
   this.store.assertLease(x.workflowRunId);
   if(this.ledger.inspect(x.workflowRunId,x.modelCallId)[0]?.state!=='DISPATCH_INTENT')throw error;
   const e=error as {receipt?:DurableUsageReceipt;usage?:RunnerModelResult<unknown>['usage']};
   if(this.matches(e?.receipt,x) && e.receipt!.completeness==='COMPLETE' && e.usage) this.ledger.settle(x,e.usage,false);
   else this.ledger.markReviewRequired(x,this.matches(e?.receipt,x) && e.receipt!.completeness==='PARTIAL'?'PARTIAL':'UNKNOWN',this.matches(e?.receipt,x)?e.usage:undefined);
   throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
  }
  this.store.assertLease(x.workflowRunId);
  if(!this.matches(response.receipt,x) || response.receipt.completeness!=='COMPLETE') {
   this.ledger.markReviewRequired(x,'UNKNOWN');throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
  }
  try {response.usage=validateRunnerUsage(response.usage);} catch {this.ledger.markReviewRequired(x,'UNKNOWN');throw new DurableStoreError('MODEL_INVALID_USAGE');}
  const row=this.ledger.settle(x,response.usage,true);
  if(row.budget_violation) {
   this.ledger.markDiscarded(x,'BUDGET_EXHAUSTED');
   throw new DurableStoreError('MODEL_REVIEW_REQUIRED'); // Violation flag still prohibits subsequent calls.
  }
  if(response.provider!==x.providerId || response.model!==x.modelId || !Number.isFinite(response.latencyMs) || response.latencyMs<0) {
   this.ledger.markDiscarded(x,'INVALID_RESPONSE');throw new DurableStoreError('MODEL_REVIEW_REQUIRED');
  }
  return {value:response.value,modelCallId:x.modelCallId};
 }
 private matches(r:DurableUsageReceipt|undefined,x:ModelCallIdentity):boolean {return !!r && r.attemptId===x.attemptId && r.providerId===x.providerId && r.modelId===x.modelId && r.source==='TEST_EXPLICIT';}
 private identity(id:string,callId:string):ModelCallIdentity {
  const r=this.ledger.inspect(id,callId)[0];requireIntegrity(r);
  return {workflowRunId:id,modelCallId:callId,attemptId:String(r.attempt_id),providerId:String(r.provider_id),modelId:String(r.model_id)};
 }
 apply<T>(id:string,callId:string,cursor:number,fn:()=>T):RunnerModelApplicationResult<T> {return this.ledger.markApplied(this.identity(id,callId),cursor,fn);}
 discard(id:string,callId:string,reason:RunnerModelDiscardReason):void {this.ledger.markDiscarded(this.identity(id,callId),reason);}
}
