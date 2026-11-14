import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFixture } from './notification-outbox-fixture.ts';
import { DeliveryError } from '../services/coordination/notifications/deliveryError.ts';
import type { NotificationManagementCommand } from '../services/coordination/durable/notificationTypes.ts';
import type { DurableDatabase } from '../services/coordination/durable/db.ts';

const page=(f:ReturnType<typeof notificationFixture>,workflowRunId='run')=>f.db.notifications.read(f.human,{workflowRunId});
const manage=(f:ReturnType<typeof notificationFixture>,operation:NotificationManagementCommand['operation'],requestId:string)=>{
 const row=page(f).items[0];
 return f.db.notifications.manage(f.human,{operation,requestId,workflowRunId:'run',deliveryId:row.deliveryId!,
  ownerSubject:'owner',destinationId:row.destinationId!,expectedRevision:row.revision,reason:'OPERATOR_REQUEST'});
};

test('DL-07/DL-22: concurrent independent DB runtimes share the configured claim limit across workflows',async t=>{
 const f=notificationFixture(t,{limits:{concurrency:1,httpTimeoutMs:500,claimTtlMs:1600}});
 for(const id of ['first','second']){const w=f.create(id);w.append('WorkflowCancelled',{reason:'review-test'});w.release();}
 const business=f.business(),other=f.open();
 let finish!:()=>void;
 f.hooks.send=packet=>new Promise(resolve=>{finish=()=>resolve({taskId:packet.task_id,eventId:1,httpStatus:201,idempotentReplay:false});});
 const first=f.db.notifications.runOnce(f.service,{workflowRunId:'first'});
 try {
  assert.equal(f.packets.length,1);
  await other.notifications.runOnce(f.service,{workflowRunId:'second'});
  assert.equal(f.packets.length,1,'second process-local runtime must not create a second HTTP at concurrency=1');
  assert.equal(page(f,'second').items[0].attempts,0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM notification_stream_claims WHERE expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)").get()!.n,1);
 } finally {finish();await first;}
 f.hooks.send=undefined;
 await other.notifications.runOnce(f.service,{workflowRunId:'second'});
 assert.equal(f.packets.length,2);
 assert.equal(page(f,'second').items[0].state,'DELIVERED');
 assert.deepEqual(f.business(),business);
});

test('DL-08/DL-18: admin pause/resume cannot hide an expired SENDING attempt from UNKNOWN recovery',async t=>{
 const f=notificationFixture(t,{limits:{httpTimeoutMs:50,claimTtlMs:1100,backoffBaseMs:0,backoffMaxMs:0}}),w=f.create();
 w.append('WorkflowCancelled',{reason:'review-test'});w.release();const business=f.business();
 f.hooks.send=async()=>{f.denied.add('COLLECT_NOTIFICATION_RECEIPT');throw new DeliveryError('TIMEOUT',true);};
 await assert.rejects(f.db.notifications.runOnce(f.service,{workflowRunId:'run'}));
 assert.equal(page(f).items[0].state,'SENDING');
 manage(f,'PAUSE','pause-active');manage(f,'RESUME','resume-active');
 assert.equal(page(f).items[0].state,'PENDING');
 const expiry=Number(f.raw.prepare('SELECT expires_at FROM notification_stream_claims').get()!.expires_at);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry-Date.now()+15)));
 f.denied.delete('COLLECT_NOTIFICATION_RECEIPT');f.hooks.send=undefined;
 await f.open().notifications.runOnce(f.service,{workflowRunId:'run'});
 const attempts=f.raw.prepare('SELECT state FROM notification_delivery_attempts ORDER BY attempt_number').all();
 assert.deepEqual(attempts.map(a=>a.state),['SEND_OUTCOME_UNKNOWN','RECEIVED']);
 assert.equal(page(f).items[0].state,'DELIVERED');assert.equal(f.packets.length,2);
 assert.deepEqual(f.business(),business);
});

