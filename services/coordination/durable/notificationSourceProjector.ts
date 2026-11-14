import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import { readJournal } from './restore';
import type { JournalState } from './restore';
import { validateAuditRow } from './recoveryAudit';
import { readArtifact, readPlanningInputRequest, readPlanningReviewTarget } from './planningArtifactStore';
import { readContinuationPlan } from './recoveryContinuationPlanner';
import { readReconciliationReceipt } from './reconciliationStore';
import { readReconciliationVerification } from './reconciliationEvidenceStore';
import { notificationIdentity } from '../notifications/identity';
import { notificationDisposition, projectNotificationOccurrences } from '../notifications/projector';
import { notificationPresentation } from '../notifications/sanitize';
import { toMacpNotificationPacket } from '../notifications/macpPacket';
import type { MacpNotificationPacket } from '../notifications/macpPacket';
import type { CoordinationNotificationKind } from '../notifications/types';

export const DURABLE_NOTIFICATION_CONTRACT = 'COORD-5D:DURABLE_NOTIFICATION:1' as const;
/** Internal provenance is a reference, never user/model prose and never a made-up Journal event. */
export type NotificationOrigin =
  | { sourceKind:'JOURNAL'; eventId:string }
  | { sourceKind:'PLAN_ARTIFACT'; artifactId:string; invocationId:string; modelCallId:string; receiptId:string }
  | { sourceKind:'PLANNING_INPUT'; inputRequestId:string; invocationId:string; modelCallId:string; receiptId:string }
  | { sourceKind:'BOUNDED_INVOCATION'; invocationId:string; planId:string; receiptId:string|null; status:string; outcome:string; holdEpoch:number }
  | { sourceKind:'RECONCILIATION_DISPUTE'; disputeId:string; verificationId:string; targetKind:string; targetId:string; attemptId:string }
  | { sourceKind:'RECONCILIATION_OPERATION'; operationId:string; planId:string; operationKind:string; targetKind:string; targetId:string; attemptId:string };

export interface ProjectedNotificationSource {
  sourceId:string; workflowRunId:string; notificationId:string; kind:CoordinationNotificationKind;
  sourceKind:NotificationOrigin['sourceKind']; sourceRef:string; sourceVersion:string; sourceDigest:string;
  occurrenceIdentity:string; occurredAt:number; projectionContract:typeof DURABLE_NOTIFICATION_CONTRACT;
  ownerSubject:string|null; origin:NotificationOrigin;
}
export interface NotificationSource extends ProjectedNotificationSource {
  sourceSequence:number; captureReason:'ATOMIC_COMMIT'|'LEGACY_UNRESOLVED_SYNC';
}
export interface SourceDisposition { disposition:'SEND'|'SUPPRESS'|'DEFER'; reason:string }

function source(workflowRunId:string, kind:CoordinationNotificationKind, sourceRef:string, sourceVersion:string,
  sourceDigest:string, occurredAt:number, ownerSubject:string|null, origin:NotificationOrigin,
  legacyId?:string):ProjectedNotificationSource {
  const occurrenceIdentity=legacyId??canonicalJson([origin.sourceKind,sourceRef,sourceVersion,sourceDigest,ownerSubject]);
  const notificationId=legacyId??notificationIdentity(workflowRunId,kind,'reference',occurrenceIdentity);
  requireIntegrity(Number.isFinite(occurredAt)&&occurredAt>=0&&Number.isFinite(new Date(occurredAt).getTime()));
  return {sourceId:notificationId,workflowRunId,notificationId,kind,sourceKind:origin.sourceKind,sourceRef,sourceVersion,
    sourceDigest,occurrenceIdentity,occurredAt,projectionContract:DURABLE_NOTIFICATION_CONTRACT,ownerSubject,origin};
}

function finishReceipt(tx:DurableTransaction, invocation:Row):{row:Row;body:{invocationId:string;status:string;outcome:string;at:number}}|undefined {
  const row=tx.get("SELECT * FROM recovery_continuation_receipts WHERE plan_id=? AND kind='FINISH'",invocation.plan_id);
  if(!row)return;
  const body=parseJson<{invocationId:string;status:string;outcome:string;at:number}>(row.receipt_json);
  requireIntegrity(row.workflow_run_id===invocation.workflow_run_id&&row.receipt_digest===digest(body)
    &&body.invocationId===invocation.invocation_id&&body.status===invocation.status&&body.outcome===invocation.outcome
    &&Number.isSafeInteger(body.at)&&body.at>=Number(invocation.started_at));
  const audit=tx.all("SELECT * FROM bounded_audit WHERE workflow_run_id=? AND entity_table='recovery_continuation_receipts' AND record_id=? AND operation='INSERT'",invocation.workflow_run_id,row.receipt_id);
  requireIntegrity(audit.length===1);
  return {row,body};
}

