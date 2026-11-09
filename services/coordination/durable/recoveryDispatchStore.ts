import { randomUUID } from 'node:crypto';
import type { DurableDatabase, DurableTransaction, Row } from './db';
import type { WorkflowLease } from './runtimeLease';
import type { VerifiedRecoveryIdentity } from './recoveryDecisionTypes';
import type { ControlledCommand, ControlledExecutorRegistry, ControlledGrant, ControlledGrantScope, ControlledPlan, ControlledTiming, DispatchIntent, DispatchReceipt } from './controlledRecoveryTypes';
import { CONTROLLED_LIMITS, CONTROLLED_OPERATION, CONTROLLED_RECOVERY_CONTRACT } from './controlledRecoveryTypes';
import { CONTROLLED_COLUMNS } from './controlledRecoverySchema';
import { assertControlledPlanCurrent, controlledBinding, controlledTiming, dispatchPostState } from './controlledRecoveryPlanner';
import { canonicalJson, digest, DurableStoreError, jsonCopy, parseJson, requireIntegrity } from './integrity';
import { recoveryExpiry, recoveryTime } from './recoveryPlanner';
import { readPendingActionInTransaction, validateActionOwner } from './pendingActionStore';
import { readJournal } from './restore';
import { readExecution, reserveExecutionInTransaction } from './executionLedger';
import { executionJson, EXECUTION_LIMITS, rejectEmbeddedCredentials } from './executionIntegrity';
import { executionOwner, validateExecutionEvidence } from './executionReader';
import { readOwnedEvidenceInTransaction } from './evidenceStore';
import type { RunnerEvidence, RunnerExecutionResult } from '../runner/types';

/** A participant receives this closure only from the closed Database dispatcher.
 * Importing/calling this module with a substitute closure cannot install SQL authority. */
export type ControlledWriter = (table: string, row: Row, old?: Row) => void;
export function controlledVector(table: string, row?: Row): string | null {
  return row ? canonicalJson(CONTROLLED_COLUMNS[table].map(k => row[k] ?? null)) : null;
}
export function controlledWrite(tx: DurableTransaction, install: ControlledWriter, table: string, row: Row, old?: Row): void {
  install(table,jsonCopy(row),old && jsonCopy(old));
  const keys = CONTROLLED_COLUMNS[table]; requireIntegrity(keys && keys.every(k => Object.hasOwn(row,k)));
  if (old) tx.run(`UPDATE ${table} SET ${keys.map(k=>`${k}=?`).join(',')} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')}`,
    ...keys.map(k=>row[k]),...keys.map(k=>old[k]));
  else tx.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,...keys.map(k=>row[k]));
}
export const controlledScopeOf = (p: ControlledGrantScope): ControlledGrantScope => ({ workflowRunId:p.workflowRunId,actionId:p.actionId,
  planDigest:p.planDigest,operationKind:p.operationKind,operationContractVersion:p.operationContractVersion });
