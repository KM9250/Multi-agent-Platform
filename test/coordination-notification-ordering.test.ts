import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { continuationFixture, content } from './continuation-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import type { NotificationDestination, NotificationManagementCommand, NotificationView } from '../services/coordination/durable/notificationTypes.ts';
import type { MacpNotificationPacket } from '../services/coordination/notifications/macpPacket.ts';
import { DeliveryError } from '../services/coordination/notifications/deliveryError.ts';

/** Two distinct canonical sources remain required together: an unanswered question
 * has no answered API, and a later artifact independently awaits review. */
async function orderedFixture(t:TestContext) {
  const f=continuationFixture(t),usage={llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0};
  f.hook(async()=>({value:{kind:'needs_input',questions:['Synthetic question remains unanswered']},usage,completeness:'COMPLETE'}));
  const question=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(question.planId,f.credential);
  f.hook(async()=>({value:{kind:'plan',artifact:content},usage,completeness:'COMPLETE'}));
  const plan=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(plan.planId,f.credential);
  const service=Object.freeze({}),human=Object.freeze({}),stranger=Object.freeze({});
  const packets:MacpNotificationPacket[]=[];let routed=true,fail=false;
  const transport={idempotencySupported:true,async send(packet:MacpNotificationPacket){
    packets.push(structuredClone(packet));
    if(fail)throw new DeliveryError('NETWORK_ERROR',true);
    return {taskId:packet.task_id,eventId:packets.length,httpStatus:201 as const,idempotentReplay:false};
  }};
  const binding:NotificationDestination={destinationId:'ordered-local-macp',bindingVersion:'1',implementationDigest:'ordered-transport-v1',
    receiverRealm:'ordered-receiver-realm',recipientSubject:'operator',audience:'synthetic',endpoint:'http://127.0.0.1:9917/api/notify',
    authenticated:true,allowDevelopmentLoopback:true,transportContract:'macp/0.1.0',idempotencyConfirmed:true,transport};
  const db=new DurableDatabase({path:f.path,notifications:{enabled:true,
    identityVerifier:{verify:c=>c===service?{subjectId:'notification-service',kind:'SERVICE'}:c===human?{subjectId:'operator',kind:'HUMAN'}:c===stranger?{subjectId:'stranger',kind:'HUMAN'}:undefined},
    authorize:a=>a.actor.subjectId!=='stranger'&&(a.ownerSubject===null||a.ownerSubject==='operator')&&(a.recipientSubject===null||a.recipientSubject==='operator'),
    output:()=>true,registry:{resolve:()=>routed?binding:undefined},limits:{automaticAttempts:1,backoffBaseMs:0,backoffMaxMs:0}}});
  const business=()=>Object.fromEntries(f.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notification_%' ORDER BY name").all()
    .map(row=>[String(row.name),f.raw.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]));
  const read=()=>db.notifications.read(human,{workflowRunId:'run'}).items;
  const manage=(view:NotificationView,operation:NotificationManagementCommand['operation'],requestId:string,credential=human)=>db.notifications.manage(credential,
    {operation,workflowRunId:'run',deliveryId:view.deliveryId!,ownerSubject:'operator',destinationId:view.destinationId!,expectedRevision:view.revision,requestId,reason:'OPERATOR_REQUEST'});
  const initial=read();assert.deepEqual(initial.map(v=>v.kind),['planning_input_required','planning_review_required']);
  assert.ok(initial.every(v=>v.necessity==='REQUIRED'));assert.equal(f.counts.draft,2);assert.equal(f.counts.action,0);
  return {f,db,service,human,stranger,packets,business,read,manage,setRouted(value:boolean){routed=value;},setFailure(value:boolean){fail=value;}};
}

test('DL-13/DL-14: canonical same-workflow UNROUTED sources stay unsent and later routing preserves source order',async t=>{
  const f=await orderedFixture(t);
  try {
    const before=f.business(),counts={...f.f.counts};f.setRouted(false);
    for(let i=0;i<2;i++)await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
    assert.deepEqual(f.read().map(v=>v.state),['UNROUTED','UNROUTED']);assert.equal(f.packets.length,0);
    f.setRouted(true);f.db.notifications.materialize(f.service,{workflowRunId:'run',limit:1});
    assert.deepEqual(f.read().map(v=>v.state),['PENDING','UNROUTED']);assert.equal(f.packets.length,0);
    const ids=f.read().map(v=>v.notificationId);
    await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
    assert.deepEqual(f.packets.map(p=>p.task_id),[ids[0]]);assert.deepEqual(f.read().map(v=>v.state),['DELIVERED','PENDING']);
    await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
    assert.deepEqual(f.packets.map(p=>p.task_id),ids);assert.deepEqual(f.read().map(v=>v.state),['DELIVERED','DELIVERED']);
    assert.deepEqual(f.business(),before);assert.deepEqual(f.f.counts,counts);
  } finally {f.db.close();}
});

for(const blocker of ['PAUSED','DELIVERY_FAILED'] as const)
test(`DL-13/DL-14: earlier required ${blocker} blocks a later PENDING source until an authorized CLOSE`,async t=>{
  const f=await orderedFixture(t);
  try {
    f.db.notifications.materialize(f.service,{workflowRunId:'run'});
    const before=f.business(),counts={...f.f.counts},ids=f.read().map(v=>v.notificationId);
    if(blocker==='PAUSED')f.manage(f.read()[0],'PAUSE','pause-first');
    else {f.setFailure(true);await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});}
    assert.deepEqual(f.read().map(v=>v.state),[blocker,'PENDING']);
    const sent=f.packets.length;for(let i=0;i<3;i++)await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
    assert.equal(f.packets.length,sent);assert.equal(f.read()[1].attempts,0);
    assert.ok(f.packets.every(p=>p.task_id===ids[0]));
    const stable=f.read();assert.throws(()=>f.manage(stable[0],'CLOSE','stranger-close',f.stranger));
    assert.deepEqual(f.read(),stable);assert.equal(f.packets.length,sent);
    f.manage(f.read()[0],'CLOSE','close-first');f.setFailure(false);
    assert.equal(f.read()[0].state,blocker==='PAUSED'?'SUPPRESSED':'CLOSED_UNCONFIRMED');
    await f.db.notifications.runOnce(f.service,{workflowRunId:'run'});
    assert.equal(f.packets.length,sent+1);assert.equal(f.packets.at(-1)!.task_id,ids[1]);
    assert.equal(f.read()[1].state,'DELIVERED');assert.equal(f.read()[1].attempts,1);
    assert.equal(f.read()[0].outcomeUnknown,blocker==='DELIVERY_FAILED');
    assert.deepEqual(f.business(),before);assert.deepEqual(f.f.counts,counts);
  } finally {f.db.close();}
});