function planningApplication(tx:DurableTransaction,journal:JournalState,modelCallId:string,referenceId:string,contentDigest:string,type:'PlanArtifactPublished'|'PlanningInputRequested'):void {
  const call=tx.get('SELECT * FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?',journal.snapshot.run.runId,modelCallId);requireIntegrity(call);
  const event=journal.events.find(e=>e.eventId===call.application_event_id),cursor=Number(call.application_start_cursor);
  requireIntegrity(call.state==='SETTLED'&&call.application_status==='APPLIED'&&call.completeness==='COMPLETE'
    &&event?.type===type&&Number.isSafeInteger(cursor)&&cursor>=1&&event.sequence===cursor+1
    &&call.application_digest===digest([event])&&journal.events[cursor-1]?.eventId===call.usage_event_id);
  const payload=event.payload as {modelCallId:string;referenceId:string;contentDigest:string};
  requireIntegrity(payload.modelCallId===modelCallId&&payload.referenceId===referenceId&&payload.contentDigest===contentDigest);
  const audits=tx.all("SELECT * FROM runtime_audit_events WHERE workflow_run_id=? AND model_call_id=? AND event_kind='MODEL_RESPONSE_APPLIED'",journal.snapshot.run.runId,modelCallId);
  requireIntegrity(audits.length===1&&audits[0].attempt_id===call.attempt_id&&audits[0].runtime_instance_id===call.runtime_instance_id&&audits[0].runtime_generation===call.generation);
  validateAuditRow(tx,audits[0]);
}

/** A complete workflow replay validates the real Journal and immutable origins.
 * Called only for the affected workflow. Unrelated notification ledger writes never call it.
 * Initial v1 deliberately favors full validation over an unverified incremental projector.
 */
