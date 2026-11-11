import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { dirname,join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { continuationFixture,content } from './continuation-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { createRunnerEvent } from '../services/coordination/runner/eventFactory.ts';
import { digest } from '../services/coordination/durable/integrity.ts';
import { prepared } from './durable-execution-fixture.ts';
const [path,mode,boundary,counter,priorPlan]=process.argv.slice(2),dir=dirname(path);
const kill=()=>process.kill(process.pid,process.platform==='win32'?'SIGTERM':'SIGKILL');
const nativeExec=DatabaseSync.prototype.exec,nativePrepare=DatabaseSync.prototype.prepare;
let phase='';
function install() {
 DatabaseSync.prototype.prepare=function(sql:string){const stmt=nativePrepare.call(this,sql),run=stmt.run.bind(stmt);
  stmt.run=(...args:Parameters<typeof stmt.run>)=>{
   const result=run(...args);
   if(sql.startsWith('INSERT INTO recovery_invocations'))phase='start';
   if(sql.startsWith('INSERT INTO model_call_ledger'))phase='model-reservation';
   if(sql.includes("SET state='DISPATCH_INTENT'"))phase='model-intent';
   if(sql.includes("SET state='SETTLED'"))phase='usage';
   if(sql.startsWith('INSERT INTO planning_artifacts'))phase='artifact';
   if(sql.startsWith('INSERT INTO planning_read_calls'))phase='read-intent';
   if(sql.startsWith('UPDATE planning_read_calls'))phase='read-result';
   if(sql.includes("SET state = 'DISPATCH_RESERVED'"))phase='action-intent';
   if(sql.startsWith('INSERT INTO execution_results'))phase='action-result';
   if(sql.startsWith('INSERT INTO recovery_hold_lifecycle')&&args.includes('INVOCATION_FINISHED'))phase='finish';
   if(sql.startsWith('INSERT INTO recovery_hold_lifecycle')&&args.includes('HOLD_RELEASED'))phase='release';
   if(sql.startsWith('UPDATE runtime_leases SET owner_instance_id'))phase='rehold';
   return result;};return stmt;};
 DatabaseSync.prototype.exec=function(sql:string){
  if(mode==='migration'&&boundary==='before-ddl'&&sql.includes('CREATE TABLE recovery_hold_lifecycle'))kill();
  if(sql==='COMMIT'&&(boundary===`before-${phase}`||mode==='migration'&&boundary==='before-commit'))kill();
  const result=nativeExec.call(this,sql);
  if(mode==='migration'&&boundary==='after-ddl'&&sql.includes('CREATE TABLE recovery_hold_lifecycle'))kill();
  if(sql==='COMMIT'&&(boundary===`after-${phase}`||mode==='migration'&&boundary==='after-commit'))kill();
  if(sql==='COMMIT')phase='';return result;};
}
if(mode==='migration'){install();new DurableDatabase({path});throw Error('Missing migration crash');}
const f=continuationFixture({after(){}} as never,{}, {dir,path,reopen:mode==='retry'||mode==='race'});
if(mode==='retry') {
 try {await f.api().startAuthorized(priorPlan,f.credential);}catch{}
 fs.appendFileSync(join(dir,'retry-complete'),'read only\n');f.db.close();f.raw.close();process.exit(0);
}
if(mode==='race') {
 process.send!({ready:true});process.once('message',async()=>{
  try {const lease=f.manager.acquire('run');const {RecoveryContinuationCoordinator}=await import('../services/coordination/durable/recoveryContinuationCoordinator.ts');
   const api=new RecoveryContinuationCoordinator(f.db,lease),p=api.createPlan(f.input(),f.credential);
   f.hook(async()=>{fs.appendFileSync(counter,'model\n');await new Promise(r=>setTimeout(r,100));return {value:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'};});
   await api.startAuthorized(p.planId,f.credential);process.send!({done:true,started:true});
  }catch(error){process.send!({done:true,error:(error as {code?:string}).code});}finally{f.db.close();f.raw.close();process.disconnect();}
 });
} else {
 const input=f.input(mode==='read'?'PLAN_READ_ONLY':'THINK_ONLY');
 if(mode==='action'||mode==='finish'||mode==='release'||mode==='rehold') {
  f.store.append(createRunnerEvent(f.store.getSnapshot('run'),'WorkflowSuspended',{}, {now:Date.now},{nextId:()=> 'suspend'}));try{f.store.assertRecoveryExecution('run');}catch{}
 }
 const p=f.api().createPlan(mode==='release'||mode==='rehold'?{operation:'RELEASE_RECOVERY_HOLD',origin:'RECOVERY',workflowRunId:'run',requestId:'release',resume:{authorization:{type:'user'}},limits:{maxRounds:0,maxModelCalls:0,maxActionDispatches:0,maxReadCalls:0,maxInputTokens:0,maxOutputTokens:0,maxCostMicros:0}}:
  mode==='action'||mode==='finish'?{operation:'BOUNDED_CONTINUATION',mode:'BOUNDED_EXECUTE',origin:'RECOVERY',workflowRunId:'run',requestId:'execute',providerId:'synthetic',modelId:'test',start:'NEW_ROUND',resume:{authorization:{type:'user'}},
  actions:[{executorId:'test',operation:'read',actionClass:'read',payloadDigest:digest(prepared.payload)}],limits:{maxRounds:1,maxModelCalls:2,maxActionDispatches:1,maxReadCalls:0,maxInputTokens:100,maxOutputTokens:100,maxCostMicros:1000000}}:input,f.credential);
 if(p.origin==='RECOVERY')f.api().authorize(p,f.approver);
 fs.writeFileSync(join(dir,'plan-id'),p.planId);
 f.hook(async r=>{if(boundary==='before-model-external')kill();fs.appendFileSync(counter,'model\n');if(boundary==='after-model-external')kill();
  return {value:mode==='read'&&!r.reads.length?{kind:'read_requests',requests:[{resourceId:'source',digest:f.reads.describe('source')!.digest}]}:{kind:'plan',artifact:content},usage:{llmCalls:1,inputTokens:1,outputTokens:1,estimatedCost:0},completeness:'COMPLETE'};});
 f.actionHook(async()=>{if(boundary==='before-action-external')kill();fs.appendFileSync(counter,'action\n');if(boundary==='after-action-external')kill();return {status:'succeeded',summary:'Synthetic action'};});
 if(mode==='read') {const originalRead=fs.readSync;fs.readSync=((fd,...args:any[])=>{const target=fs.readlinkSync(`/proc/self/fd/${fd}`);if(target===join(dir,'input.txt')){if(boundary==='before-read-external')kill();fs.appendFileSync(counter,'read\n');if(boundary==='after-read-external')kill();}return (originalRead as any)(fd,...args);}) as typeof fs.readSync;syncBuiltinESMExports();}
 if(mode==='rehold'){await f.api().startAuthorized(p.planId,f.credential);f.manager.release(f.lease);install();f.manager.acquire('run');}
 else {install();await f.api().startAuthorized(p.planId,f.credential);}
 throw Error(`Missing crash boundary: ${boundary}`);
}
