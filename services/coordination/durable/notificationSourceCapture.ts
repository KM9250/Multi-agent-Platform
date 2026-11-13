import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, parseJson, requireIntegrity } from './integrity';
import { recoveryTime } from './recoveryPlanner';
import { projectNotificationSources, notificationSourceDisposition, DURABLE_NOTIFICATION_CONTRACT } from './notificationSourceProjector';
import type { ProjectedNotificationSource, NotificationSource } from './notificationSourceProjector';

/** Exact-row writer supplied only by the DB-owned participant; it is never a public capability. */
export type NotificationSourceWrite=(table:string,row:Row,old?:Row)=>void;
export type NotificationOriginSnapshot=Map<string,string>;

export function snapshotNotificationOrigins(tx:DurableTransaction, workflowRunId:string):NotificationOriginSnapshot {
  // Read only immutable references/versions and the Journal head. Heartbeats,
  // reader activity and unrelated ledger writes need no Journal/body replay.
  const result:NotificationOriginSnapshot=new Map();
  const seed=tx.get('SELECT last_sequence,journal_anchor FROM workflow_seeds WHERE workflow_run_id=?',workflowRunId);
  result.set('@journal-sequence',String(seed?.last_sequence??0));result.set('@journal-anchor',String(seed?.journal_anchor??''));
  for(const [table,column,kind] of [
    ['planning_artifacts','artifact_id','PLAN_ARTIFACT'],['planning_input_requests','input_request_id','PLANNING_INPUT'],
    ['reconciliation_disputes','dispute_id','RECONCILIATION_DISPUTE'],['reconciliation_operations','operation_id','RECONCILIATION_OPERATION'],
  ]) for(const row of tx.all(`SELECT ${column} AS id FROM ${table} WHERE workflow_run_id=?`,workflowRunId))result.set(`${kind}:${row.id}`,'1');
  for(const row of tx.all("SELECT invocation_id,revision FROM recovery_invocations WHERE workflow_run_id=? AND status IN ('STOPPED','REVIEW_REQUIRED')",workflowRunId))
    result.set(`BOUNDED_INVOCATION:${row.invocation_id}`,String(row.revision));
  return result;
}

function insertSource(tx:DurableTransaction,s:ProjectedNotificationSource,reason:NotificationSource['captureReason'],write:NotificationSourceWrite,actorId:string):string {
  const existing=tx.get('SELECT * FROM notification_sources WHERE source_id=?',s.sourceId);
  if(existing) {
    requireIntegrity(existing.notification_id===s.notificationId&&existing.source_digest===s.sourceDigest
      &&existing.source_json===canonicalJson(s.origin)&&existing.workflow_run_id===s.workflowRunId);
    return s.sourceId;
  }
  const sequence=Number(tx.get('SELECT coalesce(max(source_sequence),0)+1 AS n FROM notification_sources WHERE workflow_run_id=?',s.workflowRunId)!.n);
  const row:Row={source_id:s.sourceId,workflow_run_id:s.workflowRunId,notification_id:s.notificationId,kind:s.kind,
    source_kind:s.sourceKind,source_ref:s.sourceRef,source_version:s.sourceVersion,source_digest:s.sourceDigest,
    occurrence_identity:s.occurrenceIdentity,occurred_at:s.occurredAt,projection_contract:DURABLE_NOTIFICATION_CONTRACT,
    source_sequence:sequence,owner_subject:s.ownerSubject,source_json:canonicalJson(s.origin),capture_reason:reason};
  write('notification_sources',row);
  write('notification_delivery_audit',{audit_id:`notification-source-${digest([s.sourceId,reason])}`,workflow_run_id:s.workflowRunId,
    source_id:s.sourceId,delivery_id:null,attempt_id:null,event_kind:reason==='ATOMIC_COMMIT'?'NOTIFICATION_SOURCE_RECORDED':'NOTIFICATION_LEGACY_SYNCED',
    actor_id:actorId,reason,record_digest:digest(row),recorded_at:recoveryTime(tx)});
  return s.sourceId;
}

/** Runs after the final business participants, before the same COMMIT. No routing/ACL/HTTP callback. */
export function captureNotificationSources(tx:DurableTransaction,workflowRunId:string,before:NotificationOriginSnapshot,write:NotificationSourceWrite):string[] {
  const after=snapshotNotificationOrigins(tx,workflowRunId);
  if(after.size===before.size&&[...after].every(([key,value])=>before.get(key)===value))return [];
  const captured:string[]=[];
  for(const s of projectNotificationSources(tx,workflowRunId)) {
    const existed=s.sourceKind==='JOURNAL'?Number(s.sourceVersion)<=Number(before.get('@journal-sequence')??0)
      :before.has(`${s.sourceKind}:${s.sourceRef}`);
    if(existed)continue;
    captured.push(insertSource(tx,s,'ATOMIC_COMMIT',write,'system:notification-capture'));
  }
  return captured;
}

/** Migration records the exact pre-v11 occurrence set; it never marks it delivered or pending. */
export function initializeNotificationBaselines(tx:DurableTransaction,write:NotificationSourceWrite):void {
  for(const row of tx.all('SELECT workflow_run_id,last_sequence,journal_anchor FROM workflow_seeds ORDER BY workflow_run_id')) {
    const id=String(row.workflow_run_id),ids=projectNotificationSources(tx,id).map(s=>s.sourceId).sort();
    const body={workflowRunId:id,journalSequence:Number(row.last_sequence),journalAnchor:String(row.journal_anchor),occurrenceIds:ids};
    write('notification_migration_baselines',{workflow_run_id:id,journal_sequence:body.journalSequence,journal_anchor:body.journalAnchor,
      occurrence_ids_json:canonicalJson(ids),baseline_digest:digest(body),created_at:recoveryTime(tx)});
  }
}

/** Caller already holds explicit SYNC authority and persists its management receipt in this transaction.
 * The baseline is immutable; concurrent subsequent business capture is never advanced or hidden.
 */
export function syncLegacyNotificationSources(tx:DurableTransaction,workflowRunId:string,expectedBaseline:string,write:NotificationSourceWrite,actorId='system:notification-sync'):string[] {
  const row=tx.get('SELECT * FROM notification_migration_baselines WHERE workflow_run_id=?',workflowRunId);requireIntegrity(row);
  const ids=parseJson<string[]>(row.occurrence_ids_json);
  const body={workflowRunId,journalSequence:Number(row.journal_sequence),journalAnchor:String(row.journal_anchor),occurrenceIds:ids};
  requireIntegrity(Array.isArray(ids)&&ids.every(x=>typeof x==='string')&&new Set(ids).size===ids.length
    &&canonicalJson([...ids].sort())===canonicalJson(ids)&&row.baseline_digest===digest(body)&&row.baseline_digest===expectedBaseline);
  const baseline=new Set(ids),result:string[]=[];
  for(const s of projectNotificationSources(tx,workflowRunId)) {
    if(!baseline.has(s.sourceId)||s.kind==='workflow_completed'||s.kind==='workflow_cancelled')continue;
    if(notificationSourceDisposition(tx,s).disposition!=='SEND')continue;
    result.push(insertSource(tx,s,'LEGACY_UNRESOLVED_SYNC',write,actorId));
  }
  return result;
}
