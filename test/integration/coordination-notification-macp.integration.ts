/** Opt-in COORD-5D integration. Uses unmodified fixed MACP, temporary private DBs and loopback only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawn,execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { once } from 'node:events';
import { DurableDatabase } from '../../services/coordination/durable/db.ts';
import { SqliteCoordinationRunnerStore } from '../../services/coordination/durable/durableCoordinationStore.ts';
import { done,fresh,event } from '../notification-fixture.ts';
import { localMacpHost } from '../notification-macp-fixture.ts';
import { continuationFixture } from '../continuation-fixture.ts';
import { reconciliationFixture } from '../reconciliation-fixture.ts';

const checkout=process.env.MACP_REPO_PATH,python=process.env.MACP_PYTHON??'python3';
if(!checkout)throw new Error('Set MACP_REPO_PATH to fixed MACP e88937d0c8132ae7d18098a24d01ee28bffda655.');
const fixed='e88937d0c8132ae7d18098a24d01ee28bffda655';
assert.equal(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),fixed,'MACP must use the fixed upstream commit');
assert.equal(execFileSync('git',['-C',checkout,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'','MACP tracked checkout must be unmodified');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean|Promise<boolean>) {
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){if(await predicate())return;await pause(20);}
 throw new Error('Integration condition timed out');
}
function business(db:DurableDatabase) {
 return db.read(tx=>Object.fromEntries(tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'notification_%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
   .map(r=>{const name=String(r.name);return [name,tx.all(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`)];})));
}

test('COORD-5D fixed MACP durable HTTP, SQLite, authenticated history and SSE', {timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'map-durable-macp-')),token=randomBytes(32).toString('hex'),macpDb=join(dir,'receiver.sqlite');
 let child:ReturnType<typeof spawn>|undefined,port=0,streamAbort:AbortController|undefined,streamRead:Promise<void>|undefined;
 const sse:any[]=[];
 async function stopStream(){streamAbort?.abort();await streamRead?.catch(()=>{});streamAbort=undefined;streamRead=undefined;}
 async function stop(){
  await stopStream();
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child?.kill('SIGKILL'),3000);
  try{await exit;}finally{clearTimeout(timer);}
 }
 async function start(){
  child=spawn(python,['-u','-c',[
   'import socket, uvicorn','sock=socket.socket()','sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)',`sock.bind(("127.0.0.1", ${port}))`,
   'print(sock.getsockname()[1],flush=True)','uvicorn.Server(uvicorn.Config("server.app:app",log_level="error",access_log=False)).run(sockets=[sock])',
  ].join('\n')],{cwd:dir,env:{PATH:process.env.PATH,PYTHONPATH:resolve(checkout!),PYTHONDONTWRITEBYTECODE:'1',MACP_HOST:'127.0.0.1',MACP_TOKEN:token,MACP_DB_PATH:macpDb,MACP_JSONL_PATH:''},stdio:['ignore','pipe','pipe']});
  let output='',failed=false;child.on('error',()=>{failed=true;});child.stdout!.on('data',data=>{output+=data.toString();});child.stderr!.on('data',()=>{});
  await until(()=>{if(failed||child?.exitCode!==null)throw new Error('MACP Python failed');return /^\d+\n/.test(output);});port=Number(output.split('\n')[0]);
  await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/api/health`)).ok;}catch{return false;}});
 }
 const endpoint=()=>`http://127.0.0.1:${port}/api/notify`,origin=()=>`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${token}`};
 const rows=()=>JSON.parse(execFileSync(python,['-c','import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("SELECT event_id,task_id FROM events ORDER BY event_id").fetchall()))',macpDb],{encoding:'utf8'})) as [number,string][];
 async function startStream(){
  streamAbort=new AbortController();const response=await fetch(`${origin()}/api/stream?last_event_id=${rows().at(-1)?.[0]??0}`,{headers,signal:streamAbort.signal});assert.equal(response.status,200);
  const currentAbort=streamAbort;
  streamRead=(async()=>{const reader=response.body!.getReader(),decoder=new TextDecoder();let buffered='';try{while(true){const chunk=await reader.read();if(chunk.done)break;buffered+=decoder.decode(chunk.value,{stream:true});let end:number;while((end=buffered.indexOf('\n\n'))!==-1){const frame=buffered.slice(0,end);buffered=buffered.slice(end+2);const data=frame.split('\n').find(line=>line.startsWith('data: '));if(data)sse.push(JSON.parse(data.slice(6)));}}}catch{if(!currentAbort.signal.aborted)throw new Error('SSE stream failed');}finally{reader.releaseLock();}})();void streamRead.catch(()=>{});
 }
 let serial=0;
 function map(t:TestContext,id:string,completed=false,fetchImpl:typeof fetch=fetch){
  const path=join(dir,`map-${++serial}.sqlite`),host=localMacpHost(endpoint(),token,fetchImpl);let db=new DurableDatabase({path,notifications:host.options});
  const admin=new SqliteCoordinationRunnerStore(db);admin.createWorkflow(fresh(id));const manager=db.createLeaseManager(),lease=manager.acquire(id),store=admin.withLease(lease);
  if(completed){for(const e of done(fresh(id)).events.slice(1))store.append(e);}else store.append(event(store.getSnapshot(id),'WorkflowCancelled',{reason:'Synthetic private cancellation'}));
  manager.release(lease);
  t.after(()=>db.close());
  return {host,path,get db(){return db;},reopen(){db.close();db=new DurableDatabase({path,notifications:host.options});return db;},view(){return db.notifications.read(host.human,{workflowRunId:id}).items[0];},async run(){await db.notifications.runOnce(host.credential,{workflowRunId:id});}};
 }
 try{
  await start();await startStream();
  await t.test('MC-D01/D02: canonical completion is durably received, listed and live streamed; exact replay adds no event/SSE',async t=>{
   const f=map(t,'mc-completion',true),before=business(f.db);assert.equal(f.host.stats.calls,0);await f.run();const view=f.view();assert.equal(view.state,'DELIVERED');assert.equal(view.attempts,1);assert.equal(view.executionAllowed,false);
   assert.equal(rows().filter(r=>r[1]===view.notificationId).length,1);await until(()=>sse.some(e=>e.task_id===view.notificationId));
   const tasks=await(await fetch(`${origin()}/api/tasks`,{headers})).json();assert.ok(tasks.tasks.some((r:any)=>r.task_id===view.notificationId));
   const detail=await fetch(`${origin()}/api/tasks/${encodeURIComponent(view.notificationId)}`,{headers});assert.equal(detail.status,200);const detailBefore=await detail.json();
   const count=rows().length;const repeat=await f.host.transport.send(view.packet!);assert.equal(repeat.httpStatus,200);assert.equal(repeat.idempotentReplay,true);assert.equal(repeat.eventId,rows().find(r=>r[1]===view.notificationId)![0]);
   await pause(100);assert.equal(rows().length,count);assert.equal(sse.filter(e=>e.task_id===view.notificationId).length,1);assert.deepEqual(await(await fetch(`${origin()}/api/tasks/${encodeURIComponent(view.notificationId)}`,{headers})).json(),detailBefore);assert.deepEqual(business(f.db),before);
  });
  await t.test('MC-D05/D02: receiver saves then response is lost; independent MAP process retries same packet and receiver stores once',async t=>{
   let lose=true;const f=map(t,'mc-lost',false,async(url,init)=>{const response=await fetch(url,init);if(lose){lose=false;await response.arrayBuffer();throw new Error('Synthetic lost HTTP ACK');}return response;});
   const before=business(f.db);await f.run();let view=f.view();assert.equal(view.state,'RETRY_WAIT');assert.equal(view.outcomeUnknown,true);assert.equal(view.attempts,1);const packet=view.packet,notificationId=view.notificationId,realm=view.receiverRealm;
   assert.equal(rows().filter(r=>r[1]===notificationId).length,1);f.db.close();
   const proc=spawn(process.execPath,['--experimental-transform-types','--loader','./test/ts-loader.mjs','test/notification-macp-worker-child.ts',f.path,endpoint(),'mc-lost'],{cwd:process.cwd(),env:{PATH:process.env.PATH,MACP_TEST_TOKEN:token},stdio:['ignore','pipe','pipe']});
   let output='';proc.stdout!.on('data',data=>{output+=data.toString();});proc.stderr!.on('data',()=>{});const timeout=setTimeout(()=>proc.kill('SIGKILL'),15000);let exit:unknown[];try{exit=await once(proc,'exit');}finally{clearTimeout(timeout);}assert.equal(exit[0],0);assert.deepEqual(JSON.parse(output),{states:['DELIVERED'],calls:1});
   f.reopen();view=f.view();assert.equal(view.state,'DELIVERED');assert.equal(view.attempts,2);assert.deepEqual(view.packet,packet);assert.equal(view.notificationId,notificationId);assert.equal(view.receiverRealm,realm);
   assert.equal(rows().filter(r=>r[1]===notificationId).length,1);assert.deepEqual(business(f.db),before);await until(()=>sse.some(e=>e.task_id===notificationId));assert.equal(sse.filter(e=>e.task_id===notificationId).length,1);
  });
  await t.test('MC-D03: real key/content conflict stops durable delivery without changing receiver or business data',async t=>{
   const f=map(t,'mc-conflict');f.db.notifications.materialize(f.host.credential,{workflowRunId:'mc-conflict'});const packet=f.view().packet!;
   await f.host.transport.send({...packet,summary:'Different synthetic safe content'});const receiver=rows(),before=business(f.db);await f.run();
   assert.ok(['DELIVERY_FAILED','PAUSED'].includes(f.view().state));assert.equal(f.view().attempts,1);assert.deepEqual(rows(),receiver);assert.deepEqual(business(f.db),before);
  });
  await t.test('MC-D04: real401 stops; explicit authorized retry after same-receiver token rotation succeeds',async t=>{
   const f=map(t,'mc-auth');f.host.rotateToken('synthetic-invalid-token');const count=rows().length,before=business(f.db);await f.run();let view=f.view();assert.ok(['PAUSED','DELIVERY_FAILED'].includes(view.state));assert.equal(rows().length,count);assert.equal(view.attempts,1);
   f.host.rotateToken(token);f.db.notifications.manage(f.host.human,{operation:'RETRY',workflowRunId:'mc-auth',deliveryId:view.deliveryId!,ownerSubject:'operator',destinationId:'local-macp',expectedRevision:view.revision,requestId:'mc-auth-retry',reason:'OPERATOR_REQUEST'});
   await f.run();view=f.view();assert.equal(view.state,'DELIVERED');assert.equal(view.attempts,2);assert.equal(rows().length,count+1);assert.deepEqual(business(f.db),before);
  });
  await t.test('MC-D07: one failing workflow does not stop an independent workflow',async t=>{
   const a=map(t,'mc-fail-stream',false,async()=>new Response('',{status:503})),b=map(t,'mc-pass-stream'),aa=business(a.db),bb=business(b.db);
   await Promise.all([a.run(),b.run()]);assert.equal(a.view().state,'RETRY_WAIT');assert.equal(b.view().state,'DELIVERED');assert.deepEqual(business(a.db),aa);assert.deepEqual(business(b.db),bb);
  });
  await t.test('MC-D08: four additional canonical source kinds use MACP0.1.0 without plan/question/evidence content',async t=>{
   const cases:[string,()=>Promise<{path:string;counts:object;db:DurableDatabase}>][]=[
    ['planning_review_required',async()=>{const f=continuationFixture(t),p=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(p.planId,f.credential);return f;}],
    ['planning_input_required',async()=>{const f=continuationFixture(t);f.hook(async()=>({value:{kind:'needs_input',questions:['Synthetic private question']},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'}));const p=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(p.planId,f.credential);return f;}],
    ['recovery_review_required',async()=>{const f=continuationFixture(t);f.hook(async()=>{throw new Error('Synthetic private provider failure');});const p=f.api().createPlan(f.input(),f.credential);await f.api().startAuthorized(p.planId,f.credential);return f;}],
    ['reconciliation_review_required',async()=>{const f=reconciliationFixture(t),a=await f.historicalAction('FAILED');await f.verified(a.target);return f;}],
   ];
   for(const [kind,create]of cases){const f=await create(),host=localMacpHost(endpoint(),token),db=new DurableDatabase({path:f.path,notifications:host.options});try{const before=business(db),counts=structuredClone(f.counts);for(let i=0;i<10;i++){await db.notifications.runOnce(host.credential,{workflowRunId:'run'});if(db.notifications.read(host.human,{workflowRunId:'run'}).items.some(v=>v.kind===kind&&v.state==='DELIVERED'))break;}
    const view=db.notifications.read(host.human,{workflowRunId:'run'}).items.find(v=>v.kind===kind);assert.ok(view,kind);assert.equal(view.state,'DELIVERED',kind);assert.equal(view.packet!.protocol,'macp');assert.equal(view.packet!.version,'0.1.0');assert.equal(view.packet!.metadata.notification_kind,kind);
    assert.doesNotMatch(JSON.stringify(view.packet),/Synthetic private|Inspect the proposal|Make a plan|receipt\.usage|signature|sourceRef|ownerSubject/);assert.deepEqual(business(db),before);assert.deepEqual(f.counts,counts);assert.equal(rows().filter(r=>r[1]===view.notificationId).length,1);await until(()=>sse.some(e=>e.task_id===view.notificationId));assert.equal((await fetch(`${origin()}/api/tasks/${encodeURIComponent(view.notificationId)}`,{headers})).status,200);
   }finally{db.close();}}
  });
  await t.test('MC-D06/D04: receiver restart retains deduplication; real outage recovery leaves business state unchanged',async t=>{
   const f=map(t,'mc-restart');await f.run();const packet=f.view().packet!,original=rows().find(r=>r[1]===packet.task_id)!,g=map(t,'mc-outage'),before=business(g.db);await until(()=>sse.some(e=>e.task_id===packet.task_id));await stop();await g.run();assert.equal(g.view().state,'RETRY_WAIT');await start();await startStream();
   const repeated=await f.host.transport.send(packet);assert.equal(repeated.httpStatus,200);assert.equal(repeated.eventId,original[0]);await g.run();assert.equal(g.view().state,'DELIVERED');assert.equal(rows().filter(r=>r[1]===packet.task_id).length,1);assert.deepEqual(business(g.db),before);await pause(100);assert.equal(sse.filter(e=>e.task_id===packet.task_id).length,1);
  });
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
