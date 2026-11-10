import type { DurableDatabase, DurableTransaction, Row } from './db';
import type { DispatchInspection, DispatchIntent, DispatchReceipt } from './controlledRecoveryTypes';
import { CONTROLLED_OPERATION, CONTROLLED_RECOVERY_CONTRACT } from './controlledRecoveryTypes';
import { readControlledGrant, readControlledPlan } from './recoveryDispatchStore';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import { readPendingActionInTransaction, validateActionOwner } from './pendingActionStore';
import { readExecution } from './executionLedger';
import { readExecutionResult } from './executionReader';
import { readOwnedEvidenceInTransaction } from './evidenceStore';
import { readJournal } from './restore';
import { recoveryTime } from './recoveryPlanner';
import { validateAuditRow } from './recoveryAudit';
import { runtimeInstanceId } from './runtimeLease';

export function validateControlledAudit(tx:DurableTransaction,row:Row):boolean{
  const isControlled=!!(row.controlled_plan_id || row.controlled_grant_id || row.dispatch_operation_id)
    || /^RECOVERY_(CONTROLLED_|DISPATCH_)/.test(String(row.event_kind));
  if(!isControlled)return false;
  requireIntegrity(row.controlled_plan_id && !row.recovery_plan_id && !row.recovery_authorization_id && !row.recovery_hold_revision
    && !row.execution_plan_id && !row.execution_authorization_id && !row.recovery_operation_id
    && row.entity_kind==='WORKFLOW' && row.entity_id===row.workflow_run_id);
  const plan=tx.get('SELECT * FROM recovery_controlled_plans WHERE plan_id=?',row.controlled_plan_id);
  requireIntegrity(plan && plan.workflow_run_id===row.workflow_run_id);
  const kind=String(row.event_kind);
  let hash:unknown,actor:unknown;
  if(kind==='RECOVERY_CONTROLLED_PLAN_CREATED'){
    requireIntegrity(!row.controlled_grant_id && !row.dispatch_operation_id);
    hash=plan.plan_digest;actor=parseJson<{createdByActorId:string}>(plan.plan_json).createdByActorId;
  }else if(['RECOVERY_CONTROLLED_AUTHORIZED','RECOVERY_CONTROLLED_REVOKED','RECOVERY_CONTROLLED_GRANT_CONSUMED'].includes(kind)){
    const g=tx.get('SELECT * FROM recovery_controlled_grants WHERE authorization_id=?',row.controlled_grant_id);
    requireIntegrity(g && g.plan_id===row.controlled_plan_id && g.workflow_run_id===row.workflow_run_id);hash=g.grant_digest;
    actor=kind==='RECOVERY_CONTROLLED_AUTHORIZED'?g.authorized_actor_id:kind==='RECOVERY_CONTROLLED_REVOKED'?g.revoked_actor_id:undefined;
    requireIntegrity(kind==='RECOVERY_CONTROLLED_GRANT_CONSUMED'?row.dispatch_operation_id===g.consumed_operation_id:!row.dispatch_operation_id);
  }else{
    requireIntegrity(!row.controlled_grant_id && row.dispatch_operation_id);
    const table=kind==='RECOVERY_DISPATCH_INTENT_COMMITTED'?'recovery_dispatch_intents':'recovery_dispatch_receipts';
    requireIntegrity(['RECOVERY_DISPATCH_INTENT_COMMITTED','RECOVERY_DISPATCH_RESULT_RECORDED','RECOVERY_DISPATCH_REVIEW_REQUIRED'].includes(kind));
    const r=tx.get(`SELECT * FROM ${table} WHERE operation_id=?`,row.dispatch_operation_id);
    requireIntegrity(r && r.plan_id===row.controlled_plan_id && r.workflow_run_id===row.workflow_run_id);
    hash=table==='recovery_dispatch_intents'?r.intent_digest:r.receipt_digest;
  }
  if(row.dispatch_operation_id){
    const i=tx.get('SELECT * FROM recovery_dispatch_intents WHERE operation_id=?',row.dispatch_operation_id);requireIntegrity(i);
    actor=parseJson<DispatchIntent>(i.intent_json).actorId;
    requireIntegrity(row.runtime_instance_id===i.runtime_instance_id && row.runtime_generation===i.runtime_generation);
  }
  requireIntegrity(row.recovery_record_digest===hash && row.recovery_actor_id===actor);
  return true;
}
/** Historical validation intentionally does not require an active lease or unexpired grant. */
export function inspectDispatchInTransaction(tx:DurableTransaction,planId:string):DispatchInspection{
  const plan=readControlledPlan(tx,planId),s=readJournal(tx,plan.workflowRunId).snapshot;
  const record=readPendingActionInTransaction(tx,plan.workflowRunId,plan.actionId);requireIntegrity(record);
  validateActionOwner(s,record);
  const ledger=readExecution(tx,record),grants=tx.all('SELECT authorization_id FROM recovery_controlled_grants WHERE plan_id=? ORDER BY authorization_id',planId)
    .map(g=>readControlledGrant(tx,String(g.authorization_id)));
  const result:DispatchInspection={plan,grants,status:'NOT_STARTED',outcome:'NOT_STARTED',taskStatus:s.tasks[plan.taskId].status,
    finalizedEventId:ledger.finalized_event_id as string|null,executionAllowed:false};
  const saved=tx.get('SELECT * FROM recovery_dispatch_intents WHERE plan_id=?',planId);
  if(saved){
    const i=parseJson<DispatchIntent>(saved.intent_json);
    requireIntegrity(saved.intent_digest===digest(i) && saved.operation_id===i.operationId && saved.plan_id===i.planId
      && saved.workflow_run_id===i.workflowRunId && saved.action_id===i.actionId && saved.attempt_id===i.attemptId
      && i.planId===plan.planId && i.workflowRunId===plan.workflowRunId && i.actionId===plan.actionId && i.planDigest===plan.planDigest
      && i.sessionId===plan.sessionId && i.taskId===plan.taskId && i.runtimeInstanceId===plan.runtimeInstanceId && i.runtimeGeneration===plan.runtimeGeneration
      && saved.runtime_instance_id===i.runtimeInstanceId && saved.runtime_generation===i.runtimeGeneration
      && i.operationKind===CONTROLLED_OPERATION && i.operationContractVersion===CONTROLLED_RECOVERY_CONTRACT
      && i.operationId===`controlled-${digest([plan.planId,plan.planDigest])}`
      && i.committedAt>=plan.createdAt && i.committedAt<i.sendDeadline && i.sendDeadline<=plan.sendDeadline
      && i.executionTimeoutMs===plan.timing.executionTimeoutMs && i.resultCollectionDeadline===i.sendDeadline+i.executionTimeoutMs+plan.timing.resultGraceMs
      && ledger.attempt_id===i.attemptId && ledger.reserved_at===i.committedAt);
    const links=tx.all('SELECT * FROM recovery_dispatch_grants WHERE operation_id=? ORDER BY authorization_id',i.operationId);
    requireIntegrity(canonicalJson(links.map(l=>l.authorization_id))===canonicalJson(i.grantIds)
      && links.length>=plan.approvalPolicy.minimumApprovers);
    const actors=new Set<string>();
    for(const l of links){const g=grants.find(x=>x.authorizationId===l.authorization_id);
      requireIntegrity(g && l.plan_id===planId && l.workflow_run_id===i.workflowRunId && g.status==='CONSUMED'
        && g.consumedOperationId===i.operationId && g.authorizedAt<=i.committedAt && i.sendDeadline<=g.expiresAt && !actors.has(g.authorizedActorId));actors.add(g.authorizedActorId);}
    const reservations=tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND event_kind='EXECUTION_CHANGED' AND next_state='DISPATCH_RESERVED'",i.workflowRunId,i.actionId);
    requireIntegrity(reservations.length===1 && reservations[0].attempt_id===i.attemptId && reservations[0].runtime_instance_id===i.runtimeInstanceId && reservations[0].runtime_generation===i.runtimeGeneration);
    validateAuditRow(tx,reservations[0]);
    const intentAudits=tx.all("SELECT * FROM runtime_audit_events WHERE dispatch_operation_id=? AND event_kind='RECOVERY_DISPATCH_INTENT_COMMITTED'",i.operationId);
    requireIntegrity(intentAudits.length===1);validateAuditRow(tx,intentAudits[0]);
    for(const e of tx.all('SELECT * FROM recovery_dispatch_evidence WHERE operation_id=?',i.operationId)){
      requireIntegrity(e.workflow_run_id===i.workflowRunId && e.action_id===i.actionId && e.attempt_id===i.attemptId);
      const evidence=readOwnedEvidenceInTransaction(tx,{workflowRunId:i.workflowRunId,sessionId:i.sessionId,taskId:i.taskId,actionId:i.actionId},String(e.evidence_ref));
      requireIntegrity(evidence && digest(evidence)===e.content_digest && Buffer.byteLength(canonicalJson(evidence))===e.size_bytes);
    }
    result.intent=i;result.status='INTENT_RECORDED';
    const lease=tx.get('SELECT * FROM runtime_leases WHERE workflow_run_id=?',i.workflowRunId);
    result.outcome=i.runtimeInstanceId===runtimeInstanceId && lease?.lease_state==='ACTIVE' && lease.owner_instance_id===i.runtimeInstanceId && lease.generation===i.runtimeGeneration
      && Number(lease.expires_at)>recoveryTime(tx)?'IN_PROGRESS_OR_UNKNOWN':'OUTCOME_UNKNOWN';
    const r=tx.get('SELECT * FROM recovery_dispatch_receipts WHERE operation_id=?',i.operationId);
    if(r){
      const receipt=parseJson<DispatchReceipt>(r.receipt_json);
      requireIntegrity(r.receipt_digest===digest(receipt) && receipt.operationId===i.operationId && receipt.planId===planId
        && receipt.workflowRunId===i.workflowRunId && receipt.actionId===i.actionId && receipt.attemptId===i.attemptId
        && r.plan_id===planId && r.workflow_run_id===i.workflowRunId && r.action_id===i.actionId && r.attempt_id===i.attemptId
        && receipt.resultRef===r.result_ref && receipt.resultRef===i.resultRef && receipt.resultDigest===r.result_digest
        && receipt.recordedAt>=i.committedAt && receipt.recordedAt<i.resultCollectionDeadline);
      const execution=readExecutionResult(tx,record,{getOwnedInTransaction:readOwnedEvidenceInTransaction});
      requireIntegrity(execution && digest(execution)===receipt.resultDigest && ledger.result_ref===receipt.resultRef
        && (receipt.status==='REVIEW_REQUIRED'?ledger.state==='REVIEW_REQUIRED':receipt.status==='RESULT_RECORDED' && ['RESULT_RECORDED','FINALIZED'].includes(String(ledger.state))));
      for(const ref of new Set([execution.resultRef,...(execution.evidenceRefs??[])]))requireIntegrity(tx.get('SELECT evidence_ref FROM recovery_dispatch_evidence WHERE evidence_ref=? AND operation_id=?',ref!,i.operationId));
      const audits=tx.all("SELECT * FROM runtime_audit_events WHERE dispatch_operation_id=? AND event_kind IN ('RECOVERY_DISPATCH_RESULT_RECORDED','RECOVERY_DISPATCH_REVIEW_REQUIRED')",i.operationId);
      requireIntegrity(audits.length===1 && audits[0].event_kind===(receipt.status==='REVIEW_REQUIRED'?'RECOVERY_DISPATCH_REVIEW_REQUIRED':'RECOVERY_DISPATCH_RESULT_RECORDED'));
      validateAuditRow(tx,audits[0]);
      const changes=tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND event_kind='EXECUTION_CHANGED' AND previous_state='DISPATCH_RESERVED'",i.workflowRunId,i.actionId);
      requireIntegrity(changes.length===1 && changes[0].next_state===receipt.status && changes[0].attempt_id===i.attemptId && changes[0].reason_code===receipt.reasonCode);
      validateAuditRow(tx,changes[0]);
      // Later 4B-1 finalization is legal; verify its Journal rather than compare all Ledger columns.
      if(ledger.finalized_event_id){
        const event=s.events.find(e=>e.eventId===ledger.finalized_event_id);
        requireIntegrity(event && ['TaskCompleted','TaskFailed'].includes(event.type) && event.sessionId===i.sessionId && (event.payload as {taskId?:string}).taskId===i.taskId);
        const transition=tx.get("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND action_id=? AND event_kind='EXECUTION_CHANGED' AND journal_event_id=?",i.workflowRunId,i.actionId,ledger.finalized_event_id);
        requireIntegrity(transition);validateAuditRow(tx,transition);
      }
      result.receipt=receipt;result.status=receipt.status;result.outcome='RESULT_AVAILABLE';
    }else requireIntegrity(ledger.state==='DISPATCH_RESERVED' && ledger.result_ref===null && ledger.finalized_event_id===null);
  }
  for(const audit of tx.all('SELECT * FROM runtime_audit_events WHERE controlled_plan_id=? ORDER BY audit_sequence',planId))validateAuditRow(tx,audit);
  return result;
}
export class RecoveryDispatchReader {
  constructor(readonly database:DurableDatabase){}
  inspectDispatch(planId:string,credential:unknown):DispatchInspection{return this.database.controlledRecoveryDecision(undefined,credential,{kind:'INSPECT',planId}) as DispatchInspection;}
}
