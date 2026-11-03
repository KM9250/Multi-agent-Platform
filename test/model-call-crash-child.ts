import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DurableDatabase,SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
import { ModelCallLedger } from '../services/coordination/durable/modelCallLedger.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
const [path,stage,boundary]=process.argv.slice(2);
const pause=()=>{process.send!({stage,boundary});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const original=DatabaseSync.prototype.exec;
if(stage==='migration') {
 let armed=false;
 DatabaseSync.prototype.exec=function(sql:string){
  if(sql.includes('CREATE TABLE model_call_coverage')) {armed=true;if(boundary==='before')pause();}
  original.call(this,sql);
  if(armed && ((boundary==='during' && sql.includes('CREATE TABLE model_call_coverage'))||(boundary==='after' && sql==='COMMIT')))pause();
 };
 new DurableDatabase({path});
} else {
 const db=new DurableDatabase({path}),lease=db.createLeaseManager({ttlMs:60000}).acquire('run'),store=new SqliteCoordinationRunnerStore(db,lease),l=new ModelCallLedger(store,{now:()=>10});
 const s=store.getSnapshot('run'),x={workflowRunId:'run',modelCallId:'crash-call',attemptId:'crash-attempt',providerId:'test',modelId:'test',phase:'PLAN' as const,roundKey:'crash-round',requestCursor:s.events.length,requestEventId:s.events.at(-1)!.eventId,
 quote:{providerId:'test',modelId:'test',maxAttempts:1 as const,inputTokens:1,maxOutputTokens:1,maxEstimatedCost:0,pricingId:'test-zero',conditions:'test-only',requestDigest:'a'.repeat(64)}};
 if(stage!=='reservation')l.reserve(x);
 if(['settlement','application'].includes(stage))l.markDispatchIntent(x);
 if(stage==='application')l.settle(x,{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},true);
 let writing=false;
 DatabaseSync.prototype.exec=function(sql:string){if(sql==='BEGIN IMMEDIATE')writing=true;if(writing&&sql==='COMMIT'&&boundary==='before')pause();original.call(this,sql);if(writing&&sql==='COMMIT'&&boundary==='after')pause();};
 if(stage==='reservation')l.reserve(x);
 if(stage==='intent')l.markDispatchIntent(x);
 if(stage==='settlement')l.settle(x,{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},true);
 if(stage==='application')l.markApplied(x,store.getSnapshot('run').events.length,()=>{
  store.append(createRunnerEvent(store.getSnapshot('run'),'ProgressRecorded',{outcome:'NO_PROGRESS',summary:'test'},{now:Date.now},{nextId:()=>randomUUID()}));
  if(boundary==='during')pause();
  store.append(createRunnerEvent(store.getSnapshot('run'),'WorkflowBlocked',{reason:'TEST'},{now:Date.now},{nextId:()=>randomUUID()}));
 });
}
throw Error('Boundary not reached');