export function projectNotificationSources(tx:DurableTransaction, workflowRunId:string):ProjectedNotificationSource[] {
  if(!tx.get('SELECT workflow_run_id FROM workflow_seeds WHERE workflow_run_id=?',workflowRunId))return [];
  const journal=readJournal(tx,workflowRunId),result:ProjectedNotificationSource[]=[];
  for(const occurrence of projectNotificationOccurrences(journal.snapshot)) {
    const n=occurrence.notification,event=journal.events.find(e=>e.eventId===n.sourceEventId);requireIntegrity(event);
    result.push(source(workflowRunId,n.kind,event.eventId,String(event.sequence),digest(event),n.occurredAt,null,
      {sourceKind:'JOURNAL',eventId:event.eventId},n.notificationId));
  }
  for(const row of tx.all('SELECT * FROM planning_artifacts WHERE workflow_run_id=? ORDER BY rowid',workflowRunId)) {
    const a=readArtifact(tx,{artifactId:String(row.artifact_id),version:Number(row.version),contentDigest:String(row.content_digest)});
    planningApplication(tx,journal,a.modelCallId,a.artifactId,a.contentDigest,'PlanArtifactPublished');
    const invocation=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',a.invocationId);requireIntegrity(invocation);
    const finish=finishReceipt(tx,invocation),plan=readContinuationPlan(tx,String(invocation.plan_id));
    requireIntegrity(finish&&finish.body.status==='COMPLETED'&&finish.body.outcome==='AWAITING_PLAN_REVIEW'
      &&plan.operation==='PLANNING_ONLY'&&plan.createdBy===a.ownerId&&invocation.owner_id===a.ownerId&&plan.requestId===a.requestId&&plan.mode===a.mode);
    result.push(source(workflowRunId,'planning_review_required',a.artifactId,String(a.version),a.contentDigest,a.createdAt,a.ownerId,
      {sourceKind:'PLAN_ARTIFACT',artifactId:a.artifactId,invocationId:a.invocationId,modelCallId:a.modelCallId,receiptId:String(finish.row.receipt_id)}));
  }
  for(const row of tx.all('SELECT * FROM planning_input_requests WHERE workflow_run_id=? ORDER BY rowid',workflowRunId)) {
    const q=readPlanningInputRequest(tx,String(row.input_request_id));
    planningApplication(tx,journal,q.modelCallId,q.inputRequestId,q.contentDigest,'PlanningInputRequested');
    const invocation=tx.get('SELECT * FROM recovery_invocations WHERE invocation_id=?',q.invocationId);requireIntegrity(invocation);
    const finish=finishReceipt(tx,invocation);requireIntegrity(finish&&invocation.owner_id===q.ownerId);
    result.push(source(workflowRunId,'planning_input_required',q.inputRequestId,'1',q.contentDigest,q.createdAt,q.ownerId,
      {sourceKind:'PLANNING_INPUT',inputRequestId:q.inputRequestId,invocationId:q.invocationId,modelCallId:q.modelCallId,receiptId:String(finish.row.receipt_id)}));
  }
  for(const invocation of tx.all("SELECT * FROM recovery_invocations WHERE workflow_run_id=? AND status IN ('STOPPED','REVIEW_REQUIRED') ORDER BY rowid",workflowRunId)) {
    const p=readContinuationPlan(tx,String(invocation.plan_id));
    // A published plan or input question has its own, narrower notification.
    if(tx.get('SELECT artifact_id FROM planning_artifacts WHERE invocation_id=?',invocation.invocation_id)
      ||tx.get('SELECT input_request_id FROM planning_input_requests WHERE invocation_id=?',invocation.invocation_id))continue;
    const finish=finishReceipt(tx,invocation);
    // Lease fencing has no FINISH receipt; it has a canonical hold lifecycle entry.
    const lifecycle=tx.get("SELECT h.* FROM recovery_hold_lifecycle h JOIN recovery_hold_lifecycle p ON p.workflow_run_id=h.workflow_run_id AND p.control_revision=h.control_revision-1 WHERE h.workflow_run_id=? AND p.active_invocation_id=? AND h.active_invocation_id IS NULL AND h.reason IN ('INVOCATION_FINISHED','GENERATION_CHANGED') ORDER BY h.control_revision LIMIT 1",workflowRunId,invocation.invocation_id);
    const lost=invocation.status==='REVIEW_REQUIRED'&&invocation.outcome==='LEASE_LOST'
      &&lifecycle?.reason==='GENERATION_CHANGED'&&Number(lifecycle.generation)>Number(invocation.generation)?lifecycle:undefined;
    requireIntegrity(finish||lost);
    requireIntegrity(lifecycle&&invocation.owner_id===p.createdBy&&invocation.outcome!==null);
    const origin:NotificationOrigin={sourceKind:'BOUNDED_INVOCATION',invocationId:String(invocation.invocation_id),planId:p.planId,
      receiptId:finish?String(finish.row.receipt_id):null,status:String(invocation.status),outcome:String(invocation.outcome),holdEpoch:Number(lifecycle.hold_epoch)};
    const body={invocationId:invocation.invocation_id,planId:p.planId,ownerId:invocation.owner_id,status:invocation.status,outcome:invocation.outcome,
      revision:invocation.revision,finishDigest:finish?.row.receipt_digest??digest(lost)};
    result.push(source(workflowRunId,'recovery_review_required',String(invocation.invocation_id),String(invocation.revision),digest(body),
      finish?.body.at??Number(lost!.recorded_at),String(invocation.owner_id),origin));
  }
  for(const d of tx.all('SELECT * FROM reconciliation_disputes WHERE workflow_run_id=? ORDER BY rowid',workflowRunId)) {
    const verification=readReconciliationVerification(tx,String(d.verification_id));
    requireIntegrity(verification.status==='VERIFIED'&&verification.target.workflowRunId===workflowRunId
      &&verification.target.targetKind===d.target_kind&&verification.target.targetId===d.target_id&&verification.target.attemptId===d.attempt_id);
    const audit=tx.all("SELECT * FROM reconciliation_audit WHERE event_kind='RECONCILIATION_DISPUTE_RECORDED' AND record_id=?",d.dispute_id);
    requireIntegrity(audit.length===1&&audit[0].workflow_run_id===workflowRunId&&audit[0].record_digest===digest(d));
    if(d.reason_code!=='TRUST_REVOKED')requireIntegrity(verification.claim.completeness==='COMPLETE'&&verification.claim.finality==='FINAL');
    requireIntegrity(['TRUST_REVOKED','NORMAL_FACT_CONFLICT','VERIFIED_FACT_CONFLICT'].includes(String(d.reason_code)));
    const cases=tx.all('SELECT * FROM reconciliation_cases WHERE workflow_run_id=? AND target_kind=? AND target_id=? AND attempt_id=?',workflowRunId,d.target_kind,d.target_id,d.attempt_id);
    requireIntegrity(cases.some(c=>parseJson<Record<string,unknown>>(c.case_json).disputeId===d.dispute_id));
    result.push(source(workflowRunId,'reconciliation_review_required',String(d.dispute_id),'1',digest(d),Number(d.created_at),null,
      {sourceKind:'RECONCILIATION_DISPUTE',disputeId:String(d.dispute_id),verificationId:String(d.verification_id),targetKind:String(d.target_kind),targetId:String(d.target_id),attemptId:String(d.attempt_id)}));
  }
  for(const op of tx.all("SELECT * FROM reconciliation_operations WHERE workflow_run_id=? AND operation_kind IN ('SETTLE_VERIFIED_MODEL_USAGE','RECORD_VERIFIED_ACTION_OUTCOME') ORDER BY rowid",workflowRunId)) {
    const receipt=readReconciliationReceipt(tx,String(op.plan_id));requireIntegrity(receipt);
    if(op.operation_kind==='SETTLE_VERIFIED_MODEL_USAGE') {
      const usage=tx.get('SELECT * FROM reconciled_model_usages WHERE operation_id=?',op.operation_id);requireIntegrity(usage);
      if(!usage.budget_violation&&['APPLIED','DISCARDED'].includes(String(usage.response_status)))continue;
    }
    result.push(source(workflowRunId,'reconciliation_review_required',String(op.operation_id),'1',String(op.receipt_digest),Number(op.created_at),null,
      {sourceKind:'RECONCILIATION_OPERATION',operationId:String(op.operation_id),planId:String(op.plan_id),operationKind:String(op.operation_kind),targetKind:String(op.target_kind),targetId:String(op.target_id),attemptId:String(op.attempt_id)}));
  }
  requireIntegrity(new Set(result.map(s=>s.sourceId)).size===result.length);
  return result;
}

