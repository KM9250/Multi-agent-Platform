import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import type { DurableTransaction, Row } from './db';
import { canonicalJson, digest, DurableStoreError, parseJson, requireIntegrity } from './integrity';
import { DATABASE_NOW_SQL } from './leaseSchema';
import { nativeVerifierPromise } from './reconciliationVerifier';
import { readNotificationSource, notificationSourceDisposition, sourcePacket } from './notificationSourceProjector';
import type { NotificationSource } from './notificationSourceProjector';
import { syncLegacyNotificationSources } from './notificationSourceCapture';
import { NotificationAuthority, notificationId, notificationInput, notificationLimits } from './notificationDeliveryAuthority';
import type { BoundNotificationDestination, NotificationTarget } from './notificationDeliveryAuthority';
import { DURABLE_NOTIFICATION_CONTRACT } from './notificationTypes';
import type { NotificationDependencies, NotificationLimits, NotificationManagementCommand, NotificationOptions, NotificationPage, NotificationPermission, NotificationReadInput, NotificationSyncCommand, NotificationView } from './notificationTypes';
import type { MacpNotificationPacket } from '../notifications/macpPacket';
import type { NotificationDeliveryReceipt } from '../notifications/deliveryError';
import { DeliveryError } from '../notifications/deliveryError';

const terminal = new Set(['DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED']);
const permissions:Record<NotificationManagementCommand['operation'],NotificationPermission>={
  PAUSE:'PAUSE_NOTIFICATION_DELIVERY',RESUME:'RESUME_NOTIFICATION_DELIVERY',RETRY:'RETRY_NOTIFICATION_DELIVERY',CLOSE:'CLOSE_NOTIFICATION_DELIVERY'};
