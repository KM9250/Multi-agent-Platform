import { randomUUID } from 'node:crypto';
import type { DurableTransaction, Row } from './db';
import type { RunnerModelUsage } from '../runner/types';
import type { ReconciliationOperationContext, ReconciliationOperationCommand, ReconciliationPlan, ReconciliationPlanBinding,
  ReconciliationGrant, ReconciliationGrantScope, ReconciliationOperationReceipt, ReconciliationTarget, ReconciliationVerification,
  CreateReconciliationPlan } from './reconciliationTypes';
import { RECONCILIATION_CONTRACT, RECONCILIATION_OPERATIONS } from './reconciliationTypes';
import { canonicalJson, digest, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { readJournal } from './restore';
import { recoveryTime } from './recoveryPlanner';
import { readWorkflowControl } from './recoveryHoldLifecycle';
import { validateAuditRow } from './recoveryAudit';
import { readReconciliationTarget, reconciliationData } from './reconciliationVerifier';
import { effectiveAccounting, reconciliationStateDigest } from './reconciliationAccounting';
import { addAmounts, costMicros, usageAmounts, zeroAmounts } from './modelBudgetGuard';
import type { ModelAmounts } from './modelBudgetGuard';
import type { ContinuationPlan } from './continuationTypes';
import { validateQuote } from './modelCallLedger';
import type { ModelBudgetQuote } from './modelCallLedger';
import { applyReconciledAction, inspectReconciledActionApplication, normalizeReconciledResult, validateReconciledApplicationHistory } from './reconciliationActions';

const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
export function reconciliationScopeOf(p:ReconciliationPlan):ReconciliationGrantScope {
 return {planId:p.planId,target:p.target,operationKind:p.operationKind,planDigest:p.planDigest,contract:RECONCILIATION_CONTRACT};
}
export const reconciliationOperationId=(p:ReconciliationPlan)=>`reconciliation-${digest([RECONCILIATION_CONTRACT,p.planId,p.planDigest])}`;
export function reconciliationAudit(c:ReconciliationOperationContext,eventKind:string,id:string,hash:string):void {
 c.write('reconciliation_audit',{audit_id:randomUUID(),workflow_run_id:c.lease.workflowRunId,event_kind:eventKind,record_id:id,actor_id:c.actor.actorId,
  record_digest:hash,runtime_instance_id:c.lease.runtimeInstanceId,generation:c.lease.generation,recorded_at:recoveryTime(c.tx)});
}
function checkedAudit(tx:DurableTransaction,kind:string,id:string,hash:string,actor?:string):void {
 const rows=tx.all('SELECT * FROM reconciliation_audit WHERE event_kind=? AND record_id=?',kind,id);
 requireIntegrity(rows.length===1&&rows[0].record_digest===hash&&(!actor||rows[0].actor_id===actor));
}
function targetParams(t:ReconciliationTarget):[string,string,string,string]{return [t.workflowRunId,t.targetKind,t.targetId,t.attemptId];}
function caseRevision(tx:DurableTransaction,t:ReconciliationTarget):number {
 const rows=tx.all('SELECT * FROM reconciliation_cases WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=? ORDER BY revision',...targetParams(t));
 rows.forEach((r,i)=>requireIntegrity(r.revision===i+1));return rows.length;
}
function sourceRows(tx:DurableTransaction,t:ReconciliationTarget) {
 const target=readReconciliationTarget(tx,t);
 return {target,source:t.targetKind==='MODEL'?{model:target.ledger,attempt:target.attempt!}:{ledger:target.ledger,pending:target.registration!}};
}
function policyBinding(c:ReconciliationOperationContext) {
 return {revision:c.policyRevision,version:c.policy.version,authorityDomain:c.policy.authorityDomain,approvals:c.policy.approvals,limits:{planTtlMs:c.limits.planTtlMs,maxPlanTtlMs:c.limits.maxPlanTtlMs}};
}
function expiry(c:ReconciliationOperationContext,now:number,ttl?:number):number {
 const duration=ttl??c.limits.planTtlMs;requireIntegrity(Number.isSafeInteger(duration)&&duration>0&&duration<=c.limits.maxPlanTtlMs);
 const result=now+duration;requireIntegrity(Number.isSafeInteger(result));return result;
}
function assertNoDispute(tx:DurableTransaction,t:ReconciliationTarget):void {
 if(tx.get('SELECT dispute_id FROM reconciliation_disputes WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=?',...targetParams(t)))throw new DurableStoreError('RECOVERY_INVALID_PLAN');
}
export function reconciliationBinding(c:ReconciliationOperationContext,input:CreateReconciliationPlan):ReconciliationPlanBinding {
 const {tx}=c,t=input.target,now=recoveryTime(tx);
 requireIntegrity(RECONCILIATION_OPERATIONS.includes(input.operationKind));
 c.checkAccess(c.actor,t,'CREATE_RECONCILIATION_PLAN');
 const v=c.validateVerification(input.verificationId,t,c.actor),{target,source}=sourceRows(tx,t);
 requireIntegrity(v.status==='VERIFIED'&&v.targetDigest===target.targetDigest);
 assertNoDispute(tx,t);
 const control=readWorkflowControl(tx,t.workflowRunId),snapshot=readJournal(tx,t.workflowRunId).snapshot;
 requireIntegrity(!tx.get("SELECT invocation_id FROM recovery_invocations WHERE workflow_run_id=? AND status IN ('ACTIVE','DRAINING')",t.workflowRunId));
 const lease=tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?',t.workflowRunId);
 requireIntegrity(lease&&lease.owner_instance_id===c.lease.runtimeInstanceId&&lease.generation===c.lease.generation&&lease.lease_state==='ACTIVE'&&Number(lease.expires_at)>now);
 const approvalPolicy=c.policy.approvals[input.operationKind];
 if(!approvalPolicy)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
 requireIntegrity(Number.isSafeInteger(approvalPolicy.minimumApprovers)&&approvalPolicy.minimumApprovers>=1&&approvalPolicy.minimumApprovers<=100&&typeof approvalPolicy.forbidSelfApproval==='boolean');
 let outcomeOperationId:string|null=null;
 if(input.operationKind==='SETTLE_VERIFIED_MODEL_USAGE') {
  requireIntegrity(t.targetKind==='MODEL'&&v.claim.kind==='MODEL_USAGE'&&v.claim.completeness==='COMPLETE'&&v.claim.finality==='FINAL'&&v.claim.usage&&v.claim.currency==='USD');
  requireIntegrity(!tx.get('SELECT authority FROM model_usage_authorities WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?',t.workflowRunId,t.targetId,t.attemptId)
   &&!tx.get('SELECT model_call_id FROM recovery_model_resolutions WHERE workflow_run_id=? AND model_call_id=?',t.workflowRunId,t.targetId));
  requireIntegrity(['DISPATCH_INTENT','REVIEW_REQUIRED'].includes(String(target.ledger.state))&&target.attempt?.dispatch_intent_at!==null);
  const quote=parseJson<ModelBudgetQuote>(target.ledger.quote_json);validateQuote(quote);
  requireIntegrity(v.claim.pricingId===quote.pricingId&&v.claim.usage.llmCalls===1);usageAmounts(v.claim.usage as RunnerModelUsage);
  requireIntegrity(!tx.get('SELECT operation_id FROM reconciled_model_usages WHERE source_effect_key=?',v.sourceEffectKey));
 } else if(input.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME') {
  requireIntegrity(t.targetKind==='ACTION'&&v.claim.kind==='ACTION_OUTCOME'&&['EXECUTED_FINAL','NOT_EXECUTED_FINAL'].includes(v.claim.outcome??'')
   &&v.claim.completeness==='COMPLETE'&&v.claim.finality==='FINAL');
  requireIntegrity(!tx.get('SELECT operation_id FROM reconciled_action_outcomes WHERE workflow_run_id=? AND action_id=?',t.workflowRunId,t.targetId)
   &&!tx.get('SELECT operation_id FROM reconciled_action_outcomes WHERE source_effect_key=?',v.sourceEffectKey));
  if(target.ledger.result_ref) {
   const normal=tx.get('SELECT * FROM execution_results WHERE result_ref=?',target.ledger.result_ref);requireIntegrity(normal);
   const result=parseJson<{status:string;safetyHold?:unknown}>(normal.result_json);
   // A normal final result already owns this effect. Uncertain history can be overlaid.
   requireIntegrity(result.status==='uncertain');
  }
  if(v.claim.result)normalizeReconciledResult(tx,t,'preview',v.claim.result);
 } else {
  requireIntegrity(t.targetKind==='ACTION'&&control.planning_review_pending===0);
  const outcome=tx.get('SELECT * FROM reconciled_action_outcomes WHERE workflow_run_id=? AND action_id=? AND attempt_id=?',t.workflowRunId,t.targetId,t.attemptId);requireIntegrity(outcome);
  requireIntegrity(outcome.verification_id===v.verificationId&&outcome.source_effect_key===v.sourceEffectKey);
  const op=tx.get('SELECT plan_id FROM reconciliation_operations WHERE operation_id=?',outcome.operation_id);requireIntegrity(op);
  const receipt=readReconciliationReceipt(tx,String(op.plan_id));requireIntegrity(receipt&&receipt.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME');
  inspectReconciledActionApplication(tx,t,outcome,now);outcomeOperationId=String(outcome.operation_id);
 }
 const seal=tx.get('SELECT * FROM reconciliation_target_seals WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=?',...targetParams(t));
 if(input.operationKind!=='APPLY_RECONCILED_ACTION_RESULT')requireIntegrity(!seal);
 let originalRuntimeInstanceId=String(target.ledger.runtime_instance_id),originalGeneration=Number(target.ledger.generation);
 if(t.targetKind==='ACTION'){
  const dispatch=tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND attempt_id=? AND event_kind='EXECUTION_CHANGED' AND previous_state='PREPARED' AND next_state='DISPATCH_RESERVED'",t.workflowRunId,t.targetId,t.attemptId);
  requireIntegrity(dispatch.length===1);validateAuditRow(tx,dispatch[0]);originalRuntimeInstanceId=String(dispatch[0].runtime_instance_id);originalGeneration=Number(dispatch[0].runtime_generation);
 }
 requireIntegrity(originalRuntimeInstanceId!=='null'&&originalRuntimeInstanceId!=='undefined'&&Number.isSafeInteger(originalGeneration)&&originalGeneration>=1);
 const rows=(table:string)=>tx.all(`SELECT * FROM ${table} WHERE workflow_run_id=? ORDER BY rowid`,t.workflowRunId);
 return {target:t,operationKind:input.operationKind,verificationId:v.verificationId,verificationDigest:v.receiptDigest,sourceEffectKey:v.sourceEffectKey,claimDigest:v.claimDigest,
  originalDigest:digest(source),originalRuntimeInstanceId,originalGeneration,
  runtimeInstanceId:c.lease.runtimeInstanceId,runtimeGeneration:c.lease.generation,journalCursor:snapshot.events.length,journalEventId:snapshot.events.at(-1)!.eventId,
  holdEpoch:Number(control.hold_epoch),controlRevision:Number(control.control_revision),caseRevision:caseRevision(tx,t),sealRevision:Number(seal?.revision??0),
  effectiveStateDigest:digest({reconciliation:reconciliationStateDigest(tx,t.workflowRunId),actions:rows('execution_ledger'),models:rows('model_call_ledger'),attempts:rows('model_call_attempts'),
   resolutions:rows('recovery_model_resolutions'),coverage:rows('model_call_coverage'),usage:snapshot.run.usage,policy:snapshot.policy}),
  policyDigest:digest(policyBinding(c)),approvalPolicy,outcomeOperationId,
  plannedChanges:input.operationKind==='SETTLE_VERIFIED_MODEL_USAGE'?['COMPLETE_USAGE_AUTHORITY','RESERVATION_RESOLVED']:
   input.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME'?['VERIFIED_EXTERNAL_FACT']:['TASK_RESULT_EVENT'],
  preserved:['ORIGINAL_LEDGER','ORIGINAL_GENERATION','PAST_JOURNAL','SEND_PERMITS','INVOCATION_DEBITS','HOLD','WORKFLOW_STATUS','NO_RESEND','NO_RESUME']};
}
export function readReconciliationPlan(tx:DurableTransaction,id:string):ReconciliationPlan {
 const row=tx.get('SELECT * FROM reconciliation_plans WHERE plan_id=?',id);if(!row)throw new DurableStoreError('RECOVERY_INVALID_PLAN');
 const plan=parseJson<ReconciliationPlan>(row.plan_json),{planDigest,...body}=plan;
 requireIntegrity(plan.contract===RECONCILIATION_CONTRACT&&planDigest===digest(body)&&row.plan_digest===planDigest&&row.plan_id===plan.planId
  &&row.workflow_run_id===plan.target.workflowRunId&&row.target_kind===plan.target.targetKind&&row.target_id===plan.target.targetId&&row.attempt_id===plan.target.attemptId
  &&row.operation_kind===plan.operationKind&&row.created_by===plan.createdBy&&row.created_at===plan.createdAt&&row.expires_at===plan.expiresAt
  &&row.runtime_instance_id===plan.runtimeInstanceId&&row.generation===plan.runtimeGeneration);
 checkedAudit(tx,'RECONCILIATION_PLAN_CREATED',id,plan.planDigest,plan.createdBy);return plan;
}
function assertPlanCurrent(c:ReconciliationOperationContext,p:ReconciliationPlan):void {
 const {planId,contract,createdBy,createdAt,expiresAt,planDigest,...binding}=p;
 if(recoveryTime(c.tx)>=expiresAt||p.runtimeInstanceId!==c.lease.runtimeInstanceId||p.runtimeGeneration!==c.lease.generation)throw new DurableStoreError('RECOVERY_INVALID_PLAN');
 // Authorizers must hold approval/use ACL, not the creator's role. Binding construction
 // uses a creator view only after all ACL checks, with no external work or writes.
 const actor=c.actor;
 const bindingContext={...c,checkAccess:(who:typeof actor,t:ReconciliationTarget,permission:Parameters<typeof c.checkAccess>[2],owner?:string)=>{
  if(permission!=='CREATE_RECONCILIATION_PLAN')c.checkAccess(who,t,permission,owner);
 }};
 if(!same(binding,reconciliationBinding(bindingContext,{target:p.target,operationKind:p.operationKind,verificationId:p.verificationId})))throw new DurableStoreError('RECOVERY_INVALID_PLAN');
}
function grantBase(row:Row) {
 const body=parseJson<Omit<ReconciliationGrant,'status'|'consumedOperationId'|'revokedAt'|'revokedBy'>>(row.grant_json);
 requireIntegrity(row.grant_digest===digest(body)&&row.grant_id===body.grantId&&row.plan_id===body.planId&&row.workflow_run_id===body.target.workflowRunId
  &&row.actor_id===body.approvedBy&&row.expires_at===body.expiresAt);return body;
}
export function readReconciliationGrant(tx:DurableTransaction,id:string):ReconciliationGrant {
 const row=tx.get('SELECT * FROM reconciliation_grants WHERE grant_id=?',id);if(!row)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
 const body=grantBase(row),plan=readReconciliationPlan(tx,body.planId);
 requireIntegrity(same(reconciliationScopeOf(plan),{planId:body.planId,target:body.target,operationKind:body.operationKind,planDigest:body.planDigest,contract:body.contract})
  &&body.expiresAt<=plan.expiresAt&&body.authorizedAt<body.expiresAt);
 checkedAudit(tx,'RECONCILIATION_AUTHORIZED',id,String(row.grant_digest),body.approvedBy);
 if(row.status==='CONSUMED')checkedAudit(tx,'RECONCILIATION_GRANT_CONSUMED',id,String(row.grant_digest));
 if(row.status==='REVOKED')checkedAudit(tx,'RECONCILIATION_REVOKED',id,String(row.grant_digest),String(row.revoked_by));
 return {...body,status:row.status==='AUTHORIZED'&&recoveryTime(tx)>=body.expiresAt?'EXPIRED':row.status as ReconciliationGrant['status'],
  consumedOperationId:row.consumed_operation_id as string|null,revokedAt:row.revoked_at as number|null,revokedBy:row.revoked_by as string|null};
}
function effectRow(tx:DurableTransaction,p:ReconciliationPlan,operationId:string):Row {
 const table=p.operationKind==='SETTLE_VERIFIED_MODEL_USAGE'?'reconciled_model_usages':p.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME'?'reconciled_action_outcomes':'reconciled_action_applications';
 const row=tx.get(`SELECT * FROM ${table} WHERE operation_id=?`,operationId);requireIntegrity(row&&row.workflow_run_id===p.target.workflowRunId&&row.attempt_id===p.target.attemptId
  &&row[p.target.targetKind==='MODEL'?'model_call_id':'action_id']===p.target.targetId);return row;
}
/** Historical receipt verification deliberately never requires the current lease,
 * current journal tip or an unexpired old verification. */
export function readReconciliationReceipt(tx:DurableTransaction,planId:string):ReconciliationOperationReceipt|undefined {
 const p=readReconciliationPlan(tx,planId),row=tx.get('SELECT * FROM reconciliation_operations WHERE plan_id=?',planId);if(!row)return;
 const r=parseJson<ReconciliationOperationReceipt>(row.receipt_json),operationId=reconciliationOperationId(p),effect=effectRow(tx,p,operationId);
 requireIntegrity(row.workflow_run_id===p.target.workflowRunId&&row.target_kind===p.target.targetKind&&row.target_id===p.target.targetId&&row.attempt_id===p.target.attemptId&&row.operation_kind===p.operationKind
  &&row.receipt_digest===digest(r)&&row.operation_id===operationId&&r.operationId===operationId&&r.planId===p.planId&&r.planDigest===p.planDigest
  &&r.contract===RECONCILIATION_CONTRACT&&r.status==='COMMITTED'&&same(r.target,p.target)&&r.operationKind===p.operationKind
  &&r.verificationId===p.verificationId&&r.verificationDigest===p.verificationDigest&&r.sourceEffectKey===p.sourceEffectKey&&r.claimDigest===p.claimDigest
  &&r.actorId===p.createdBy&&r.runtimeInstanceId===p.runtimeInstanceId&&r.runtimeGeneration===p.runtimeGeneration
  &&r.beforeJournalCursor===p.journalCursor&&r.originalDigest===p.originalDigest&&r.effectDigest===digest(effect)
  &&r.previousControlRevision===p.controlRevision&&r.controlRevision===p.controlRevision+1&&r.caseRevision===p.caseRevision+1
  &&r.committedAt===row.created_at&&p.createdAt<=r.committedAt&&r.committedAt<p.expiresAt);
 const verification=tx.get('SELECT * FROM reconciliation_verifications WHERE verification_id=?',p.verificationId);requireIntegrity(verification&&verification.digest===p.verificationDigest&&verification.workflow_run_id===p.target.workflowRunId);
 const v=parseJson<ReconciliationVerification>(verification.receipt_json),{receiptDigest,...vb}=v;
 requireIntegrity(receiptDigest===digest(vb)&&receiptDigest===p.verificationDigest&&r.committedAt<v.expiresAt&&v.status==='VERIFIED'&&same(v.target,p.target)&&v.sourceEffectKey===p.sourceEffectKey&&v.claimDigest===p.claimDigest&&v.claimDigest===digest(v.claim));
 const links=tx.all('SELECT * FROM reconciliation_operation_grants WHERE operation_id=? ORDER BY grant_id',operationId);
 requireIntegrity(same(links.map(x=>x.grant_id),r.grantIds)&&links.length>=p.approvalPolicy.minimumApprovers);
 const actors=new Set<string>();
 for(const link of links){const g=readReconciliationGrant(tx,String(link.grant_id));requireIntegrity(g.status==='CONSUMED'&&g.consumedOperationId===operationId&&g.planId===p.planId
   &&g.authorizedAt<=r.committedAt&&r.committedAt<g.expiresAt&&(!p.approvalPolicy.forbidSelfApproval||g.approvedBy!==p.createdBy)&&!actors.has(g.approvedBy));actors.add(g.approvedBy);}
 const snapshot=readJournal(tx,p.target.workflowRunId).snapshot,events=snapshot.events.slice(r.beforeJournalCursor,r.afterJournalCursor);
 requireIntegrity(r.afterJournalCursor>=r.beforeJournalCursor&&r.afterJournalCursor<=snapshot.events.length&&same(r.journalEventIds,events.map(e=>e.eventId))&&r.journalDigest===digest(events));
 if(p.operationKind==='APPLY_RECONCILED_ACTION_RESULT'){requireIntegrity(events.length===1&&effect.outcome_operation_id===p.outcomeOperationId);validateReconciledApplicationHistory(tx,effect,events);}
 else {
  requireIntegrity(events.length===0&&effect.source_digest===p.originalDigest&&digest(parseJson(effect.source_json))===p.originalDigest&&effect.verification_id===p.verificationId&&effect.source_effect_key===p.sourceEffectKey);
  const seal=tx.get('SELECT * FROM reconciliation_target_seals WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=?',...targetParams(p.target));requireIntegrity(seal&&seal.operation_id===operationId);
  if(p.operationKind==='SETTLE_VERIFIED_MODEL_USAGE') {
   const authority=tx.get('SELECT * FROM model_usage_authorities WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?',p.target.workflowRunId,p.target.targetId,p.target.attemptId);
   requireIntegrity(authority&&authority.authority==='RECONCILED'&&authority.operation_id===operationId&&authority.usage_json===effect.usage_json&&authority.usage_digest===effect.usage_digest&&authority.cost_micros===effect.cost_micros);
  }
 }
 const lifecycle=tx.get('SELECT * FROM recovery_hold_lifecycle WHERE workflow_run_id=? AND control_revision=?',p.target.workflowRunId,r.controlRevision);
 const previousControl=tx.get('SELECT * FROM recovery_hold_lifecycle WHERE workflow_run_id=? AND control_revision=?',p.target.workflowRunId,r.previousControlRevision);
 requireIntegrity(lifecycle&&previousControl&&['hold_state','hold_epoch','active_invocation_id','planning_review_pending'].every(k=>lifecycle[k]===previousControl[k]));
 const caseRow=tx.get('SELECT * FROM reconciliation_cases WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=? AND revision=?',...targetParams(p.target),r.caseRevision);
 requireIntegrity(lifecycle&&lifecycle.reason==='RECONCILIATION_COMMITTED'&&lifecycle.generation===r.runtimeGeneration&&caseRow&&parseJson<{operationId:string}>(caseRow.case_json).operationId===operationId);
 checkedAudit(tx,'RECONCILIATION_OPERATION_COMMITTED',operationId,String(row.receipt_digest),r.actorId);
 checkedAudit(tx,p.operationKind==='SETTLE_VERIFIED_MODEL_USAGE'?'RECONCILIATION_MODEL_USAGE_SETTLED':p.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME'?'RECONCILIATION_ACTION_OUTCOME_RECORDED':'RECONCILIATION_ACTION_RESULT_APPLIED',operationId,r.effectDigest,r.actorId);
 return r;
}
function settlementBudgetViolation(tx:DurableTransaction,t:ReconciliationTarget,model:Row,amounts:ModelAmounts):boolean {
 const snapshot=readJournal(tx,t.workflowRunId).snapshot,b=snapshot.run.budget;
 const total=addAmounts(effectiveAccounting(tx,t.workflowRunId,snapshot).committed,amounts);
 let violation=amounts.inputTokens>Number(model.reserved_input)||amounts.outputTokens>Number(model.reserved_output)||amounts.costMicros>Number(model.reserved_cost)
  ||total.llmCalls>b.maxLlmCalls||total.inputTokens>b.maxInputTokens||total.outputTokens>b.maxOutputTokens||total.costMicros>costMicros(b.maxEstimatedCost,'floor');
 const debit=tx.get("SELECT * FROM recovery_invocation_debits WHERE workflow_run_id=? AND kind='MODEL' AND target_id=?",t.workflowRunId,t.targetId);
 if(debit) {
  const invocation=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=? AND workflow_run_id=?',debit.invocation_id,t.workflowRunId);requireIntegrity(invocation);
  const saved=tx.get('SELECT plan_json FROM recovery_continuation_plans WHERE plan_id=? AND workflow_run_id=?',invocation.plan_id,t.workflowRunId);requireIntegrity(saved);
  const plan=parseJson<ContinuationPlan>(saved.plan_json);let committed=zeroAmounts();
  for(const row of tx.all("SELECT a.usage_json FROM recovery_invocation_debits d JOIN model_usage_authorities a ON a.workflow_run_id=d.workflow_run_id AND a.model_call_id=d.target_id WHERE d.workflow_run_id=? AND d.invocation_id=? AND d.kind='MODEL'",t.workflowRunId,debit.invocation_id))committed=addAmounts(committed,usageAmounts(parseJson<RunnerModelUsage>(row.usage_json)));
  committed=addAmounts(committed,amounts);
  violation=violation||committed.llmCalls>plan.limits.maxModelCalls||committed.inputTokens>plan.limits.maxInputTokens||committed.outputTokens>plan.limits.maxOutputTokens||committed.costMicros>plan.limits.maxCostMicros;
 }
 return violation;
}
function appendControl(c:ReconciliationOperationContext,t:ReconciliationTarget,reason:string,hold=false):number {
 const control=readWorkflowControl(c.tx,t.workflowRunId),revision=Number(control.control_revision)+1;
 c.write('recovery_hold_lifecycle',{lifecycle_id:null,workflow_run_id:t.workflowRunId,hold_epoch:Number(control.hold_epoch)+(hold&&control.hold_state!=='HELD'?1:0),control_revision:revision,
  hold_state:hold?'HELD':control.hold_state,active_invocation_id:control.active_invocation_id,planning_review_pending:control.planning_review_pending,reason,generation:c.lease.generation,recorded_at:recoveryTime(c.tx)});
 return revision;
}
function appendCase(c:ReconciliationOperationContext,t:ReconciliationTarget,body:unknown):number {
 const revision=caseRevision(c.tx,t)+1;c.write('reconciliation_cases',{workflow_run_id:t.workflowRunId,target_kind:t.targetKind,target_id:t.targetId,attempt_id:t.attemptId,
  revision,case_json:canonicalJson(body),created_at:recoveryTime(c.tx)});return revision;
}
export function persistReconciliationDecision(c:ReconciliationOperationContext,raw:ReconciliationOperationCommand):unknown {
 const command=reconciliationData(raw,c.limits.maxReceiptBytes,c.limits.maxDepth),{tx}=c,now=recoveryTime(tx);
 const keys:Record<string,string[]>={PREVIEW:['kind','target'],INSPECT:['kind','target'],CREATE_PLAN:['kind','input'],AUTHORIZE:['kind','planId','scope','ttlMs'],REVOKE:['kind','grantId'],EXECUTE:['kind','planId'],RECEIPT:['kind','planId']};
 requireIntegrity(keys[command.kind]&&Object.keys(command).every(k=>keys[command.kind].includes(k)));
 if(command.kind==='INSPECT')throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
 if(command.kind==='PREVIEW') {
  c.checkAccess(c.actor,command.target,'VIEW_CASE');const t=readReconciliationTarget(tx,command.target);
  return {target:command.target,historical:t.targetSnapshot,executionAllowed:false};
 }
 if(command.kind==='CREATE_PLAN') {
  const input=command.input;requireIntegrity(Object.keys(input).every(k=>['target','operationKind','verificationId','ttlMs'].includes(k)));
  const binding=reconciliationBinding(c,input),body={...binding,planId:randomUUID(),contract:RECONCILIATION_CONTRACT,createdBy:c.actor.actorId,createdAt:now,expiresAt:Math.min(expiry(c,now,input.ttlMs),c.actor.expiresAt)};
  const plan:ReconciliationPlan={...body,planDigest:digest(body)};
  reconciliationData(plan,c.limits.maxReceiptBytes,c.limits.maxDepth);
  c.write('reconciliation_plans',{plan_id:plan.planId,workflow_run_id:plan.target.workflowRunId,target_kind:plan.target.targetKind,target_id:plan.target.targetId,attempt_id:plan.target.attemptId,
   operation_kind:plan.operationKind,plan_digest:plan.planDigest,plan_json:canonicalJson(plan),created_by:plan.createdBy,created_at:now,expires_at:plan.expiresAt,runtime_instance_id:plan.runtimeInstanceId,generation:plan.runtimeGeneration});
  reconciliationAudit(c,'RECONCILIATION_PLAN_CREATED',plan.planId,plan.planDigest);return readReconciliationPlan(tx,plan.planId);
 }
 if(command.kind==='REVOKE') {
  const g=readReconciliationGrant(tx,command.grantId);c.checkAccess(c.actor,g.target,'REVOKE_GRANT');
  requireIntegrity(g.status==='AUTHORIZED'||g.status==='EXPIRED');const old=tx.get('SELECT * FROM reconciliation_grants WHERE grant_id=?',g.grantId)!;
  c.write('reconciliation_grants',{...old,status:'REVOKED',revoked_at:now,revoked_by:c.actor.actorId},old);
  reconciliationAudit(c,'RECONCILIATION_REVOKED',g.grantId,String(old.grant_digest));return readReconciliationGrant(tx,g.grantId);
 }
 const p=readReconciliationPlan(tx,command.planId);
 if(command.kind==='RECEIPT'){c.checkAccess(c.actor,p.target,'VIEW_CASE');return readReconciliationReceipt(tx,p.planId);}
 if(command.kind==='EXECUTE') {
  // This check is before receipt lookup, current verification, grant inspection and any write.
  if(c.actor.actorId!==p.createdBy)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  c.checkAccess(c.actor,p.target,'APPLY_RECONCILIATION');c.checkAccess(c.actor,p.target,'VIEW_CASE');
  const existing=readReconciliationReceipt(tx,p.planId);if(existing)return existing;
 } else c.checkAccess(c.actor,p.target,'APPROVE_RECONCILIATION');
 assertPlanCurrent(c,p);
 if(command.kind==='AUTHORIZE') {
  requireIntegrity(same(command.scope,reconciliationScopeOf(p))&&(!p.approvalPolicy.forbidSelfApproval||c.actor.actorId!==p.createdBy));
  const existing=tx.get('SELECT grant_id FROM reconciliation_grants WHERE plan_id=? AND actor_id=?',p.planId,c.actor.actorId);
  if(existing){const g=readReconciliationGrant(tx,String(existing.grant_id));requireIntegrity(g.status==='AUTHORIZED');return g;}
  const body={...reconciliationScopeOf(p),grantId:randomUUID(),approvedBy:c.actor.actorId,authorizationSource:c.actor.source,authorizedAt:now,expiresAt:Math.min(p.expiresAt,c.actor.expiresAt,expiry(c,now,command.ttlMs))};
  c.write('reconciliation_grants',{grant_id:body.grantId,plan_id:p.planId,workflow_run_id:p.target.workflowRunId,actor_id:body.approvedBy,status:'AUTHORIZED',grant_json:canonicalJson(body),grant_digest:digest(body),
   expires_at:body.expiresAt,consumed_operation_id:null,revoked_at:null,revoked_by:null});
  reconciliationAudit(c,'RECONCILIATION_AUTHORIZED',body.grantId,digest(body));return readReconciliationGrant(tx,body.grantId);
 }
 requireIntegrity(command.kind==='EXECUTE');
 const grants=tx.all('SELECT grant_id FROM reconciliation_grants WHERE plan_id=? ORDER BY grant_id',p.planId).map(r=>readReconciliationGrant(tx,String(r.grant_id))).filter(g=>g.status==='AUTHORIZED');
 requireIntegrity(grants.length>=p.approvalPolicy.minimumApprovers&&new Set(grants.map(g=>g.approvedBy)).size===grants.length);
 const approvalExpiries:number[]=[];
 for(const grant of grants){
  requireIntegrity(!p.approvalPolicy.forbidSelfApproval||grant.approvedBy!==p.createdBy);
  const approver=c.revalidateApproval(grant.approvedBy,grant.authorizationSource,p.target);
  c.validateVerification(p.verificationId,p.target,approver);approvalExpiries.push(approver.expiresAt);
 }
 const v=c.validateVerification(p.verificationId,p.target,c.actor),operationId=reconciliationOperationId(p),{source,target}=sourceRows(tx,p.target);
 let effect:Row;
 if(p.operationKind==='SETTLE_VERIFIED_MODEL_USAGE') {
  const usage=v.claim.usage as RunnerModelUsage,amounts=usageAmounts(usage),model=target.ledger;
  const response=model.application_status==='APPLIED'?'APPLIED':model.application_status==='DISCARDED'?'DISCARDED':v.claim.responseState??'UNAVAILABLE_REVIEW_REQUIRED';
  const violation=settlementBudgetViolation(tx,p.target,model,amounts);
  effect={operation_id:operationId,workflow_run_id:p.target.workflowRunId,model_call_id:p.target.targetId,attempt_id:p.target.attemptId,verification_id:v.verificationId,source_effect_key:v.sourceEffectKey,
   usage_json:canonicalJson(usage),usage_digest:digest(usage),llm_calls:1,input_tokens:amounts.inputTokens,output_tokens:amounts.outputTokens,cost_micros:amounts.costMicros,response_status:response,budget_violation:violation?1:0,
   source_json:canonicalJson(source),source_digest:digest(source),created_at:now};
  c.write('reconciled_model_usages',effect);
  c.write('model_usage_authorities',{workflow_run_id:p.target.workflowRunId,model_call_id:p.target.targetId,attempt_id:p.target.attemptId,authority:'RECONCILED',usage_event_id:null,operation_id:operationId,
   usage_json:effect.usage_json,usage_digest:effect.usage_digest,cost_micros:effect.cost_micros,created_at:now});
 } else if(p.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME') {
  const result=v.claim.result?normalizeReconciledResult(tx,p.target,operationId,v.claim.result):undefined;
  effect={operation_id:operationId,workflow_run_id:p.target.workflowRunId,action_id:p.target.targetId,attempt_id:p.target.attemptId,verification_id:v.verificationId,source_effect_key:v.sourceEffectKey,
   outcome_kind:v.claim.outcome!,source_json:canonicalJson(source),source_digest:digest(source),result_json:result?canonicalJson(result):null,created_at:now};c.write('reconciled_action_outcomes',effect);
 } else {
  const outcome=tx.get('SELECT * FROM reconciled_action_outcomes WHERE operation_id=?',p.outcomeOperationId!);requireIntegrity(outcome);
  effect=applyReconciledAction(c,p.target,outcome,operationId,now);
 }
 if(p.operationKind!=='APPLY_RECONCILED_ACTION_RESULT')c.write('reconciliation_target_seals',{workflow_run_id:p.target.workflowRunId,target_kind:p.target.targetKind,target_id:p.target.targetId,attempt_id:p.target.attemptId,operation_id:operationId,revision:1,created_at:now});
 // No callback occurs after applying rows. Expiry is rechecked before committing any part.
 requireIntegrity(recoveryTime(tx)<Math.min(p.expiresAt,c.actor.expiresAt,v.expiresAt,...grants.map(g=>g.expiresAt),...approvalExpiries));
 for(const g of grants){const old=tx.get('SELECT * FROM reconciliation_grants WHERE grant_id=?',g.grantId)!;c.write('reconciliation_grants',{...old,status:'CONSUMED',consumed_operation_id:operationId},old);reconciliationAudit(c,'RECONCILIATION_GRANT_CONSUMED',g.grantId,String(old.grant_digest));}
 const controlRevision=appendControl(c,p.target,'RECONCILIATION_COMMITTED'),nextCase=appendCase(c,p.target,{operationId,verificationId:v.verificationId,operationKind:p.operationKind});
 const after=readJournal(tx,p.target.workflowRunId).snapshot,events=after.events.slice(p.journalCursor);
 const receipt:ReconciliationOperationReceipt={operationId,planId:p.planId,contract:RECONCILIATION_CONTRACT,target:p.target,operationKind:p.operationKind,planDigest:p.planDigest,
  verificationId:v.verificationId,verificationDigest:v.receiptDigest,sourceEffectKey:v.sourceEffectKey,claimDigest:v.claimDigest,actorId:c.actor.actorId,runtimeInstanceId:c.lease.runtimeInstanceId,runtimeGeneration:c.lease.generation,
  committedAt:now,status:'COMMITTED',grantIds:grants.map(g=>g.grantId),beforeJournalCursor:p.journalCursor,afterJournalCursor:after.events.length,journalEventIds:events.map(e=>e.eventId),journalDigest:digest(events),
  originalDigest:p.originalDigest,effectDigest:digest(effect),previousControlRevision:p.controlRevision,controlRevision,caseRevision:nextCase};
 c.write('reconciliation_operations',{operation_id:operationId,plan_id:p.planId,workflow_run_id:p.target.workflowRunId,target_kind:p.target.targetKind,target_id:p.target.targetId,attempt_id:p.target.attemptId,
  operation_kind:p.operationKind,receipt_json:canonicalJson(receipt),receipt_digest:digest(receipt),created_at:now});
 for(const g of grants)c.write('reconciliation_operation_grants',{operation_id:operationId,grant_id:g.grantId,plan_id:p.planId,workflow_run_id:p.target.workflowRunId});
 reconciliationAudit(c,p.operationKind==='SETTLE_VERIFIED_MODEL_USAGE'?'RECONCILIATION_MODEL_USAGE_SETTLED':p.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME'?'RECONCILIATION_ACTION_OUTCOME_RECORDED':'RECONCILIATION_ACTION_RESULT_APPLIED',operationId,receipt.effectDigest);
 reconciliationAudit(c,'RECONCILIATION_OPERATION_COMMITTED',operationId,digest(receipt));return readReconciliationReceipt(tx,p.planId);
}

/** Trusted conflicts only tighten safety. This participant never frees budgets,
 * applies results, consumes grants or dispatches business work. */
export function recordVerifiedConflict(c:ReconciliationOperationContext,v:ReconciliationVerification):string[] {
 if(v.status!=='VERIFIED'||v.claim.completeness!=='COMPLETE'||v.claim.finality!=='FINAL')return [];
 const {tx}=c,t=v.target;
 const previous=tx.all("SELECT * FROM reconciliation_verifications WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=? AND status='VERIFIED' AND verification_id<>?",...targetParams(t),v.verificationId)
  .map(r=>parseJson<ReconciliationVerification>(r.receipt_json)).filter(p=>p.claim.completeness==='COMPLETE'&&p.claim.finality==='FINAL');
 const fact=(x:ReconciliationVerification)=>x.claim.kind==='MODEL_USAGE'?x.claim.usage:x.claim.outcome;
 const conflict=previous.find(p=>!same(fact(p),fact(v)));
 let normalConflict=false;
 if(t.targetKind==='MODEL') {
  const authority=tx.get('SELECT * FROM model_usage_authorities WHERE workflow_run_id=? AND model_call_id=? AND attempt_id=?',t.workflowRunId,t.targetId,t.attemptId);
  normalConflict=!!authority&&!same(parseJson(authority.usage_json),v.claim.usage);
 } else {
  const ledger=tx.get('SELECT result_ref FROM execution_ledger WHERE workflow_run_id=? AND action_id=?',t.workflowRunId,t.targetId);
  const result=ledger?.result_ref?tx.get('SELECT result_json FROM execution_results WHERE result_ref=?',ledger.result_ref):undefined;
  if(result){const status=parseJson<{status:string}>(result.result_json).status;normalConflict=status==='succeeded'&&v.claim.outcome==='NOT_EXECUTED_FINAL'||status==='failed'&&v.claim.outcome==='EXECUTED_FINAL';}
 }
 if(!conflict&&!normalConflict)return [];
 return appendVerifiedDispute(c,v,conflict?.verificationId??null,normalConflict?'NORMAL_FACT_CONFLICT':'VERIFIED_FACT_CONFLICT');
}
/** The runtime first proves an explicit registry trust loss; a clock expiry alone
 * cannot enter this path or remove previously booked usage. */
export function recordVerificationRevocation(c:ReconciliationOperationContext,v:ReconciliationVerification):string[] {
 requireIntegrity(v.status==='VERIFIED');
 if(c.tx.get("SELECT dispute_id FROM reconciliation_disputes WHERE verification_id=? AND reason_code='TRUST_REVOKED'",v.verificationId))return [];
 return appendVerifiedDispute(c,v,null,'TRUST_REVOKED');
}
function appendVerifiedDispute(c:ReconciliationOperationContext,v:ReconciliationVerification,priorVerificationId:string|null,reasonCode:string):string[] {
 const {tx}=c,t=v.target;
 const dispute:Row={dispute_id:randomUUID(),workflow_run_id:t.workflowRunId,target_kind:t.targetKind,target_id:t.targetId,attempt_id:t.attemptId,
  verification_id:v.verificationId,prior_verification_id:priorVerificationId,reason_code:reasonCode,created_at:recoveryTime(tx)};
 c.write('reconciliation_disputes',dispute);
 appendCase(c,t,{disputeId:dispute.dispute_id,verificationId:v.verificationId,reasonCode:dispute.reason_code});
 const draining:string[]=[];
 for(const invocation of tx.all("SELECT * FROM recovery_invocations WHERE workflow_run_id=? AND status='ACTIVE'",t.workflowRunId)) {
  c.write('recovery_invocations',{...invocation,status:'DRAINING',outcome:'USER_STOP',revision:Number(invocation.revision)+1},invocation);draining.push(String(invocation.invocation_id));
 }
 appendControl(c,t,'RECONCILIATION_DISPUTE',true);
 reconciliationAudit(c,'RECONCILIATION_DISPUTE_RECORDED',String(dispute.dispute_id),digest(dispute));return draining;
}