export function readControlledPlan(tx: DurableTransaction, planId: string): ControlledPlan {
  const r=tx.get('SELECT * FROM recovery_controlled_plans WHERE plan_id=?',planId);
  if (!r) throw new DurableStoreError('RECOVERY_INVALID_PLAN');
  const plan=parseJson<ControlledPlan>(r.plan_json),{planDigest,...body}=plan;
  requireIntegrity(planDigest===digest(body) && r.plan_digest===planDigest && r.plan_id===plan.planId
    && r.workflow_run_id===plan.workflowRunId && r.action_id===plan.actionId && r.runtime_instance_id===plan.runtimeInstanceId
    && r.runtime_generation===plan.runtimeGeneration && r.contract_version===CONTROLLED_RECOVERY_CONTRACT
    && plan.operationContractVersion===CONTROLLED_RECOVERY_CONTRACT && r.operation_kind===CONTROLLED_OPERATION
    && plan.operationKind===CONTROLLED_OPERATION && plan.maxActionDispatches===1 && plan.maxModelCalls===0 && plan.maxRounds===0
    && Number.isSafeInteger(plan.createdAt) && plan.sendDeadline===plan.createdAt+plan.timing.sendTtlMs
    && Number.isSafeInteger(plan.approvalPolicy.minimumApprovers) && plan.approvalPolicy.minimumApprovers>=1
    && plan.approvalPolicy.minimumApprovers<=100 && typeof plan.approvalPolicy.forbidSelfApproval==='boolean');
  controlledTiming(plan.timing);
  const audits=tx.all("SELECT * FROM runtime_audit_events WHERE controlled_plan_id=? AND event_kind='RECOVERY_CONTROLLED_PLAN_CREATED'",planId);
  requireIntegrity(audits.length===1 && audits[0].recovery_record_digest===planDigest && audits[0].recovery_actor_id===plan.createdByActorId
    && audits[0].runtime_instance_id===plan.runtimeInstanceId && audits[0].runtime_generation===plan.runtimeGeneration);
  return plan;
}
export function readControlledGrant(tx: DurableTransaction, id: string): ControlledGrant {
  const r=tx.get('SELECT * FROM recovery_controlled_grants WHERE authorization_id=?',id);
  if (!r) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const body=parseJson<Omit<ControlledGrant,'status'|'consumedOperationId'|'revokedAt'|'revokedByActorId'>>(r.grant_json);
  const plan=readControlledPlan(tx,String(r.plan_id));
  requireIntegrity(r.grant_digest===digest(body) && body.authorizationId===id && body.planId===plan.planId
    && r.workflow_run_id===body.workflowRunId && r.action_id===body.actionId && r.authorized_actor_id===body.authorizedActorId
    && r.expires_at===body.expiresAt && canonicalJson(controlledScopeOf(body))===canonicalJson(controlledScopeOf(plan))
    && body.runtimeInstanceId===plan.runtimeInstanceId && body.runtimeGeneration===plan.runtimeGeneration
    && ['RECOVERY_APPROVER','RECOVERY_ADMIN'].includes(body.authorizerRole)
    && Number.isSafeInteger(body.authorizedAt) && body.authorizedAt>=plan.createdAt && body.expiresAt>body.authorizedAt && body.expiresAt<=plan.sendDeadline
    && (!plan.approvalPolicy.forbidSelfApproval || body.authorizedActorId!==plan.createdByActorId)
    && ['AUTHORIZED','CONSUMED','REVOKED'].includes(String(r.status)));
  const a=tx.all('SELECT * FROM runtime_audit_events WHERE controlled_grant_id=? ORDER BY audit_sequence',id);
  requireIntegrity(a.length===(r.status==='AUTHORIZED'?1:2) && a[0].event_kind==='RECOVERY_CONTROLLED_AUTHORIZED'
    && a[0].recovery_actor_id===body.authorizedActorId && a.every(x=>x.recovery_record_digest===r.grant_digest && x.controlled_plan_id===body.planId));
  if (r.status==='CONSUMED') requireIntegrity(a[1].event_kind==='RECOVERY_CONTROLLED_GRANT_CONSUMED' && a[1].dispatch_operation_id===r.consumed_operation_id);
  if (r.status==='REVOKED') requireIntegrity(a[1].event_kind==='RECOVERY_CONTROLLED_REVOKED' && a[1].recovery_actor_id===r.revoked_actor_id);
  return {...body,status:r.status==='AUTHORIZED' && body.expiresAt<=recoveryTime(tx)?'EXPIRED':r.status as ControlledGrant['status'],
    consumedOperationId:r.consumed_operation_id as string|null,revokedAt:r.revoked_at as number|null,revokedByActorId:r.revoked_actor_id as string|null};
}
export function persistControlledDecision(db: DurableDatabase, tx: DurableTransaction, command: Exclude<ControlledCommand,{kind:'INSPECT'}>,
  identity: VerifiedRecoveryIdentity, lease: WorkflowLease, registry: ControlledExecutorRegistry|undefined, timing: ControlledTiming, install: ControlledWriter) {
  const write=(table:string,row:Row,old?:Row)=>controlledWrite(tx,install,table,row,old),now=recoveryTime(tx);
  if (command.kind==='CREATE_PLAN') {
    const {binding}=controlledBinding(db,tx,command.input,registry,timing);
    const body={...binding,planId:randomUUID(),createdByActorId:identity.actorId,createdAt:now,sendDeadline:now+timing.sendTtlMs};
    const plan:ControlledPlan={...body,planDigest:digest(body)};
    write('recovery_controlled_plans',{plan_id:plan.planId,workflow_run_id:plan.workflowRunId,action_id:plan.actionId,plan_json:canonicalJson(plan),plan_digest:plan.planDigest,
      runtime_instance_id:plan.runtimeInstanceId,runtime_generation:plan.runtimeGeneration,contract_version:CONTROLLED_RECOVERY_CONTRACT,operation_kind:CONTROLLED_OPERATION});
    return readControlledPlan(tx,plan.planId);
  }
  if (command.kind==='REVOKE') {
    const g=readControlledGrant(tx,command.authorizationId);
    if (g.status==='CONSUMED' || g.authorizedActorId!==identity.actorId && !identity.roles.includes('RECOVERY_ADMIN')) throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
    if(g.status==='REVOKED')return g;
    const old=tx.get('SELECT * FROM recovery_controlled_grants WHERE authorization_id=?',g.authorizationId)!;
    write('recovery_controlled_grants',{...old,status:'REVOKED',revoked_at:now,revoked_actor_id:identity.actorId},old);
    return readControlledGrant(tx,g.authorizationId);
  }
  const plan=readControlledPlan(tx,command.planId);
  if(plan.runtimeInstanceId!==lease.runtimeInstanceId || plan.runtimeGeneration!==lease.generation)throw new DurableStoreError('LEASE_FENCED');
  assertControlledPlanCurrent(db,tx,plan,registry,timing);
  if(canonicalJson(command.scope)!==canonicalJson(controlledScopeOf(plan))
    || plan.approvalPolicy.forbidSelfApproval && plan.createdByActorId===identity.actorId)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const prior=tx.get('SELECT authorization_id FROM recovery_controlled_grants WHERE plan_id=? AND authorized_actor_id=?',plan.planId,identity.actorId);
  if(prior){const g=readControlledGrant(tx,String(prior.authorization_id));if(g.status!=='AUTHORIZED')throw new DurableStoreError('RECOVERY_UNAUTHORIZED');return g;}
  const body={authorizationId:randomUUID(),planId:plan.planId,...controlledScopeOf(plan),authorizedActorId:identity.actorId,
    authorizerRole:identity.roles.includes('RECOVERY_ADMIN')?'RECOVERY_ADMIN':'RECOVERY_APPROVER',authorizationSource:identity.source,
    authorizedAt:now,expiresAt:Math.min(plan.sendDeadline,identity.expiresAt,recoveryExpiry(now,command.ttlMs)),runtimeInstanceId:plan.runtimeInstanceId,runtimeGeneration:plan.runtimeGeneration};
  write('recovery_controlled_grants',{authorization_id:body.authorizationId,plan_id:plan.planId,workflow_run_id:plan.workflowRunId,action_id:plan.actionId,
    grant_json:canonicalJson(body),grant_digest:digest(body),authorized_actor_id:body.authorizedActorId,expires_at:body.expiresAt,status:'AUTHORIZED',consumed_operation_id:null,revoked_at:null,revoked_actor_id:null});
  return readControlledGrant(tx,body.authorizationId);
}
/** Transaction A participant. Reservation and all consumed grants share one COMMIT. */
export function reserveControlledDispatch(db: DurableDatabase, tx: DurableTransaction, plan:ControlledPlan, identity:VerifiedRecoveryIdentity,
  lease:WorkflowLease,registry:ControlledExecutorRegistry|undefined,timing:ControlledTiming,install:ControlledWriter) {
  requireIntegrity(plan.workflowRunId===lease.workflowRunId);
  if(plan.runtimeInstanceId!==lease.runtimeInstanceId || plan.runtimeGeneration!==lease.generation)throw new DurableStoreError('LEASE_FENCED');
  const executor=assertControlledPlanCurrent(db,tx,plan,registry,timing);
  const grants=tx.all('SELECT authorization_id FROM recovery_controlled_grants WHERE plan_id=? ORDER BY authorization_id',plan.planId)
    .map(r=>readControlledGrant(tx,String(r.authorization_id))).filter(g=>g.status==='AUTHORIZED');
  if(grants.length<plan.approvalPolicy.minimumApprovers || new Set(grants.map(g=>g.authorizedActorId)).size!==grants.length)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const now=recoveryTime(tx),sendDeadline=Math.min(plan.sendDeadline,identity.expiresAt,...grants.map(g=>g.expiresAt));
  if(sendDeadline<=now)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  const operationId=`controlled-${digest([plan.planId,plan.planDigest])}`,attemptId=randomUUID();
  const record=readPendingActionInTransaction(tx,plan.workflowRunId,plan.actionId)!;
  const old=readExecution(tx,record),reserved={...old,state:'DISPATCH_RESERVED',attempt_id:attemptId,reserved_at:now,updated_at:now};
  install('execution_ledger',reserved,old);
  reserveExecutionInTransaction(tx,record,attemptId,now);
  const intent:DispatchIntent={operationId,planId:plan.planId,workflowRunId:plan.workflowRunId,sessionId:record.sessionId,taskId:record.taskId,actionId:plan.actionId,
    attemptId,planDigest:plan.planDigest,actorId:identity.actorId,runtimeInstanceId:lease.runtimeInstanceId,runtimeGeneration:lease.generation,
    grantIds:grants.map(g=>g.authorizationId),committedAt:now,sendDeadline,executionTimeoutMs:timing.executionTimeoutMs,
    resultCollectionDeadline:sendDeadline+timing.executionTimeoutMs+timing.resultGraceMs,expectedLedgerDigest:digest(reserved),expectedStateDigest:dispatchPostState(tx,plan.workflowRunId),
    resultRef:`map.runner.result.v1:${operationId}`,defaultEvidenceRef:`map.runner.evidence.v1:${operationId}`,
    operationKind:CONTROLLED_OPERATION,operationContractVersion:CONTROLLED_RECOVERY_CONTRACT};
  for(const g of grants){const before=tx.get('SELECT * FROM recovery_controlled_grants WHERE authorization_id=?',g.authorizationId)!;
    controlledWrite(tx,install,'recovery_controlled_grants',{...before,status:'CONSUMED',consumed_operation_id:operationId},before);}
  controlledWrite(tx,install,'recovery_dispatch_intents',{operation_id:operationId,plan_id:plan.planId,workflow_run_id:plan.workflowRunId,action_id:plan.actionId,
    attempt_id:attemptId,intent_json:canonicalJson(intent),intent_digest:digest(intent),runtime_instance_id:lease.runtimeInstanceId,runtime_generation:lease.generation});
  for(const g of grants)controlledWrite(tx,install,'recovery_dispatch_grants',{authorization_id:g.authorizationId,operation_id:operationId,plan_id:plan.planId,workflow_run_id:plan.workflowRunId});
  if(recoveryTime(tx)>=sendDeadline)throw new DurableStoreError('RECOVERY_UNAUTHORIZED');
  return {intent,record,executor};
}
export function assertDispatchSink(tx:DurableTransaction,intent:DispatchIntent):void{
  const saved=tx.get('SELECT intent_digest FROM recovery_dispatch_intents WHERE operation_id=?',intent.operationId);
  requireIntegrity(saved?.intent_digest===digest(intent) && recoveryTime(tx)<intent.resultCollectionDeadline);
  const record=readPendingActionInTransaction(tx,intent.workflowRunId,intent.actionId);requireIntegrity(record);
  validateActionOwner(readJournal(tx,intent.workflowRunId).snapshot,record);
  const row=readExecution(tx,record);
  requireIntegrity(row.state==='DISPATCH_RESERVED' && row.attempt_id===intent.attemptId && row.result_ref===null && row.finalized_event_id===null
    && record.sessionId===intent.sessionId && record.taskId===intent.taskId && digest(row)===intent.expectedLedgerDigest);
}
export function persistDispatchEvidence(tx:DurableTransaction,intent:DispatchIntent,ref:string,evidence:RunnerEvidence,install:ControlledWriter,final=false):string{
  assertDispatchSink(tx,intent);
  const json=executionJson(evidence,EXECUTION_LIMITS.evidence);rejectEmbeddedCredentials(evidence.content);
  requireIntegrity(typeof evidence.kind==='string' && !!evidence.kind.trim() && Object.hasOwn(evidence,'content') && Number.isSafeInteger(evidence.createdAt) && evidence.createdAt>=0);
  const prior=tx.get('SELECT * FROM runner_evidence WHERE evidence_ref=?',ref);
  if(prior){requireIntegrity(prior.content_digest===digest(evidence) && tx.get('SELECT operation_id FROM recovery_dispatch_evidence WHERE evidence_ref=?',ref)?.operation_id===intent.operationId);return ref;}
  const used=tx.get('SELECT count(*) AS n,coalesce(sum(size_bytes),0) AS bytes FROM recovery_dispatch_evidence WHERE operation_id=?',intent.operationId)!;
  // Reserve one slot and one result-sized allowance for the default Evidence in B.
  requireIntegrity(Number(used.n)<CONTROLLED_LIMITS.evidenceCount-(final?0:1)
    && Number(used.bytes)+Buffer.byteLength(json)<=CONTROLLED_LIMITS.evidenceBytes-(final?0:EXECUTION_LIMITS.result+1024));
  controlledWrite(tx,install,'runner_evidence',{evidence_ref:ref,workflow_run_id:intent.workflowRunId,session_id:intent.sessionId,task_id:intent.taskId,action_id:intent.actionId,
    kind:evidence.kind,content_json:json,content_digest:digest(evidence),created_at:evidence.createdAt,schema_version:1});
  controlledWrite(tx,install,'recovery_dispatch_evidence',{evidence_ref:ref,operation_id:intent.operationId,workflow_run_id:intent.workflowRunId,action_id:intent.actionId,
    attempt_id:intent.attemptId,content_digest:digest(evidence),size_bytes:Buffer.byteLength(json)});
  requireIntegrity(recoveryTime(tx)<intent.resultCollectionDeadline);
  return ref;
}
/** Transaction B participant. Never calls an executor or issues a capability. */
export function persistDispatchResult(tx:DurableTransaction,intent:DispatchIntent,result:RunnerExecutionResult,recordedAt:number,install:ControlledWriter):DispatchReceipt{
  assertDispatchSink(tx,intent);
  const record=readPendingActionInTransaction(tx,intent.workflowRunId,intent.actionId)!;
  if(result.resultRef===intent.defaultEvidenceRef)persistDispatchEvidence(tx,intent,intent.defaultEvidenceRef,
    {kind:'runner.execution',content:result,createdAt:recordedAt},install,true);
  validateExecutionEvidence(tx,record,result,{getOwnedInTransaction:readOwnedEvidenceInTransaction});
  for(const ref of new Set([result.resultRef,...(result.evidenceRefs??[])]))requireIntegrity(tx.get(
    'SELECT evidence_ref FROM recovery_dispatch_evidence WHERE evidence_ref=? AND operation_id=? AND attempt_id=?',ref!,intent.operationId,intent.attemptId));
  const json=executionJson(result,EXECUTION_LIMITS.result),hash=digest(result),review=result.status==='uncertain'||!!result.safetyHold;
  const reason=review?(result.safetyHold?'SECURITY_REVIEW_REQUIRED':'EXECUTION_UNCERTAIN'):null;
  controlledWrite(tx,install,'execution_results',{result_ref:intent.resultRef,workflow_run_id:intent.workflowRunId,session_id:intent.sessionId,task_id:intent.taskId,action_id:intent.actionId,
    fingerprint:record.action.fingerprint,executor_id:record.action.executorId,attempt_id:intent.attemptId,result_json:json,result_digest:hash,created_at:recordedAt,schema_version:1});
  const old=readExecution(tx,record);
  controlledWrite(tx,install,'execution_ledger',{...old,state:review?'REVIEW_REQUIRED':'RESULT_RECORDED',result_ref:intent.resultRef,result_digest:hash,updated_at:recordedAt,review_reason:reason},old);
  const receipt:DispatchReceipt={operationId:intent.operationId,planId:intent.planId,workflowRunId:intent.workflowRunId,actionId:intent.actionId,attemptId:intent.attemptId,
    status:review?'REVIEW_REQUIRED':'RESULT_RECORDED',resultRef:intent.resultRef,resultDigest:hash,recordedAt,reasonCode:reason};
  controlledWrite(tx,install,'recovery_dispatch_receipts',{operation_id:intent.operationId,plan_id:intent.planId,workflow_run_id:intent.workflowRunId,action_id:intent.actionId,
    attempt_id:intent.attemptId,result_ref:intent.resultRef,result_digest:hash,receipt_json:canonicalJson(receipt),receipt_digest:digest(receipt)});
  requireIntegrity(recoveryTime(tx)<intent.resultCollectionDeadline);
  return receipt;
}