const now=(tx:DurableTransaction):number=>Number(tx.get(`SELECT ${DATABASE_NOW_SQL} AS now`)!.now);
const text=(v:unknown):string=>String(v);
const integer=(v:unknown):number=>Number(v);
const abortedGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
function signalAborted(signal:AbortSignal|undefined):boolean {
  if(signal===undefined)return false;
  try {
    if(!signal||typeof signal!=='object'||utilTypes.isProxy(signal)||Object.values(Object.getOwnPropertyDescriptors(signal)).some(d=>!('value'in d)))throw 0;
    return Reflect.apply(abortedGetter,signal,[])===true;
  }catch{throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');}
}
type Entry={source:NotificationSource;delivery?:Row;};
interface Permit { delivery:Row; claim:Row; attempt:Row; source:NotificationSource; issued:number; }
type Failure={code:string;retryable:boolean;status:number|null;notSent:boolean};

/** Durable notification authority. It has no WorkflowLease, Runner or execution dependency. */
export class NotificationRuntime {
  readonly #deps:NotificationDependencies;
  readonly #authority:NotificationAuthority;
  readonly #permits=new WeakSet<object>();
  readonly #workerId=`notification-worker-${randomUUID()}`;
  readonly limits:Readonly<NotificationLimits>;
  #inflight=0;
  #time={wall:Date.now(),monotonic:performance.now()};
  constructor(deps:NotificationDependencies,options:NotificationOptions={}) {
    this.#deps=deps;this.#authority=new NotificationAuthority(deps,options);this.limits=notificationLimits(options.limits);
  }
  #target(workflowRunId:string,source?:NotificationSource,d?:Row,b?:BoundNotificationDestination):NotificationTarget {
    return {workflowRunId,ownerSubject:source?.ownerSubject??null,
      recipientSubject:d?text(d.recipient_subject):b?.destination.recipientSubject??null,
      audience:d?text(d.audience):b?.destination.audience??null,
      receiverRealm:d?text(d.receiver_realm):b?.destination.receiverRealm??null,
      destinationId:d?text(d.destination_id):b?.destination.destinationId??null};
  }
  #workflow(input:string):string { if(!notificationId(input))throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');return input; }
  #service(credential:unknown,permission:NotificationPermission,target:NotificationTarget) {
    const access=this.#authority.check(credential,permission,target);
    if(access.actor.kind!=='SERVICE')throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');return access;
  }
  #entry(tx:DurableTransaction,sourceId:string):Entry {
    const source=readNotificationSource(tx,sourceId),delivery=tx.get('SELECT * FROM notification_deliveries WHERE source_id=?',sourceId);
    if(delivery){this.#packet(source,delivery);this.#history(tx,delivery);}
    return {source,delivery};
  }
  #history(tx:DurableTransaction,d:Row):void {
    requireIntegrity(d.delivery_id===`delivery-${d.notification_id}`);
    const attempts=tx.all('SELECT * FROM notification_delivery_attempts WHERE delivery_id=? ORDER BY attempt_number',d.delivery_id);
    requireIntegrity(attempts.length===d.attempt_count&&attempts.every((a,i)=>a.attempt_number===i+1&&a.workflow_run_id===d.workflow_run_id)
      &&(attempts.length?attempts.at(-1)!.claim_generation===d.claim_generation:d.claim_generation===0));
    const receipts=tx.all('SELECT * FROM notification_delivery_receipts WHERE delivery_id=?',d.delivery_id);
    for(const receipt of receipts){
      const a=attempts.find(x=>x.attempt_id===receipt.attempt_id);
      requireIntegrity(a&&a.state==='RECEIVED'&&receipt.workflow_run_id===d.workflow_run_id&&receipt.claim_id===a.claim_id&&receipt.claim_generation===a.claim_generation
        &&receipt.packet_digest===d.packet_digest&&receipt.receiver_realm===d.receiver_realm&&receipt.task_id===d.notification_id
        &&Number.isSafeInteger(receipt.event_id)&&integer(receipt.event_id)>0&&[200,201].includes(integer(receipt.http_status))
        &&receipt.idempotent_replay===(receipt.http_status===200?1:0));
    }
    requireIntegrity(attempts.filter(a=>a.state==='RECEIVED').length===receipts.length&&(d.state==='DELIVERED')===(receipts.length>0));
    const audits=tx.all('SELECT record_digest FROM notification_delivery_audit WHERE delivery_id=?',d.delivery_id);
    requireIntegrity(audits.length===d.revision&&audits.filter(a=>a.record_digest===digest(d)).length===1);
  }
  #packet(source:NotificationSource,d:Row):MacpNotificationPacket {
    const packet=notificationInput(parseJson<MacpNotificationPacket>(d.packet_json),4096);
    requireIntegrity(d.workflow_run_id===source.workflowRunId&&d.source_id===source.sourceId&&d.notification_id===source.notificationId
      &&d.packet_digest===digest(packet)&&d.template_version===DURABLE_NOTIFICATION_CONTRACT
      &&canonicalJson(packet)===canonicalJson(sourcePacket(source))&&d.packet_json===canonicalJson(packet));
    return packet;
  }
  #write(tx:DurableTransaction,table:string,row:Row,old?:Row):void { this.#deps.scopedWrite(tx,table,row,old); }
  #audit(tx:DurableTransaction,eventKind:string,actor:string,row:Row,reason:string,attemptId:string|null=null):void {
    this.#write(tx,'notification_delivery_audit',{audit_id:randomUUID(),workflow_run_id:row.workflow_run_id,
      source_id:row.source_id??null,delivery_id:row.delivery_id??null,attempt_id:attemptId,event_kind:eventKind,
      actor_id:actor,reason,record_digest:digest(row),recorded_at:now(tx)});
  }
  #update(tx:DurableTransaction,old:Row,changes:Record<string,Row[string]>,actor:string,event:string,reason:string,attemptId:string|null=null):Row {
    const row={...old,...changes,revision:integer(old.revision)+1,updated_at:now(tx)};
    requireIntegrity(integer(row.updated_at)>=integer(old.updated_at));
    this.#write(tx,'notification_deliveries',row,old);this.#audit(tx,event,actor,row,reason,attemptId);return row;
  }
  #same(old:Row,current:Row|undefined):asserts current is Row {
    if(!current||canonicalJson(old)!==canonicalJson(current))throw new DurableStoreError('NOTIFICATION_CONFLICT');
  }
  #unknown(tx:DurableTransaction,deliveryId:Row[string],excludingAttempt:Row[string]|null=null):boolean {
    return !!tx.get("SELECT attempt_id FROM notification_delivery_attempts WHERE delivery_id=? AND state IN ('SENDING','SEND_OUTCOME_UNKNOWN') AND (? IS NULL OR attempt_id<>?) LIMIT 1",deliveryId,excludingAttempt,excludingAttempt);
  }
  #binding(entry:Entry,b:BoundNotificationDestination|undefined):asserts b is BoundNotificationDestination {
    if(!b)throw new DurableStoreError('NOTIFICATION_UNAVAILABLE');
    if(entry.source.ownerSubject!==null&&entry.source.ownerSubject!==b.destination.recipientSubject)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const d=entry.delivery;
    if(d&&(d.binding_digest!==b.bindingDigest||d.destination_id!==b.destination.destinationId||d.receiver_realm!==b.destination.receiverRealm
      ||d.audience!==b.destination.audience||d.recipient_subject!==b.destination.recipientSubject))throw new DurableStoreError('NOTIFICATION_UNAVAILABLE');
  }
  #view(tx:DurableTransaction,e:Entry):NotificationView {
    const s=e.source,d=e.delivery;
    const disposition=notificationSourceDisposition(tx,s);
    const receipts=d?tx.all('SELECT * FROM notification_delivery_receipts WHERE delivery_id=? ORDER BY received_at,receipt_id',d.delivery_id).map(r=>({
      receiptId:r.receipt_id,attemptId:r.attempt_id,taskId:r.task_id,eventId:r.event_id,httpStatus:r.http_status,
      idempotentReplay:r.idempotent_replay===1,receiverRealm:r.receiver_realm,packetDigest:r.packet_digest,receivedAt:r.received_at})):[];
    return {sourceId:s.sourceId,notificationId:s.notificationId,workflowRunId:s.workflowRunId,kind:s.kind,position:0,occurredAt:s.occurredAt,
      ownerSubject:s.ownerSubject,state:d?d.state as NotificationView['state']:'UNROUTED',
      necessity:disposition.disposition==='SUPPRESS'?'RESOLVED':disposition.disposition==='DEFER'?'UNKNOWN':d?.necessity==='CANCELLED'?'CANCELLED':'REQUIRED',
      deliveryId:d?text(d.delivery_id):null,destinationId:d?text(d.destination_id):null,receiverRealm:d?text(d.receiver_realm):null,
      recipientSubject:d?text(d.recipient_subject):null,revision:d?integer(d.revision):0,attempts:d?integer(d.attempt_count):0,
      nextAttemptAt:d?integer(d.next_attempt_at):null,stopReason:d?d.stop_reason as string|null:!this.#authority.enabled?'DELIVERY_DISABLED':'DESTINATION_UNCONFIGURED',
      outcomeUnknown:d?.outcome_unknown===1,packet:d?this.#packet(s,d):null,receipts,
      attemptHistory:d?tx.all('SELECT * FROM notification_delivery_attempts WHERE delivery_id=? ORDER BY attempt_number',d.delivery_id).map(a=>({
        attemptId:a.attempt_id,attempt:a.attempt_number,claimGeneration:a.claim_generation,state:a.state,startedAt:a.started_at,finishedAt:a.finished_at,errorCode:a.error_code,httpStatus:a.http_status})):[],executionAllowed:false};
  }
  read(credential:unknown,input:NotificationReadInput):NotificationPage {
    const query=notificationInput(input),workflow=this.#workflow(query.workflowRunId);
    if(Object.keys(query).some(k=>!['workflowRunId','cursor','limit','includeAudit'].includes(k)))throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const limit=query.limit??this.limits.pageSize,cursor=query.cursor??0;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(cursor)||cursor<0||query.includeAudit!==undefined&&typeof query.includeAudit!=='boolean')throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    this.#authority.check(credential,'VIEW_NOTIFICATION',this.#target(workflow));
    // A coarse workflow permission is not permission to know every owner's rows.
    // Scan only routing metadata, outside all body/provenance parsing, then paginate
    // authorized ordinals. Physical sequence gaps and denied look-ahead rows never
    // become a cursor, count, or error visible to the caller.
    const metadata=this.#deps.read(tx=>tx.all('SELECT s.source_id,s.owner_subject,d.recipient_subject,d.audience,d.receiver_realm,d.destination_id FROM notification_sources s LEFT JOIN notification_deliveries d ON d.source_id=s.source_id WHERE s.workflow_run_id=? ORDER BY s.source_sequence',workflow));
    const selected:Array<{sourceId:string;position:number}>=[];let visible=0;
    for(const row of metadata){
      const target:NotificationTarget={workflowRunId:workflow,ownerSubject:row.owner_subject as string|null,recipientSubject:row.recipient_subject as string|null,
        audience:row.audience as string|null,receiverRealm:row.receiver_realm as string|null,destinationId:row.destination_id as string|null};
      try {this.#authority.check(credential,'VIEW_NOTIFICATION',target);}
      catch(error){if(error instanceof DurableStoreError&&error.code==='NOTIFICATION_UNAUTHORIZED')continue;throw error;}
      visible++;if(visible<=cursor)continue;
      selected.push({sourceId:text(row.source_id),position:visible});if(selected.length>limit)break;
    }
    const rows=this.#deps.read(tx=>selected.slice(0,limit).map(({sourceId,position})=>{
      const e=this.#entry(tx,sourceId),view=this.#view(tx,e);view.position=position;
      if(query.includeAudit)view.audit=tx.all('SELECT event_kind,actor_id,reason,record_digest,recorded_at FROM notification_delivery_audit WHERE source_id=? ORDER BY recorded_at,audit_id',e.source.sourceId);
      return {e,view};}));
    for(const {e,view} of rows)this.#authority.output(credential,this.#target(workflow,e.source,e.delivery),view,query.includeAudit);
    const baseline=this.#deps.read(tx=>tx.get('SELECT baseline_digest,journal_sequence FROM notification_migration_baselines WHERE workflow_run_id=?',workflow));
    const items=rows.slice(0,limit).map(x=>x.view),outstanding=items.filter(x=>!terminal.has(x.state)),reasons=new Map<string,number>();
    for(const item of outstanding)if(item.stopReason)reasons.set(item.stopReason,(reasons.get(item.stopReason)??0)+1);
    const page:NotificationPage={items,nextCursor:selected.length>limit?cursor+items.length:null,executionAllowed:false,
      baseline:baseline?{digest:text(baseline.baseline_digest),journalSequence:integer(baseline.journal_sequence)}:null,
      summary:{scope:'PAGE',sourceCount:items.length,outstandingCount:outstanding.length,unroutedCount:items.filter(x=>x.state==='UNROUTED').length,
        unknownCount:items.filter(x=>x.outcomeUnknown).length,oldestOutstandingAt:outstanding.length?Math.min(...outstanding.map(x=>x.occurredAt)):null,
        stopReasons:[...reasons].sort(([a],[b])=>a.localeCompare(b)).map(([reason,count])=>({reason,count}))}};
    return this.#authority.output(credential,this.#target(workflow),page,query.includeAudit);
  }
  materialize(credential:unknown,input:{workflowRunId:string;limit?:number}):NotificationPage {
    const query=notificationInput(input),workflow=this.#workflow(query.workflowRunId),limit=query.limit??this.limits.batchSize;
    if(Object.keys(query).some(k=>!['workflowRunId','limit'].includes(k))||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    this.#service(credential,'MATERIALIZE_NOTIFICATION',this.#target(workflow));
    let binding:BoundNotificationDestination|undefined;
    try { binding=this.#authority.resolve(workflow); } catch { return this.read(credential,{workflowRunId:workflow}); }
    if(!binding)return this.read(credential,{workflowRunId:workflow});
    const entries=this.#deps.read(tx=>tx.all('SELECT s.source_id FROM notification_sources s LEFT JOIN notification_deliveries d ON d.source_id=s.source_id WHERE s.workflow_run_id=? AND d.delivery_id IS NULL ORDER BY s.source_sequence LIMIT ?',workflow,limit).map(r=>this.#entry(tx,text(r.source_id))));
    for(const entry of entries){
      this.#binding(entry,binding);
      const target=this.#target(workflow,entry.source,undefined,binding),packet=notificationInput(sourcePacket(entry.source),4096);
      this.#service(credential,'MATERIALIZE_NOTIFICATION',target);this.#authority.checkOutput(credential,'MATERIALIZE_NOTIFICATION',target,packet);
      const actor=this.#service(credential,'MATERIALIZE_NOTIFICATION',target).actor;
      this.#deps.write('DELIVERY',workflow,tx=>{
        const current=this.#entry(tx,entry.source.sourceId);
        if(current.delivery)return;
        requireIntegrity(digest(current.source)===digest(entry.source));
        const capacity=integer(tx.get("SELECT count(*) AS count FROM notification_deliveries WHERE state NOT IN ('DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED')")!.count);
        if(capacity>=this.limits.maxMaterialized)return;
        const disposition=notificationSourceDisposition(tx,current.source),at=now(tx),b=binding!;
        const row:Row={delivery_id:`delivery-${entry.source.notificationId}`,workflow_run_id:workflow,source_id:entry.source.sourceId,notification_id:entry.source.notificationId,
          destination_id:b.destination.destinationId,binding_digest:b.bindingDigest,receiver_realm:b.destination.receiverRealm,audience:b.destination.audience,recipient_subject:b.destination.recipientSubject,
          packet_json:canonicalJson(packet),packet_digest:digest(packet),template_version:DURABLE_NOTIFICATION_CONTRACT,
          state:disposition.disposition==='SUPPRESS'?'SUPPRESSED':disposition.disposition==='DEFER'||!this.#authority.enabled?'PAUSED':'PENDING',
          necessity:disposition.disposition==='SUPPRESS'?'RESOLVED':disposition.disposition==='DEFER'?'UNKNOWN':'REQUIRED',revision:1,attempt_count:0,auto_attempt_count:0,
          next_attempt_at:at,horizon_at:at+this.limits.retryHorizonMs,created_at:at,updated_at:at,
          stop_reason:!this.#authority.enabled?'DELIVERY_DISABLED':disposition.disposition==='SEND'?null:disposition.reason,
          outcome_unknown:0,management_paused:0,claim_generation:0};
        this.#write(tx,'notification_deliveries',row);this.#audit(tx,'NOTIFICATION_MATERIALIZED',actor.subjectId,row,'MATERIALIZED');
      });
    }
    return this.read(credential,{workflowRunId:workflow});
  }
  manage(credential:unknown,input:NotificationManagementCommand):NotificationPage {
    const command=notificationInput(input),workflow=this.#workflow(command.workflowRunId);
    if(Object.keys(command).length!==8||!Object.hasOwn(permissions,command.operation)||![command.deliveryId,command.ownerSubject,command.destinationId,command.requestId].every(notificationId)
      ||!Number.isSafeInteger(command.expectedRevision)||command.expectedRevision<1||command.reason!=='OPERATOR_REQUEST')throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const permission=permissions[command.operation];this.#authority.check(credential,permission,this.#target(workflow));
    const metadata=this.#deps.read(tx=>tx.get('SELECT d.source_id,s.owner_subject,d.recipient_subject,d.audience,d.receiver_realm,d.destination_id FROM notification_deliveries d JOIN notification_sources s ON s.source_id=d.source_id WHERE d.workflow_run_id=? AND d.delivery_id=?',workflow,command.deliveryId));
    if(!metadata)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    this.#authority.check(credential,permission,{workflowRunId:workflow,ownerSubject:metadata.owner_subject as string|null,recipientSubject:metadata.recipient_subject as string|null,
      audience:metadata.audience as string|null,receiverRealm:metadata.receiver_realm as string|null,destinationId:metadata.destination_id as string|null});
    const entry=this.#deps.read(tx=>this.#entry(tx,text(metadata.source_id)));
    const target=this.#target(workflow,entry.source,entry.delivery);
    if(command.ownerSubject!==target.recipientSubject||command.destinationId!==target.destinationId)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const access=this.#authority.check(credential,permission,target),commandDigest=digest(command);
    this.#authority.output(credential,target,this.#deps.read(tx=>this.#view(tx,entry)));
    if(['RESUME','RETRY'].includes(command.operation))this.#binding(entry,this.#authority.resolve(workflow));
    const currentAccess=this.#authority.check(credential,permission,target);
    if(currentAccess.actor.subjectId!==access.actor.subjectId)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    this.#deps.write('DELIVERY',workflow,tx=>{
      const previous=tx.get('SELECT * FROM notification_management_receipts WHERE actor_id=? AND request_id=?',access.actor.subjectId,command.requestId);
      if(previous){if(previous.command_digest!==commandDigest||previous.workflow_run_id!==workflow)throw new DurableStoreError('NOTIFICATION_CONFLICT');return;}
      const d=tx.get('SELECT * FROM notification_deliveries WHERE delivery_id=?',command.deliveryId);this.#same(entry.delivery!,d);
      if(d.revision!==command.expectedRevision||terminal.has(text(d.state)))throw new DurableStoreError('NOTIFICATION_CONFLICT');
      let changes:Record<string,Row[string]>;
      const unknown=this.#unknown(tx,d.delivery_id);
      if(command.operation==='PAUSE')changes={state:'PAUSED',management_paused:1,stop_reason:'OPERATOR_PAUSED',outcome_unknown:unknown?1:0};
      else if(command.operation==='CLOSE')changes={state:unknown?'CLOSED_UNCONFIRMED':'SUPPRESSED',necessity:'CANCELLED',management_paused:1,stop_reason:'OPERATOR_CLOSED',outcome_unknown:unknown?1:0};
      else {
        if(integer(d.attempt_count)>=this.limits.lifetimeAttempts||now(tx)>=integer(d.horizon_at)||d.state==='SENDING')throw new DurableStoreError('NOTIFICATION_CONFLICT');
        if(command.operation==='RESUME'&&integer(d.auto_attempt_count)>=this.limits.automaticAttempts)throw new DurableStoreError('NOTIFICATION_CONFLICT');
        changes={state:'PENDING',management_paused:0,stop_reason:null,next_attempt_at:now(tx)};
      }
      const row=this.#update(tx,d,changes,access.actor.subjectId,`NOTIFICATION_${command.operation==='CLOSE'?'MANUALLY_CLOSED':command.operation==='RETRY'?'RETRY_REQUESTED':command.operation==='PAUSE'?'PAUSED':'RESUMED'}`,'OPERATOR_REQUEST');
      this.#write(tx,'notification_management_receipts',{receipt_id:randomUUID(),workflow_run_id:workflow,actor_id:access.actor.subjectId,request_id:command.requestId,
        command_digest:commandDigest,command_json:canonicalJson(command),result_json:canonicalJson({deliveryId:row.delivery_id,revision:row.revision,state:row.state}),created_at:now(tx)});
    });
    return this.read(credential,{workflowRunId:workflow});
  }
  syncUnresolved(credential:unknown,input:NotificationSyncCommand):NotificationPage {
    const command=notificationInput(input),workflow=this.#workflow(command.workflowRunId);
    if(Object.keys(command).length!==5||![command.ownerSubject,command.destinationId,command.requestId].every(notificationId)||typeof command.expectedBaseline!=='string'||!/^[a-f0-9]{64}$/.test(command.expectedBaseline))throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    this.#authority.check(credential,'SYNC_UNRESOLVED_NOTIFICATIONS',this.#target(workflow));
    const binding=this.#authority.resolve(workflow);
    if(!binding||binding.destination.recipientSubject!==command.ownerSubject||binding.destination.destinationId!==command.destinationId)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const target=this.#target(workflow,undefined,undefined,binding),access=this.#authority.check(credential,'SYNC_UNRESOLVED_NOTIFICATIONS',target);
    this.#authority.output(credential,target,{workflowRunId:workflow,executionAllowed:false});
    const currentAccess=this.#authority.check(credential,'SYNC_UNRESOLVED_NOTIFICATIONS',target);
    if(currentAccess.actor.subjectId!==access.actor.subjectId)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const commandDigest=digest(command);
    this.#deps.write('LEGACY_SYNC',workflow,tx=>{
      const previous=tx.get('SELECT * FROM notification_management_receipts WHERE actor_id=? AND request_id=?',access.actor.subjectId,command.requestId);
      if(previous){if(previous.command_digest!==commandDigest||previous.workflow_run_id!==workflow)throw new DurableStoreError('NOTIFICATION_CONFLICT');return;}
      const ids=syncLegacyNotificationSources(tx,workflow,command.expectedBaseline,(table,row,old)=>this.#write(tx,table,row,old),access.actor.subjectId);
      for(const id of ids){const s=readNotificationSource(tx,id);if(s.ownerSubject!==null&&s.ownerSubject!==command.ownerSubject)throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');}
      this.#write(tx,'notification_management_receipts',{receipt_id:randomUUID(),workflow_run_id:workflow,actor_id:access.actor.subjectId,request_id:command.requestId,
        command_digest:commandDigest,command_json:canonicalJson(command),result_json:canonicalJson({sourceIds:ids}),created_at:now(tx)});
    });
    return this.read(credential,{workflowRunId:workflow});
  }
  #first(workflow:string):Entry|undefined {
    return this.#deps.read(tx=>{const row=tx.get("SELECT s.source_id FROM notification_sources s LEFT JOIN notification_deliveries d ON d.source_id=s.source_id WHERE s.workflow_run_id=? AND (d.delivery_id IS NULL OR d.state NOT IN ('DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED')) ORDER BY s.source_sequence LIMIT 1",workflow);return row?this.#entry(tx,text(row.source_id)):undefined;});
  }
  #pause(entry:Entry,actor:string,reason:string):void {
    const d=entry.delivery!;
    this.#deps.write('DELIVERY',entry.source.workflowRunId,tx=>{
      const current=tx.get('SELECT * FROM notification_deliveries WHERE delivery_id=?',d.delivery_id);this.#same(d,current);
      if(!terminal.has(text(d.state))&&d.state!=='SENDING')this.#update(tx,d,{state:'PAUSED',stop_reason:reason},actor,'NOTIFICATION_PAUSED',reason);
    });
  }
  #reconcileNecessity(entry:Entry,actor:string):boolean {
    const disposition=this.#deps.read(tx=>notificationSourceDisposition(tx,entry.source));
    if(disposition.disposition==='SEND')return true;
    const d=entry.delivery!;
    this.#deps.write('DELIVERY',entry.source.workflowRunId,tx=>{
      const current=tx.get('SELECT * FROM notification_deliveries WHERE delivery_id=?',d.delivery_id);this.#same(d,current);
      const check=notificationSourceDisposition(tx,entry.source);if(check.disposition==='SEND')throw new DurableStoreError('NOTIFICATION_CONFLICT');
      const unknown=this.#unknown(tx,d.delivery_id);
      this.#update(tx,d,{state:check.disposition==='DEFER'?'PAUSED':unknown?'CLOSED_UNCONFIRMED':'SUPPRESSED',necessity:check.disposition==='DEFER'?'UNKNOWN':'RESOLVED',stop_reason:check.reason,outcome_unknown:unknown?1:0},actor,
        check.disposition==='DEFER'?'NOTIFICATION_PAUSED':unknown?'NOTIFICATION_CLOSED_UNCONFIRMED':'NOTIFICATION_SUPPRESSED',check.reason);
    });return false;
  }
  #claim(entry:Entry,actor:string):Permit|undefined {
    const d=entry.delivery!,workflow=entry.source.workflowRunId;
    const value=this.#deps.write('DELIVERY',workflow,tx=>{
      let current=tx.get('SELECT * FROM notification_deliveries WHERE delivery_id=?',d.delivery_id);this.#same(d,current);
      const at=now(tx),delta=Date.now()-this.#time.wall,monotonic=performance.now()-this.#time.monotonic;
      if(delta<0||Math.abs(delta-monotonic)>5000)throw new DurableStoreError('NOTIFICATION_FENCED');
      this.#time={wall:Date.now(),monotonic:performance.now()};
      const first=tx.get("SELECT s.source_id FROM notification_sources s LEFT JOIN notification_deliveries d ON d.source_id=s.source_id WHERE s.workflow_run_id=? AND (d.delivery_id IS NULL OR d.state NOT IN ('DELIVERED','SUPPRESSED','CLOSED_UNCONFIRMED')) ORDER BY s.source_sequence LIMIT 1",workflow);
      if(first?.source_id!==entry.source.sourceId)return;
      requireIntegrity(notificationSourceDisposition(tx,entry.source).disposition==='SEND');this.#packet(entry.source,current);
      const streamKey=digest([workflow,current.destination_id]),oldClaim=tx.get('SELECT * FROM notification_stream_claims WHERE stream_key=?',streamKey);
      if(oldClaim&&integer(oldClaim.expires_at)>at)return;
      if(integer(tx.get('SELECT count(*) AS count FROM notification_stream_claims WHERE expires_at>?',at)!.count)>=this.limits.concurrency)return;
      // Expiry closes the previous generation even when management closed/paused its
      // delivery while HTTP was in flight. It cannot remain an immortal SENDING fact.
      const expired=oldClaim?tx.get("SELECT * FROM notification_delivery_attempts WHERE claim_id=? AND state='SENDING'",oldClaim.claim_id):undefined;
      if(expired){
        this.#write(tx,'notification_delivery_attempts',{...expired,state:'SEND_OUTCOME_UNKNOWN',finished_at:at,error_code:'CLAIM_EXPIRED'},expired);
        const prior=tx.get('SELECT * FROM notification_deliveries WHERE delivery_id=?',expired.delivery_id);requireIntegrity(prior);
        const updated=this.#update(tx,prior,{state:prior.state==='SENDING'?'RETRY_WAIT':prior.state,outcome_unknown:1,stop_reason:'CLAIM_EXPIRED',next_attempt_at:at},actor,'NOTIFICATION_RETRY_SCHEDULED','CLAIM_EXPIRED',text(expired.attempt_id));
        if(prior.delivery_id===current.delivery_id)current=updated;
      }
      else if(current.state==='SENDING')throw new DurableStoreError('INTEGRITY_ERROR');
      if(current.management_paused===1||!['PENDING','RETRY_WAIT'].includes(text(current.state))||integer(current.next_attempt_at)>at)return;
      if(integer(current.attempt_count)>=this.limits.lifetimeAttempts||at>=integer(current.horizon_at)
        ||current.state==='RETRY_WAIT'&&integer(current.auto_attempt_count)>=this.limits.automaticAttempts){
        this.#update(tx,current,{state:'DELIVERY_FAILED',stop_reason:at>=integer(current.horizon_at)?'RETRY_HORIZON':'ATTEMPT_LIMIT'},actor,'NOTIFICATION_DELIVERY_FAILED','ATTEMPT_LIMIT');return;
      }
      const generation=integer(oldClaim?.generation??0)+1,attemptNumber=integer(current.attempt_count)+1,claimId=randomUUID(),attemptId=randomUUID();
      const updated=this.#update(tx,current,{state:'SENDING',attempt_count:attemptNumber,auto_attempt_count:integer(current.auto_attempt_count)+1,claim_generation:generation,stop_reason:null},actor,'NOTIFICATION_ATTEMPT_CLAIMED','CLAIMED');
      const claim:Row={stream_key:streamKey,workflow_run_id:workflow,destination_id:current.destination_id,delivery_id:current.delivery_id,claim_id:claimId,worker_id:this.#workerId,generation,
        expires_at:at+this.limits.claimTtlMs,delivery_revision:updated.revision,packet_digest:current.packet_digest,binding_digest:current.binding_digest};
      this.#write(tx,'notification_stream_claims',claim,oldClaim);
      const attempt:Row={attempt_id:attemptId,delivery_id:current.delivery_id,workflow_run_id:workflow,attempt_number:attemptNumber,claim_id:claimId,claim_generation:generation,worker_id:this.#workerId,
        state:'SENDING',started_at:at,finished_at:null,error_code:null,http_status:null};
      this.#write(tx,'notification_delivery_attempts',attempt);
      return {delivery:updated,claim,attempt,source:entry.source,issued:performance.now()};
    });
    // Deliberately outside the transaction: an ACK-lost COMMIT cannot mint this permit.
    if(value)this.#permits.add(value);return value;
  }
  #currentPermit(tx:DurableTransaction,p:Permit):Row {
    const claim=tx.get('SELECT * FROM notification_stream_claims WHERE stream_key=?',p.claim.stream_key),at=now(tx);
    if(!claim||canonicalJson(claim)!==canonicalJson(p.claim)||integer(claim.expires_at)<=at||performance.now()-p.issued>=this.limits.claimTtlMs)throw new DurableStoreError('NOTIFICATION_FENCED');
    const d=tx.get('SELECT * FROM notification_deliveries WHERE delivery_id=?',p.delivery.delivery_id);
    requireIntegrity(d&&d.claim_generation===p.claim.generation&&d.packet_digest===p.claim.packet_digest&&d.binding_digest===p.claim.binding_digest);
    this.#packet(p.source,d);return d;
  }
  #finish(credential:unknown,p:Permit,result:NotificationDeliveryReceipt|Failure):void {
    const target=this.#target(p.source.workflowRunId,p.source,p.delivery);
    const actor=this.#service(credential,'COLLECT_NOTIFICATION_RECEIPT',target).actor,received='taskId'in result;
    const existing=this.#deps.read(tx=>tx.get('SELECT * FROM notification_delivery_receipts WHERE attempt_id=?',p.attempt.attempt_id));
    if(existing){requireIntegrity(received&&existing.task_id===result.taskId&&existing.event_id===result.eventId&&existing.packet_digest===p.delivery.packet_digest&&existing.claim_id===p.claim.claim_id);return;}
    const commit=()=>this.#deps.write('DELIVERY',p.source.workflowRunId,tx=>{
      const d=this.#currentPermit(tx,p),a=tx.get('SELECT * FROM notification_delivery_attempts WHERE attempt_id=?',p.attempt.attempt_id);this.#same(p.attempt,a);
      const at=now(tx);let changes:Record<string,Row[string]>,state:string;
      if(received){
        state='RECEIVED';changes={state:'DELIVERED',outcome_unknown:0,stop_reason:null};
        this.#write(tx,'notification_delivery_receipts',{receipt_id:randomUUID(),delivery_id:d.delivery_id,workflow_run_id:d.workflow_run_id,attempt_id:a.attempt_id,
          claim_id:p.claim.claim_id,claim_generation:p.claim.generation,packet_digest:d.packet_digest,receiver_realm:d.receiver_realm,task_id:result.taskId,event_id:result.eventId,
          http_status:result.httpStatus,idempotent_replay:result.idempotentReplay?1:0,received_at:at});
      }else{
        const unknown=!result.notSent&&(result.status===null||result.status===200||result.status===201||result.status>=500||result.code==='INVALID_RESPONSE');
        state=result.notSent?'NOT_SENT_PROVEN':unknown?'SEND_OUTCOME_UNKNOWN':'REJECTED';
        const outcomeUnknown=this.#unknown(tx,d.delivery_id,a.attempt_id)||unknown;
        const disposition=notificationSourceDisposition(tx,p.source),resolved=disposition.disposition==='SUPPRESS'||d.necessity==='CANCELLED';
        let nextState=resolved?outcomeUnknown?'CLOSED_UNCONFIRMED':'SUPPRESSED':d.management_paused===1?'PAUSED':result.notSent?'PAUSED':result.retryable&&integer(d.auto_attempt_count)<this.limits.automaticAttempts&&integer(d.attempt_count)<this.limits.lifetimeAttempts&&at<integer(d.horizon_at)?'RETRY_WAIT':'DELIVERY_FAILED';
        if(disposition.disposition==='DEFER'&&!resolved)nextState='PAUSED';
        if(!resolved&&(result.status===401||result.status===403||result.status===409))nextState='PAUSED';
        if(terminal.has(text(d.state)))nextState=d.state==='CLOSED_UNCONFIRMED'&&!outcomeUnknown?'SUPPRESSED':text(d.state);
        const delay=Math.min(this.limits.backoffMaxMs,this.limits.backoffBaseMs*2**Math.min(integer(d.attempt_count)-1,10));
        changes={state:nextState,outcome_unknown:outcomeUnknown?1:0,next_attempt_at:at+delay,stop_reason:result.code,necessity:resolved?d.necessity==='CANCELLED'?'CANCELLED':'RESOLVED':disposition.disposition==='DEFER'?'UNKNOWN':'REQUIRED'};
      }
      this.#write(tx,'notification_delivery_attempts',{...a,state,finished_at:at,error_code:received?null:result.code,http_status:received?result.httpStatus:result.status},a);
      this.#update(tx,d,changes,actor.subjectId,received?'NOTIFICATION_RECEIPT_RECORDED':changes.state==='RETRY_WAIT'?'NOTIFICATION_RETRY_SCHEDULED':'NOTIFICATION_ATTEMPT_FINISHED',received?'RECEIVED':result.code,text(a.attempt_id));
      this.#write(tx,'notification_stream_claims',{...p.claim,expires_at:0},p.claim);
    });
    try { commit(); }
    catch(error){
      // Only exact persisted receipt recovery; never send or reconstruct a permit here.
      if(!received)throw error;
      this.#service(credential,'COLLECT_NOTIFICATION_RECEIPT',target);
      const r=this.#deps.read(tx=>tx.get('SELECT * FROM notification_delivery_receipts WHERE attempt_id=?',p.attempt.attempt_id));
      if(!r||r.task_id!==result.taskId||r.event_id!==result.eventId||r.claim_id!==p.claim.claim_id||r.claim_generation!==p.claim.generation||r.packet_digest!==p.delivery.packet_digest||r.receiver_realm!==p.delivery.receiver_realm)throw error;
    }
  }
  #failure(error:unknown,notSent=false):Failure {
    if(error&&typeof error==='object'&&!utilTypes.isProxy(error)&&error instanceof DeliveryError){
      const descriptors=Object.getOwnPropertyDescriptors(error);
      const code=descriptors.code,retry=descriptors.retryable,status=descriptors.httpStatus;
      if(code&&'value'in code&&retry&&'value'in retry&&(!status||'value'in status)
        &&['NOTIFICATION_DELIVERY_FAILED','INVALID_CONFIGURATION','INVALID_RESPONSE','SNAPSHOT_UNAVAILABLE','NETWORK_ERROR','TIMEOUT','ABORTED','HTTP_ERROR'].includes(code.value))
        return {code:code.value,retryable:retry.value===true,status:Number.isSafeInteger(status?.value)&&status!.value>=100&&status!.value<=599?status!.value:null,notSent};
    }
    return {code:notSent?'PREFLIGHT_REJECTED':'NETWORK_ERROR',retryable:!notSent,status:null,notSent};
  }
  async #send(credential:unknown,p:Permit,signal?:AbortSignal):Promise<void> {
    if(!this.#permits.has(p))throw new DurableStoreError('NOTIFICATION_FENCED');
    const target=this.#target(p.source.workflowRunId,p.source,p.delivery);
    let binding:BoundNotificationDestination;
    try {
      if(signalAborted(signal))throw new DeliveryError('ABORTED');
      const e={source:p.source,delivery:p.delivery},b=this.#authority.resolve(p.source.workflowRunId);this.#binding(e,b);binding=b;
      this.#service(credential,'COLLECT_NOTIFICATION_RECEIPT',target);
      // OUTPUT/ACL callbacks must not swap the transport implementation after its first check.
      const currentBinding=this.#authority.resolve(p.source.workflowRunId);this.#binding(e,currentBinding);binding=currentBinding;
      this.#authority.sendOutput(credential,target,this.#packet(p.source,p.delivery));
      const outputCheckedBinding=this.#authority.resolve(p.source.workflowRunId);this.#binding(e,outputCheckedBinding);binding=outputCheckedBinding;
      this.#service(credential,'SEND_NOTIFICATION',target);
      this.#authority.assertUnchanged(binding);
      this.#deps.read(tx=>{const d=this.#currentPermit(tx,p);if(d.state!=='SENDING'||d.management_paused===1||notificationSourceDisposition(tx,p.source).disposition!=='SEND')throw new DurableStoreError('NOTIFICATION_FENCED');});
    } catch(error){this.#permits.delete(p);this.#finish(credential,p,this.#failure(error,true));return;}
    this.#permits.delete(p); // Consumed synchronously before any transport/user callback.
    const controller=new AbortController(),abort=()=>controller.abort();if(signal)EventTarget.prototype.addEventListener.call(signal,'abort',abort,{once:true});
    const started=performance.now();let timer:ReturnType<typeof setTimeout>|undefined;let result:NotificationDeliveryReceipt|Failure;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DeliveryError('TIMEOUT',true));},this.limits.httpTimeoutMs);});
    try {
      if(signalAborted(signal))throw new DeliveryError('ABORTED');
      const raw=this.#deps.outside(()=>Reflect.apply(binding.send,binding.destination.transport,[this.#packet(p.source,p.delivery),controller.signal]));
      let response:Promise<NotificationDeliveryReceipt|void>;
      try {response=nativeVerifierPromise(raw);}catch{throw new DeliveryError('INVALID_RESPONSE');}
      const reply=await Promise.race([response,timeout]);
      if(performance.now()-started>=this.limits.httpTimeoutMs)throw new DeliveryError('TIMEOUT',true);
      let r:NotificationDeliveryReceipt;
      try {r=notificationInput(reply,65536) as NotificationDeliveryReceipt;}catch{throw new DeliveryError('INVALID_RESPONSE');}
      if(!r||r.taskId!==p.delivery.notification_id||!Number.isSafeInteger(r.eventId)||r.eventId<=0||![200,201].includes(r.httpStatus)||r.idempotentReplay!==(r.httpStatus===200))throw new DeliveryError('INVALID_RESPONSE');
      result={taskId:r.taskId,eventId:r.eventId,idempotentReplay:r.idempotentReplay,httpStatus:r.httpStatus};
      if(performance.now()-started>=this.limits.httpTimeoutMs)throw new DeliveryError('TIMEOUT',true);
    } catch(error){result=this.#failure(error);}
    finally{if(timer)clearTimeout(timer);if(signal)EventTarget.prototype.removeEventListener.call(signal,'abort',abort);}
    this.#finish(credential,p,result);
  }
  async runOnce(credential:unknown,input:{workflowRunId:string;signal?:AbortSignal}):Promise<NotificationPage> {
    // AbortSignal is a host object, not part of a client supplied JSON command.
    if(!input||utilTypes.isProxy(input)||Object.values(Object.getOwnPropertyDescriptors(input)).some(d=>!('value'in d)))throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    const workflow=this.#workflow(input.workflowRunId);
    if(Object.keys(input).some(k=>!['workflowRunId','signal'].includes(k)))throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED');
    signalAborted(input.signal);
    this.#service(credential,'CLAIM_NOTIFICATION_DELIVERY',this.#target(workflow));
    if(this.#inflight>=this.limits.concurrency)return this.read(credential,{workflowRunId:workflow});
    this.#inflight++;
    try {
      this.materialize(credential,{workflowRunId:workflow});
      if(!this.#authority.enabled||signalAborted(input.signal))return this.read(credential,{workflowRunId:workflow});
      const e=this.#first(workflow);if(!e?.delivery)return this.read(credential,{workflowRunId:workflow});
      const target=this.#target(workflow,e.source,e.delivery),actor=this.#authority.check(credential,'CLAIM_NOTIFICATION_DELIVERY',target).actor;
      if(!this.#reconcileNecessity(e,actor.subjectId))return this.read(credential,{workflowRunId:workflow});
      if(['PAUSED','DELIVERY_FAILED'].includes(text(e.delivery.state)))return this.read(credential,{workflowRunId:workflow});
      try {this.#binding(e,this.#authority.resolve(workflow));this.#authority.sendOutput(credential,target,this.#packet(e.source,e.delivery));this.#service(credential,'COLLECT_NOTIFICATION_RECEIPT',target);}
      catch(error){this.#pause(e,actor.subjectId,error instanceof DurableStoreError&&error.code==='NOTIFICATION_UNAVAILABLE'?'DESTINATION_CHANGED':'AUTHORIZATION_DENIED');return this.read(credential,{workflowRunId:workflow});}
      const claimActor=this.#service(credential,'CLAIM_NOTIFICATION_DELIVERY',target).actor;
      const p=this.#claim(e,claimActor.subjectId);if(p)await this.#send(credential,p,input.signal);
      return this.read(credential,{workflowRunId:workflow});
    } finally {this.#inflight--;}
  }
}
