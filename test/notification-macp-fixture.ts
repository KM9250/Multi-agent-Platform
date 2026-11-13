import type { NotificationOptions, NotificationDestination } from '../services/coordination/durable/notificationTypes.ts';
import { MacpHttpNotificationTransport } from '../services/coordination/notifications/macpTransport.ts';

/** Test-only opaque identity, local recipient and fixed MACP receiver namespace. */
export function localMacpHost(endpoint:string, token:string, fetchImpl:typeof fetch=fetch) {
  const credential=Object.freeze({}), human=Object.freeze({}), stats={calls:0,bodies:[] as string[]};
  let currentToken=token;
  const transport={idempotencySupported:true,async send(packet:Parameters<MacpHttpNotificationTransport['send']>[0],signal?:AbortSignal){
    stats.calls++;
    const http=new MacpHttpNotificationTransport({endpoint,token:currentToken,allowDevelopmentLoopback:true,idempotencyConfirmed:true,timeoutMs:3000,
      fetch:async(url,init)=>{stats.bodies.push(String(init?.body));return fetchImpl(url,init);}});
    return http.send(packet,signal);
  }};
  const destination:NotificationDestination={destinationId:'local-macp',bindingVersion:'local:1',implementationDigest:'d'.repeat(64),receiverRealm:'fixed-macp-test-realm',
    recipientSubject:'operator',audience:'local-map-notifications',endpoint,authenticated:true,transportContract:'macp/0.1.0',idempotencyConfirmed:true,
    allowDevelopmentLoopback:true,transport};
  const options:NotificationOptions={enabled:true,identityVerifier:{verify:value=>value===credential?{subjectId:'notification-worker',kind:'SERVICE'}:value===human?{subjectId:'operator',kind:'HUMAN'}:undefined},
    authorize:access=>(access.actor.subjectId==='notification-worker'||access.actor.subjectId==='operator')&&(!access.ownerSubject||access.ownerSubject==='operator')
      &&(!access.recipientSubject||access.recipientSubject==='operator'),output:()=>true,registry:{resolve:()=>destination},
    limits:{httpTimeoutMs:3000,claimTtlMs:30000,backoffBaseMs:0,backoffMaxMs:0}};
  return {options,credential,human,transport,stats,destination,rotateToken(value:string){currentToken=value;}};
}