test('AU-D05/RT-D07: registry callbacks after claim cannot revoke SEND behind the final authorization check',async t=>{
 let f!:ReturnType<typeof notificationFixture>,sendAuthorized=false,revoked=false;
 f=notificationFixture(t,{registry:{resolve(){
  if(sendAuthorized){revoked=true;f.denied.add('SEND_NOTIFICATION');}
  return f.binding;
 }}});
 f.hooks.authorize=access=>{
  if(access.permission==='SEND_NOTIFICATION'&&f.raw.prepare("SELECT delivery_id FROM notification_deliveries WHERE state='SENDING' LIMIT 1").get())sendAuthorized=true;
  return true;
 };
 const w=f.create();w.append('WorkflowCancelled',{reason:'review-test'});w.release();const business=f.business();
 await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
 if(revoked)assert.equal(f.packets.length,0,'a registry callback revoked SEND before HTTP');
 else assert.equal(f.packets.length,1,'normal control with no registry callback after final SEND authorization');
 assert.deepEqual(f.business(),business);
});

test('AU-D05: packet OUTPUT callback cannot revoke SEND behind its earlier authorization check',async t=>{
 const f=notificationFixture(t),w=f.create();w.append('WorkflowCancelled',{reason:'review-test'});w.release();
 const business=f.business();let revoked=false;
 f.hooks.output=access=>{
  if(access.permission==='SEND_NOTIFICATION'&&f.raw.prepare("SELECT delivery_id FROM notification_deliveries WHERE state='SENDING' LIMIT 1").get()){
   revoked=true;f.denied.add('SEND_NOTIFICATION');
  }
  return true;
 };
 await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
 assert.equal(revoked,true);assert.equal(f.packets.length,0);assert.deepEqual(f.business(),business);
});

test('RT-D07: packet OUTPUT cannot replace the whole current Registry binding while leaving the old object unchanged',async t=>{
 const f=notificationFixture(t),w=f.create();w.append('WorkflowCancelled',{reason:'review-test'});w.release();
 const business=f.business();let replaced=false;
 f.hooks.output=access=>{
  if(access.permission==='SEND_NOTIFICATION'&&f.raw.prepare("SELECT delivery_id FROM notification_deliveries WHERE state='SENDING' LIMIT 1").get()){
   replaced=true;f.binding={...f.binding!,receiverRealm:'replacement-realm'};
  }
  return true;
 };
 await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
 assert.equal(replaced,true);assert.equal(f.packets.length,0);assert.deepEqual(f.business(),business);
});

for(const priorUnknown of [false,true])test(`DL-15/DL-16: CLOSE after Claim but before HTTP refines proven unsent while retaining prior UNKNOWN=${priorUnknown}`,async t=>{
 let f!:ReturnType<typeof notificationFixture>,other!:DurableDatabase,closeEnabled=false,closed=false;
 f=notificationFixture(t,{limits:{backoffBaseMs:0,backoffMaxMs:0},registry:{resolve(){
  if(closeEnabled&&!closed&&f.raw.prepare("SELECT delivery_id FROM notification_deliveries WHERE state='SENDING' LIMIT 1").get()){
   closed=true;
   const row=other.notifications.read(f.human,{workflowRunId:'run'}).items[0];
   // An independently authorized administration connection races the sender.
   other.notifications.manage(f.human,{operation:'CLOSE',workflowRunId:'run',deliveryId:row.deliveryId!,ownerSubject:'owner',
    destinationId:row.destinationId!,expectedRevision:row.revision,requestId:'close-before-http',reason:'OPERATOR_REQUEST'});
  }
  return f.binding;
 }}});
 other=f.open();const w=f.create();w.append('WorkflowCancelled',{reason:'review-test'});w.release();const business=f.business();
 if(priorUnknown){
  f.hooks.send=async()=>{throw new DeliveryError('NETWORK_ERROR',true);};
  await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
  assert.equal(page(f).items[0].state,'RETRY_WAIT');assert.equal(page(f).items[0].outcomeUnknown,true);
 }
 f.hooks.send=undefined;closeEnabled=true;const beforeHttp=f.packets.length;
 await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
 const row=page(f).items[0];
 assert.equal(closed,true);assert.equal(f.packets.length,beforeHttp,'the closed Claim never starts another HTTP');
 assert.equal(row.state,priorUnknown?'CLOSED_UNCONFIRMED':'SUPPRESSED');assert.equal(row.outcomeUnknown,priorUnknown);
 assert.deepEqual(f.raw.prepare('SELECT state FROM notification_delivery_attempts ORDER BY attempt_number').all().map(a=>a.state),
  priorUnknown?['SEND_OUTCOME_UNKNOWN','NOT_SENT_PROVEN']:['NOT_SENT_PROVEN']);
 assert.equal(row.receipts.length,0);assert.deepEqual(f.business(),business);
});