function projected(source:NotificationSource):ProjectedNotificationSource {
  const {sourceSequence:_,captureReason:__,...body}=source;return body;
}

export function notificationSourceFromRow(row:Row):NotificationSource {
  const origin=parseJson<NotificationOrigin>(row.source_json);
  const source:NotificationSource={sourceId:String(row.source_id),workflowRunId:String(row.workflow_run_id),notificationId:String(row.notification_id),
    kind:row.kind as CoordinationNotificationKind,sourceKind:row.source_kind as NotificationOrigin['sourceKind'],sourceRef:String(row.source_ref),
    sourceVersion:String(row.source_version),sourceDigest:String(row.source_digest),occurrenceIdentity:String(row.occurrence_identity),occurredAt:Number(row.occurred_at),
    projectionContract:row.projection_contract as typeof DURABLE_NOTIFICATION_CONTRACT,sourceSequence:Number(row.source_sequence),ownerSubject:row.owner_subject===null?null:String(row.owner_subject),
    origin,captureReason:row.capture_reason as NotificationSource['captureReason']};
  requireIntegrity(source.projectionContract===DURABLE_NOTIFICATION_CONTRACT&&origin.sourceKind===source.sourceKind
    &&Number.isSafeInteger(source.sourceSequence)&&source.sourceSequence>0&&['ATOMIC_COMMIT','LEGACY_UNRESOLVED_SYNC'].includes(source.captureReason));
  sourcePacket(source);return source;
}

export function readNotificationSource(tx:DurableTransaction, sourceId:string):NotificationSource {
  const row=tx.get('SELECT * FROM notification_sources WHERE source_id=?',sourceId);requireIntegrity(row);
  const source=notificationSourceFromRow(row);
  const canonical=projectNotificationSources(tx,source.workflowRunId).find(s=>s.sourceId===source.sourceId);
  requireIntegrity(canonical&&canonicalJson(canonical)===canonicalJson(projected(source)));
  const audits=tx.all("SELECT * FROM notification_delivery_audit WHERE source_id=? AND event_kind IN ('NOTIFICATION_SOURCE_RECORDED','NOTIFICATION_LEGACY_SYNCED')",sourceId);
  requireIntegrity(audits.length===1&&audits[0].workflow_run_id===source.workflowRunId&&audits[0].record_digest===digest(row)
    &&audits[0].reason===source.captureReason&&audits[0].event_kind===(source.captureReason==='ATOMIC_COMMIT'?'NOTIFICATION_SOURCE_RECORDED':'NOTIFICATION_LEGACY_SYNCED'));
  return source;
}

