import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFixture } from './notification-outbox-fixture.ts';
import { DurableStoreError } from '../services/coordination/durable/integrity.ts';
import type { NotificationManagementCommand } from '../services/coordination/durable/notificationTypes.ts';
import { continuationFixture } from './continuation-fixture.ts';

const unauthorized=(error:unknown)=>error instanceof DurableStoreError&&error.code==='NOTIFICATION_UNAUTHORIZED';

test('AU-D02/AU-D04: coarse workflow VIEW does not disclose denied rows through empty-page shape, counts, cursor, or errors',t=>{
 const f=notificationFixture(t);
 f.create('empty').release();
 const w=f.create('private');w.append('WorkflowCancelled',{reason:'synthetic-private'});w.release();
 f.db.notifications.materialize(f.service,{workflowRunId:'private'});
 const before=f.allTables();f.outputs.length=0;
 f.hooks.authorize=access=>!(access.permission==='VIEW_NOTIFICATION'&&access.recipientSubject==='owner');
 for(const cursor of [0,1,100]){
  const empty=f.db.notifications.read(f.human,{workflowRunId:'empty',cursor,limit:1});
  const hidden=f.db.notifications.read(f.human,{workflowRunId:'private',cursor,limit:1});
  assert.deepEqual(hidden,empty);
  assert.equal(hidden.items.length,0);assert.equal(hidden.nextCursor,null);
  assert.deepEqual(hidden.summary,{scope:'PAGE',sourceCount:0,outstandingCount:0,unroutedCount:0,unknownCount:0,oldestOutstandingAt:null,stopReasons:[]});
 }
 assert.ok(f.outputs.every(value=>!JSON.stringify(value).includes('private')));
 assert.equal(f.packets.length,0);assert.deepEqual(f.allTables(),before);
});

