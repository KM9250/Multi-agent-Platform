import type { DurableTransaction, Row } from './db';
import type { MacpNotificationPacket } from '../notifications/macpPacket';
import type { NotificationTransport } from '../notifications/transport';

export const DURABLE_NOTIFICATION_CONTRACT = 'COORD-5D:DURABLE_NOTIFICATION:1';
export type NotificationPermission = 'VIEW_NOTIFICATION' | 'VIEW_DELIVERY_AUDIT' | 'SYNC_UNRESOLVED_NOTIFICATIONS'
  | 'PAUSE_NOTIFICATION_DELIVERY' | 'RESUME_NOTIFICATION_DELIVERY' | 'RETRY_NOTIFICATION_DELIVERY' | 'CLOSE_NOTIFICATION_DELIVERY'
  | 'MATERIALIZE_NOTIFICATION' | 'CLAIM_NOTIFICATION_DELIVERY' | 'SEND_NOTIFICATION' | 'COLLECT_NOTIFICATION_RECEIPT';
export interface NotificationActor { subjectId:string; kind:'HUMAN'|'SERVICE'; }
export interface NotificationAccess {
  actor:NotificationActor; permission:NotificationPermission; workflowRunId:string;
  ownerSubject:string|null; recipientSubject:string|null; audience:string|null; receiverRealm:string|null;
  destinationId:string|null;
}
/** Startup dependencies are trusted host code. Never accept these through request DTOs. */
export interface NotificationDestination {
  destinationId:string; bindingVersion:string; implementationDigest:string; receiverRealm:string;
  recipientSubject:string; audience:string; endpoint:string; authenticated:boolean;
  transportContract:'macp/0.1.0'; idempotencyConfirmed:boolean;
  allowDevelopmentLoopback?:boolean; transport:NotificationTransport;
}
export interface NotificationLimits {
  httpTimeoutMs:number; claimTtlMs:number; automaticAttempts:number; lifetimeAttempts:number;
  backoffBaseMs:number; backoffMaxMs:number; retryHorizonMs:number; concurrency:number;
  batchSize:number; pageSize:number; pollIntervalMs:number; maxMaterialized:number;
}
export interface NotificationOptions {
  /** Explicit opt-in for this database deployment; copied databases are disabled by default. */
  enabled?:boolean;
  identityVerifier?:{verify(credential:unknown):NotificationActor|undefined};
  authorize?:(access:NotificationAccess)=>boolean;
  output?:(access:NotificationAccess,value:unknown)=>boolean;
  registry?:{resolve(workflowRunId:string):NotificationDestination|undefined};
  limits?:Partial<NotificationLimits>;
}
export interface NotificationDependencies {
  read<T>(fn:(tx:DurableTransaction)=>T):T;
  write<T>(kind:'DELIVERY'|'LEGACY_SYNC',workflowRunId:string,fn:(tx:DurableTransaction)=>T):T;
  scopedWrite(tx:DurableTransaction,table:string,row:Row,old?:Row):void;
  outside<T>(fn:()=>T):T;
}
export type DurableNotificationState = 'PENDING'|'SENDING'|'RETRY_WAIT'|'DELIVERED'|'SUPPRESSED'|'CLOSED_UNCONFIRMED'|'PAUSED'|'DELIVERY_FAILED';
export type NotificationNecessity = 'REQUIRED'|'RESOLVED'|'SUPERSEDED'|'CANCELLED'|'UNKNOWN';
export interface NotificationView {
  sourceId:string; notificationId:string; workflowRunId:string; kind:string; position:number; occurredAt:number;
  ownerSubject:string|null; state:DurableNotificationState|'UNROUTED'; necessity:NotificationNecessity;
  deliveryId:string|null; destinationId:string|null; receiverRealm:string|null; recipientSubject:string|null;
  revision:number; attempts:number; nextAttemptAt:number|null; stopReason:string|null; outcomeUnknown:boolean;
  packet:MacpNotificationPacket|null; receipts:unknown[]; attemptHistory:unknown[]; audit?:unknown[];
  executionAllowed:false;
}
export interface NotificationReadInput { workflowRunId:string; cursor?:number; limit?:number; includeAudit?:boolean; }
export interface NotificationPage {
  items:NotificationView[]; nextCursor:number|null; executionAllowed:false;
  /** Aggregate only the individually authorized page; follow nextCursor for more. */
  summary:{scope:'PAGE';sourceCount:number;outstandingCount:number;unroutedCount:number;unknownCount:number;
    oldestOutstandingAt:number|null;stopReasons:Array<{reason:string;count:number}>};
}
/** A service cycle acknowledgement, never a delivery receipt or Reader projection. */
export interface NotificationServiceResult {
  workflowRunId:string; operation:'MATERIALIZE'|'RUN_ONCE';
  code:'NOTIFICATION_SERVICE_CYCLE_COMPLETE'; executionAllowed:false;
}
export interface NotificationSyncBaselineInput { workflowRunId:string; ownerSubject:string; destinationId:string; }
/** Workflow-wide migration metadata is available only to the authorized sync operator. */
export interface NotificationSyncBaseline extends NotificationSyncBaselineInput {
  baseline:{digest:string;journalSequence:number}|null; executionAllowed:false;
}
export interface NotificationManagementCommand {
  operation:'PAUSE'|'RESUME'|'RETRY'|'CLOSE'; workflowRunId:string; deliveryId:string;
  ownerSubject:string; destinationId:string; expectedRevision:number; requestId:string; reason:'OPERATOR_REQUEST';
}
export interface NotificationSyncCommand {
  workflowRunId:string; ownerSubject:string; destinationId:string; expectedBaseline:string; requestId:string;
}