/** Pure fixed packet projection; no source/owner/grant/detail reaches the receiver. */
export function sourcePacket(source:ProjectedNotificationSource):MacpNotificationPacket {
  return toMacpNotificationPacket({schemaVersion:1,notificationId:source.notificationId,workflowRunId:source.workflowRunId,
    kind:source.kind,occurredAt:source.occurredAt,...notificationPresentation(source.kind)});
}

/** Current necessity is independent of delivery/ACK history. Nothing here grants execution. */
export function notificationSourceDisposition(tx:DurableTransaction, value:NotificationSource|ProjectedNotificationSource):SourceDisposition {
  const s=projectNotificationSources(tx,value.workflowRunId).find(item=>item.sourceId===value.sourceId);
  requireIntegrity(s&&canonicalJson(s)===canonicalJson('sourceSequence' in value?projected(value):value));
  const o=s.origin;
  if(o.sourceKind==='JOURNAL') {
    const disposition=notificationDisposition(readJournal(tx,s.workflowRunId).snapshot,{schemaVersion:1,notificationId:s.notificationId,workflowRunId:s.workflowRunId,
      sourceEventId:o.eventId,kind:s.kind,occurredAt:s.occurredAt,...notificationPresentation(s.kind)});
    return {disposition:disposition==='send'?'SEND':disposition==='suppress'?'SUPPRESS':'DEFER',reason:disposition==='send'?'REQUIRED':disposition==='suppress'?'RESOLVED':'STATE_UNCONFIRMED'};
  }
  if(o.sourceKind==='PLAN_ARTIFACT') {
    const review=tx.get('SELECT decision FROM planning_reviews WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1',o.artifactId);
    if(review&&['ACCEPTED_FOR_SCOPE','REJECTED','SUPERSEDED','STALE'].includes(String(review.decision)))return {disposition:'SUPPRESS',reason:'RESOLVED'};
    const latest=readPlanningReviewTarget(tx,s.workflowRunId);
    if(latest&&latest.artifactId===o.artifactId&&String(latest.version)===s.sourceVersion&&latest.contentDigest===s.sourceDigest&&latest.ownerId===s.ownerSubject)
      return {disposition:'SEND',reason:'REQUIRED'};
    return {disposition:'DEFER',reason:'STATE_UNCONFIRMED'};
  }
  if(o.sourceKind==='PLANNING_INPUT')return {disposition:'SEND',reason:'REQUIRED'}; // No canonical answered API exists.
  if(o.sourceKind==='RECONCILIATION_DISPUTE')return {disposition:'SEND',reason:'REQUIRED'}; // No implicit terminal/usage resolution.
  if(o.sourceKind==='BOUNDED_INVOCATION') {
    const p=readContinuationPlan(tx,o.planId);
    const released=p.origin==='RECOVERY'&&tx.get("SELECT lifecycle_id FROM recovery_hold_lifecycle WHERE workflow_run_id=? AND hold_epoch=? AND reason='HOLD_RELEASED' AND recorded_at>=?",s.workflowRunId,o.holdEpoch,s.occurredAt);
    // A later model call, a terminal workflow, or a new hold does not prove this
    // invocation's confirmation obligation was resolved.
    return released?{disposition:'SUPPRESS',reason:'RESOLVED'}:{disposition:'SEND',reason:'REQUIRED'};
  }
  if(o.operationKind==='RECORD_VERIFIED_ACTION_OUTCOME') {
    const applied=tx.get('SELECT operation_id FROM reconciled_action_applications WHERE outcome_operation_id=?',o.operationId);
    return applied?{disposition:'SUPPRESS',reason:'RESOLVED'}:{disposition:'SEND',reason:'REQUIRED'};
  }
  const usage=tx.get('SELECT * FROM reconciled_model_usages WHERE operation_id=?',o.operationId);requireIntegrity(usage);
  if(usage.budget_violation)return {disposition:'SEND',reason:'REQUIRED'};
  const model=tx.get('SELECT application_status FROM model_call_ledger WHERE workflow_run_id=? AND model_call_id=?',s.workflowRunId,o.targetId);requireIntegrity(model);
  const resolution=tx.get('SELECT model_call_id FROM recovery_model_resolutions WHERE workflow_run_id=? AND model_call_id=?',s.workflowRunId,o.targetId);
  return resolution||['APPLIED','DISCARDED'].includes(String(model.application_status))?{disposition:'SUPPRESS',reason:'RESOLVED'}:{disposition:'SEND',reason:'REQUIRED'};
}