test('AU-D02: mixed visible and hidden rows paginate authorized ordinals without physical sequence gaps or denied look-ahead',async t=>{
 const f=notificationFixture(t),business=continuationFixture(t,{}, {dir:f.dir,path:f.path});
 business.hook(async()=>({value:{kind:'needs_input',questions:['Synthetic private input']},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));
 for(let i=0;i<4;i++){
  const plan=business.api().createPlan(business.input(),business.credential);
  await business.api().startAuthorized(plan.planId,business.credential);
  const owner=String(f.raw.prepare('SELECT owner_subject FROM notification_sources LIMIT 1').get()!.owner_subject);
  f.binding={...f.binding!,bindingVersion:String(i+1),recipientSubject:owner,audience:i%2===0?'visible':'hidden'};
  f.db.notifications.materialize(f.service,{workflowRunId:'run'});
 }
 const sourceRows=f.raw.prepare('SELECT source_id,source_sequence FROM notification_sources ORDER BY source_sequence').all();
 assert.equal(sourceRows.length,4);
 const visibleIds=[sourceRows[0].source_id,sourceRows[2].source_id],hiddenIds=[String(sourceRows[1].source_id),String(sourceRows[3].source_id)];
 const before=f.allTables();f.outputs.length=0;
 f.hooks.authorize=access=>!(access.permission==='VIEW_NOTIFICATION'&&access.audience==='hidden');
 const first=f.db.notifications.read(f.human,{workflowRunId:'run',limit:1});
 assert.deepEqual(first.items.map(x=>x.sourceId),visibleIds.slice(0,1));assert.equal(first.items[0].position,1);assert.equal(first.nextCursor,1);
 const second=f.db.notifications.read(f.human,{workflowRunId:'run',cursor:first.nextCursor!,limit:1});
 assert.deepEqual(second.items.map(x=>x.sourceId),visibleIds.slice(1));assert.equal(second.items[0].position,2);assert.equal(second.nextCursor,null);
 const whole=f.db.notifications.read(f.human,{workflowRunId:'run',limit:200});
 assert.deepEqual(whole.items.map(x=>x.position),[1,2]);assert.equal(whole.summary.sourceCount,2);assert.equal(whole.nextCursor,null);
 for(const page of [first,second,whole]){
  const encoded=JSON.stringify(page);
  assert.ok(!encoded.includes('sourceSequence'));assert.ok(!hiddenIds.some(id=>encoded.includes(id)));
 }
 assert.ok(!hiddenIds.some(id=>JSON.stringify(f.outputs).includes(id)));
 assert.equal(f.packets.length,0);assert.deepEqual(f.allTables(),before);
});

test('AU-D02/RT-D03: denied malformed Source is filtered before canonical parsing and cannot become an existence error',t=>{
 const f=notificationFixture(t),w=f.create('private');w.append('WorkflowCancelled',{reason:'synthetic-private'});w.release();
 f.create('empty').release();f.db.notifications.materialize(f.service,{workflowRunId:'private'});
 const sourceId=String(f.raw.prepare('SELECT source_id FROM notification_sources').get()!.source_id);
 // Explicit OS/DB-admin fault injection; ordinary actors cannot remove these guards.
 f.raw.exec('DROP TRIGGER notification_sources_no_update');
 f.raw.prepare("UPDATE notification_sources SET source_json='{}' WHERE source_id=?").run(sourceId);
 const before=f.allTables();f.outputs.length=0;
 f.hooks.authorize=access=>!(access.permission==='VIEW_NOTIFICATION'&&access.recipientSubject==='owner');
 assert.deepEqual(f.db.notifications.read(f.human,{workflowRunId:'private'}),f.db.notifications.read(f.human,{workflowRunId:'empty'}));
 assert.ok(!JSON.stringify(f.outputs).includes(sourceId));assert.equal(f.packets.length,0);assert.deepEqual(f.allTables(),before);
 // A caller allowed to inspect the row receives the integrity failure, never a fake successful notification.
 f.hooks.authorize=()=>true;assert.throws(()=>f.db.notifications.read(f.human,{workflowRunId:'private'}));
 assert.equal(f.packets.length,0);assert.deepEqual(f.allTables(),before);
});

test('AU-D04/RT-D19: OUTPUT rejection for an individually visible row remains a fixed error with no HTTP or table mutation',t=>{
 const f=notificationFixture(t),w=f.create();w.append('WorkflowCancelled',{reason:'synthetic-private'});w.release();
 f.db.notifications.materialize(f.service,{workflowRunId:'run'});
 assert.equal(f.db.notifications.read(f.human,{workflowRunId:'run'}).items.length,1);
 const before=f.allTables();let checked=false;
 f.hooks.output=(_access,value)=>{
  if(value&&typeof value==='object'&&Object.hasOwn(value,'sourceId')){checked=true;return false;}
  return true;
 };
 assert.throws(()=>f.db.notifications.read(f.human,{workflowRunId:'run'}),unauthorized);
 assert.equal(checked,true);assert.equal(f.packets.length,0);assert.deepEqual(f.allTables(),before);
});

test('AU-D02/RT-D03: denied management target is authorized before malformed source parsing and matches nonexistent target error',t=>{
 const f=notificationFixture(t),w=f.create();w.append('WorkflowCancelled',{reason:'synthetic-private'});w.release();
 f.db.notifications.materialize(f.service,{workflowRunId:'run'});
 const row=f.db.notifications.read(f.human,{workflowRunId:'run'}).items[0];
 f.raw.exec('DROP TRIGGER notification_sources_no_update');
 f.raw.prepare("UPDATE notification_sources SET source_json='{}' WHERE source_id=?").run(row.sourceId);
 const before=f.allTables();
 f.hooks.authorize=access=>!(access.permission==='PAUSE_NOTIFICATION_DELIVERY'&&access.recipientSubject==='owner');
 const command:NotificationManagementCommand={operation:'PAUSE',workflowRunId:'run',deliveryId:row.deliveryId!,ownerSubject:'owner',
  destinationId:row.destinationId!,expectedRevision:row.revision,requestId:'private-pause',reason:'OPERATOR_REQUEST'};
 const errors:string[]=[];
 for(const deliveryId of [row.deliveryId!,'delivery-nonexistent']){
  try{f.db.notifications.manage(f.human,{...command,deliveryId});assert.fail('management should deny');}
  catch(error){assert.ok(unauthorized(error));errors.push((error as Error).message);}
 }
 assert.deepEqual(errors,['NOTIFICATION_UNAUTHORIZED','NOTIFICATION_UNAUTHORIZED']);
 assert.equal(f.packets.length,0);assert.deepEqual(f.allTables(),before);
});
