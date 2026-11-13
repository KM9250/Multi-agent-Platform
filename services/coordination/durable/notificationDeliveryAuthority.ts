import { types as utilTypes } from 'node:util';
import { digest, DurableStoreError, requireIntegrity } from './integrity';
import { reconciliationData } from './reconciliationVerifier';
import type { NotificationAccess, NotificationActor, NotificationDependencies, NotificationDestination, NotificationLimits, NotificationOptions, NotificationPermission } from './notificationTypes';

export const notificationId = (v:unknown):v is string => typeof v==='string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(v);
export function notificationInput<T>(v:T,max=16384):T {
  try { return reconciliationData(v,max,20); } catch { throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED'); }
}
export function notificationLimits(input:Partial<NotificationLimits>={}):Readonly<NotificationLimits> {
  const v={httpTimeoutMs:10000,claimTtlMs:30000,automaticAttempts:3,lifetimeAttempts:10,backoffBaseMs:250,
    backoffMaxMs:5000,retryHorizonMs:86400000,concurrency:2,batchSize:100,pageSize:50,pollIntervalMs:2000,maxMaterialized:10000,...notificationInput(input)};
  requireIntegrity(Object.values(v).every(Number.isSafeInteger));
  if (!(v.httpTimeoutMs>0&&v.httpTimeoutMs<=120000&&v.claimTtlMs>=v.httpTimeoutMs+1000&&v.claimTtlMs<=180000
    &&v.automaticAttempts>=1&&v.automaticAttempts<=10&&v.lifetimeAttempts>=v.automaticAttempts&&v.lifetimeAttempts<=10
    &&v.backoffBaseMs>=0&&v.backoffBaseMs<=v.backoffMaxMs&&v.backoffMaxMs<=60000
    &&v.retryHorizonMs>0&&v.retryHorizonMs<=7*86400000&&v.concurrency>=1&&v.concurrency<=8
    &&v.batchSize>=1&&v.batchSize<=1000&&v.pageSize>=1&&v.pageSize<=200
    &&v.pollIntervalMs>=100&&v.pollIntervalMs<=60000&&v.maxMaterialized>=1&&v.maxMaterialized<=100000))
    throw new DurableStoreError('NOTIFICATION_INVALID_CONFIGURATION');
  return Object.freeze(v);
}
export interface BoundNotificationDestination { destination:NotificationDestination; bindingDigest:string; send:NotificationDestination['transport']['send']; }
export type NotificationTarget = Omit<NotificationAccess,'actor'|'permission'>;

/** Each decision re-verifies current identity. No DTO can mint a capability. */
export class NotificationAuthority {
  readonly #verify?:NonNullable<NotificationOptions['identityVerifier']>['verify'];
  readonly #authorize?:NotificationOptions['authorize'];
  readonly #output?:NotificationOptions['output'];
  readonly #resolve?:NonNullable<NotificationOptions['registry']>['resolve'];
  readonly #outside:NotificationDependencies['outside'];
  readonly #observed=new Map<string,{transport:object;send:unknown;digest:string}>();
  readonly #resolved=new WeakMap<BoundNotificationDestination,NotificationDestination>();
  readonly enabled:boolean;
  constructor(deps:NotificationDependencies,options:NotificationOptions={}) {
    this.#outside=deps.outside;this.enabled=options.enabled===true;
    this.#verify=options.identityVerifier?.verify.bind(options.identityVerifier);
    this.#authorize=options.authorize;this.#output=options.output;this.#resolve=options.registry?.resolve.bind(options.registry);
  }
  actor(credential:unknown):NotificationActor {
    // Preserve opaque object identity while rejecting accessors, proxies and thenables before Host code.
    notificationInput(credential,8192);
    try {
      const raw=this.#outside(()=>this.#verify?.(credential));
      if(!raw)throw 0;
      const actor=notificationInput(raw,1024);
      if(Object.keys(actor).length!==2||!notificationId(actor.subjectId)||!['HUMAN','SERVICE'].includes(actor.kind))throw 0;
      return Object.freeze(actor);
    } catch { throw new DurableStoreError('NOTIFICATION_UNAUTHENTICATED'); }
  }
  check(credential:unknown,permission:NotificationPermission,target:NotificationTarget):NotificationAccess {
    const actor=this.actor(credential),access=Object.freeze({...notificationInput(target),actor,permission});
    try { if(this.#outside(()=>this.#authorize?.(access))!==true)throw 0; }
    catch { throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED'); }
    return access;
  }
  output<T>(credential:unknown,target:NotificationTarget,value:T,includeAudit=false):T {
    const access=this.check(credential,'VIEW_NOTIFICATION',target);
    if(includeAudit)this.check(credential,'VIEW_DELIVERY_AUDIT',target);
    const clean=notificationInput(value,4*1024*1024);
    try { if(this.#outside(()=>this.#output?.(access,notificationInput(clean,4*1024*1024)))!==true)throw 0; }
    catch { throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED'); }
    return clean;
  }
  sendOutput(credential:unknown,target:NotificationTarget,packet:unknown):void {
    const access=this.check(credential,'SEND_NOTIFICATION',target),clean=notificationInput(packet,4096);
    try { if(this.#outside(()=>this.#output?.(access,clean))!==true)throw 0; }
    catch { throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED'); }
  }
  checkOutput(credential:unknown,permission:NotificationPermission,target:NotificationTarget,value:unknown):void {
    const access=this.check(credential,permission,target),clean=notificationInput(value,65536);
    try { if(this.#outside(()=>this.#output?.(access,clean))!==true)throw 0; }
    catch { throw new DurableStoreError('NOTIFICATION_UNAUTHORIZED'); }
  }
  resolve(workflowRunId:string):BoundNotificationDestination|undefined {
    try {
      const b=this.#outside(()=>this.#resolve?.(workflowRunId));
      if(b===undefined)return;
      if(!b||typeof b!=='object'||utilTypes.isProxy(b))throw 0;
      const desc=Object.getOwnPropertyDescriptors(b);
      if(Object.values(desc).some(d=>!('value'in d)))throw 0;
      const {transport,...metadata}=b;
      const m=notificationInput(metadata,4096);
      if(!transport||typeof transport!=='object'||utilTypes.isProxy(transport))throw 0;
      const own=Object.getOwnPropertyDescriptors(transport);
      if(Object.values(own).some(d=>!('value'in d)))throw 0;
      let proto=Object.getPrototypeOf(transport);
      while(proto&&proto!==Object.prototype){if(utilTypes.isProxy(proto))throw 0;const ds=Object.getOwnPropertyDescriptors(proto);if(Object.values(ds).some(d=>!('value'in d)))throw 0;proto=Object.getPrototypeOf(proto);}
      if(typeof transport.send!=='function'||m.transportContract!=='macp/0.1.0'||m.idempotencyConfirmed!==true)throw 0;
      if(![m.destinationId,m.bindingVersion,m.implementationDigest,m.receiverRealm,m.recipientSubject,m.audience].every(notificationId))throw 0;
      const url=new URL(m.endpoint),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
      if(url.username||url.password||url.search||url.hash||url.pathname!=='/api/notify')throw 0;
      const development=m.allowDevelopmentLoopback===true&&loopback&&url.protocol==='http:';
      if(!development&&(url.protocol!=='https:'||m.authenticated!==true))throw 0;
      const bindingDigest=digest({...m,endpoint:url.href}),key=`${m.destinationId}:${m.bindingVersion}:${m.implementationDigest}`;
      const old=this.#observed.get(key);
      if(old&&(old.transport!==transport||old.send!==transport.send||old.digest!==bindingDigest))throw 0;
      this.#observed.set(key,{transport,send:transport.send,digest:bindingDigest});
      const result=Object.freeze({destination:Object.freeze({...m,transport}),bindingDigest,send:transport.send});
      this.#resolved.set(result,b);return result;
    } catch { throw new DurableStoreError('NOTIFICATION_UNAVAILABLE'); }
  }
  /** Pure check: no registry/ACL callback runs after the final SEND decision. */
  assertUnchanged(binding:BoundNotificationDestination):void {
    try {
      const b=this.#resolved.get(binding);if(!b||utilTypes.isProxy(b))throw 0;
      if(Object.values(Object.getOwnPropertyDescriptors(b)).some(d=>!('value'in d)))throw 0;
      const {transport,...metadata}=b;
      if(transport!==binding.destination.transport||utilTypes.isProxy(transport))throw 0;
      if(Object.values(Object.getOwnPropertyDescriptors(transport)).some(d=>!('value'in d)))throw 0;
      let proto=Object.getPrototypeOf(transport);
      while(proto&&proto!==Object.prototype){if(utilTypes.isProxy(proto)||Object.values(Object.getOwnPropertyDescriptors(proto)).some(d=>!('value'in d)))throw 0;proto=Object.getPrototypeOf(proto);}
      if(transport.send!==binding.send)throw 0;
      const m=notificationInput(metadata,4096);
      if(digest({...m,endpoint:new URL(m.endpoint).href})!==binding.bindingDigest)throw 0;
    }catch{throw new DurableStoreError('NOTIFICATION_UNAVAILABLE');}
  }
}
