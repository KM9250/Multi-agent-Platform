import type { DurableDatabase, DurableTransaction } from './db';
import type { ContinuationPlanInput, ContinuationPlan, InvocationTiming, ContinuationPolicy, BoundedProvider, ProviderCapabilities } from './continuationTypes';
import { BOUNDED_CONTRACT, DEFAULT_INVOCATION_TIMING } from './continuationTypes';
import { canonicalJson, digest, DurableStoreError, jsonCopy, requireIntegrity } from './integrity';
import { executionJson, rejectEmbeddedCredentials } from './executionIntegrity';
import { readJournal } from './restore';
import { controlledState } from './controlledRecoveryPlanner';
import { readWorkflowControl } from './recoveryHoldLifecycle';
import { modelBudgetPosition, validateQuote } from './modelCallLedger';
import { SqliteCoordinationRunnerStore } from './durableCoordinationStore';
import { effectiveModelRows } from './safeRecoveryModelState';
import { recoveryTime } from './recoveryPlanner';
import { findExhaustedBudget } from '../policy';
import { runnerSecurityReviewReason, runnerEvidenceReviewReason } from '../runner/dispatchGuard';
import type { PlanningReadRegistry } from './planningReadRegistry';
import { readArtifact } from './planningArtifactStore';

export function boundedTiming(input:Partial<InvocationTiming>={}):InvocationTiming {
  requireIntegrity(Object.keys(input).every(k=>k in DEFAULT_INVOCATION_TIMING));
  const timing={...DEFAULT_INVOCATION_TIMING,...input};
  for(const [k,v] of Object.entries(timing))requireIntegrity(Number.isSafeInteger(v)&&v>0&&v<=DEFAULT_INVOCATION_TIMING[k as keyof InvocationTiming]);
  return Object.freeze(timing);
}
export function validateContinuationInput(input:ContinuationPlanInput):ContinuationPlanInput {
  executionJson(input,128*1024);rejectEmbeddedCredentials(input);const x=jsonCopy(input);
  requireIntegrity(Object.keys(x).every(k=>['operation','mode','origin','workflowRunId','requestId','limits','start','taskId','actionId','providerId','modelId','reasoning','input','resources','artifact','previousArtifact','resume'].includes(k)));
  requireIntegrity(['workflowRunId','requestId'].every(k=>typeof x[k as 'workflowRunId']==='string'&&/^[A-Za-z0-9_.:@/-]{1,160}$/.test(x[k as 'workflowRunId'])));
  requireIntegrity(x.origin==='RECOVERY'||x.origin==='USER_REQUEST');
  requireIntegrity(x.limits && Object.keys(x.limits).length===7 && Object.entries(x.limits).every(([k,v])=>['maxRounds','maxModelCalls','maxActionDispatches','maxReadCalls','maxInputTokens','maxOutputTokens','maxCostMicros'].includes(k)&&Number.isSafeInteger(v)&&v>=0));
  if(x.operation==='PLANNING_ONLY') {
    requireIntegrity(['THINK_ONLY','PLAN_READ_ONLY'].includes(x.mode)&&x.limits.maxRounds===0&&x.limits.maxActionDispatches===0
      &&x.limits.maxModelCalls>0&&!x.start&&!x.taskId&&!x.actionId&&!x.artifact);
    if(x.mode==='THINK_ONLY')requireIntegrity(x.limits.maxReadCalls===0&&!(x.resources?.length));
    requireIntegrity(x.input&&typeof x.input.text==='string'&&x.input.text.trim()&&x.input.text.length<=65536
      &&Array.isArray(x.input.snapshots)&&x.input.snapshots.length<=64&&typeof x.input.dataClass==='string'&&typeof x.input.destination==='string');
    for(const s of x.input.snapshots) requireIntegrity(typeof s.id==='string'&&typeof s.revision==='string'&&/^[a-f0-9]{64}$/.test(s.digest)&&Number.isSafeInteger(s.observedAt)&&s.observedAt>=0);
  } else if(x.operation==='BOUNDED_CONTINUATION') {
    requireIntegrity(x.mode==='BOUNDED_EXECUTE'&&x.limits.maxRounds>0&&x.limits.maxReadCalls===0&&['NEW_ROUND','RESUME_PREPARED','VERIFY_FINALIZED_RESULT'].includes(x.start!));
    requireIntegrity(x.origin==='RECOVERY'||!!x.artifact);
    if(x.start==='VERIFY_FINALIZED_RESULT')requireIntegrity(x.limits.maxRounds===1&&x.limits.maxActionDispatches===0&&x.limits.maxModelCalls===1&&x.taskId);
  } else requireIntegrity(x.operation==='RELEASE_RECOVERY_HOLD'&&x.origin==='RECOVERY'&&x.mode===undefined&&Object.values(x.limits).every(v=>v===0)&&!x.providerId&&!x.input);
  requireIntegrity(!x.resources || Array.isArray(x.resources)&&new Set(x.resources).size===x.resources.length&&x.resources.every(r=>typeof r==='string'));
  return x;
}
export function validateProvider(provider:BoundedProvider|undefined,input:ContinuationPlanInput):ProviderCapabilities {
  if(!provider)throw new DurableStoreError('MODEL_ADAPTER_UNSUPPORTED');
  const c=jsonCopy(provider.capabilities);
  requireIntegrity(c.providerId===input.providerId&&c.modelId===input.modelId&&/^[a-f0-9]{64}$/.test(c.implementationDigest)&&c.retry==='disabled'&&c.tools==='disabled'&&c.completeUsage===true);
  const purposes=input.operation==='PLANNING_ONLY'?['DRAFT_PLAN']:input.start==='VERIFY_FINALIZED_RESULT'?['VERIFY']:['PLAN','VERIFY'];
  if(purposes.some(p=>!c.purposes.includes(p as 'PLAN')) || (input.operation==='PLANNING_ONLY'?!provider.draftPlan:!provider.runner))throw new DurableStoreError('MODEL_ADAPTER_UNSUPPORTED');
  requireIntegrity(Object.keys(input.reasoning??{}).every(k=>c.reasoningKeys.includes(k)));
  if(input.input)requireIntegrity(c.dataClasses.includes(input.input.dataClass)&&c.destinations.includes(input.input.destination));
  validateQuote({...c.quote,requestDigest:'0'.repeat(64),maxAttempts:1});return c;
}
export function executionState(tx:DurableTransaction,id:string):string {
  const s=readJournal(tx,id).snapshot;
  return digest({journal:s.events.at(-1),policy:s.policy,usage:s.run.usage,...controlledState(tx,id),
    reads:tx.all('SELECT * FROM planning_read_calls WHERE workflow_run_id=? ORDER BY read_id',id),
    hold:tx.all('SELECT * FROM recovery_hold_transitions WHERE workflow_run_id=? ORDER BY revision',id)});
}
export function assertCleanState(db:DurableDatabase,tx:DurableTransaction,input:ContinuationPlanInput):void {
  const id=input.workflowRunId,s=readJournal(tx,id).snapshot,c=readWorkflowControl(tx,id);
  requireIntegrity(!c.active_invocation_id&&s.run.executionMode==='supervised_autonomous');
  if(input.origin==='USER_REQUEST'&&input.operation==='PLANNING_ONLY')requireIntegrity(s.run.status==='RUNNING'&&c.hold_state!=='HELD');
  else requireIntegrity(s.run.status==='RUNNING'||(['BLOCKED','SUSPENDED'].includes(s.run.status)&&input.resume));
  requireIntegrity(tx.get('SELECT coverage FROM model_call_coverage WHERE workflow_run_id=?',id)?.coverage==='TRACKED_FROM_CREATION'
    &&!effectiveModelRows(tx,id).some(r=>r.unresolved));
  requireIntegrity(!tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND state IN ('DISPATCH_RESERVED','RESULT_RECORDED','REVIEW_REQUIRED')",id));
  requireIntegrity(!tx.get("SELECT read_id FROM planning_read_calls WHERE workflow_run_id=? AND state='INTENT'",id));
  requireIntegrity(!runnerSecurityReviewReason(s)&&!runnerEvidenceReviewReason(s) || !!input.resume);
  const open=Object.values(s.sessions).filter(s=>['OPEN','SUSPENDED'].includes(s.state));
  if(input.operation==='RELEASE_RECOVERY_HOLD'||input.operation==='PLANNING_ONLY'||input.start==='NEW_ROUND') {
    requireIntegrity(open.length===0&&!tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND state='PREPARED'",id));
  } else {
    const task=s.tasks[input.taskId!];requireIntegrity(task&&open.length===1&&open[0].sessionId===task.sessionId&&open[0].state==='OPEN');
    if(input.start==='VERIFY_FINALIZED_RESULT')requireIntegrity(['COMPLETED','FAILED'].includes(task.status)&&tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND task_id=? AND state='FINALIZED'",id,task.taskId));
    else requireIntegrity(task.status==='ASSIGNED'&&tx.get("SELECT action_id FROM execution_ledger WHERE workflow_run_id=? AND task_id=? AND action_id=? AND state='PREPARED'",id,task.taskId,input.actionId!));
  }
  requireIntegrity(Object.values(s.tasks).every(t=>!!tx.get('SELECT task_id FROM execution_ledger WHERE workflow_run_id=? AND task_id=?',id,t.taskId)));
  const budget=modelBudgetPosition(tx,new SqliteCoordinationRunnerStore(db),id);
  requireIntegrity(!findExhaustedBudget(s.run.budget,s.run.usage,Math.max(0,recoveryTime(tx)-s.run.createdAt)));
  requireIntegrity(Object.keys(budget.limit).every(k=>budget.committed[k as keyof typeof budget.limit]+budget.outstanding[k as keyof typeof budget.limit]<=budget.limit[k as keyof typeof budget.limit]));
  if(input.operation==='RELEASE_RECOVERY_HOLD')requireIntegrity(c.hold_state==='HELD'&&!c.planning_review_pending);
  if(c.planning_review_pending)requireIntegrity(!!input.previousArtifact||!!input.artifact);
}
export function planBinding(db:DurableDatabase,tx:DurableTransaction,input:ContinuationPlanInput,policy:ContinuationPolicy,
  provider:BoundedProvider|undefined,reads:PlanningReadRegistry|undefined,timing:InvocationTiming):Record<string,unknown> {
  assertCleanState(db,tx,input);
  const control=readWorkflowControl(tx,input.workflowRunId),lease=tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?',input.workflowRunId)!;
  requireIntegrity(lease&&lease.lease_state==='ACTIVE'&&Number(lease.expires_at)>recoveryTime(tx));
  const resources=(input.resources??[]).map(id=>{const r=reads?.describe(id);requireIntegrity(r&&reads!.contract==='LOCAL_PINNED_READ:1');return r;});
  if(input.artifact){const a=readArtifact(tx,input.artifact);requireIntegrity(a.workflowRunId===input.workflowRunId);
    requireIntegrity(tx.get("SELECT decision FROM planning_reviews WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1",a.artifactId)?.decision==='ACCEPTED_FOR_SCOPE');}
  return {state:executionState(tx,input.workflowRunId),control,lease:{runtimeInstanceId:lease.owner_instance_id,generation:lease.generation},
    policy:{version:policy.version,planningRoles:policy.planningRoles,recoveryApprovals:policy.recoveryApprovals,releaseApprovals:policy.releaseApprovals,storeReasoningSummary:policy.storeReasoningSummary},
    provider:input.operation==='RELEASE_RECOVERY_HOLD'?null:validateProvider(provider,input),resources,readContract:resources.length?reads!.contract:null,timing};
}
export function readContinuationPlan(tx:DurableTransaction,id:string):ContinuationPlan {
  const r=tx.get('SELECT * FROM recovery_continuation_plans WHERE plan_id=?',id);requireIntegrity(r);
  const p=parsePlan(r.plan_json);requireIntegrity(r.plan_digest===p.planDigest&&r.workflow_run_id===p.workflowRunId);return p;
}
function parsePlan(value:unknown):ContinuationPlan {
  requireIntegrity(typeof value==='string');const p=JSON.parse(value) as ContinuationPlan;
  const {planDigest,...body}=p;requireIntegrity(p.contract===BOUNDED_CONTRACT&&digest(body)===planDigest);return p;
}
