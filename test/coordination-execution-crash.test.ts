import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionFixture } from './durable-execution-fixture.ts';

function child(t: TestContext,path:string,mode:string,effectPath:string){
  const process=fork(fileURLToPath(new URL('./durable-execution-child.ts',import.meta.url)),[path,mode,effectPath],{
    execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','ignore','ipc'],
  });
  let readyResolve!:()=>void,resolve!:(v:any)=>void,reject!:(e:Error)=>void;
  const ready=new Promise<void>(r=>{readyResolve=r;}),result=new Promise<any>((r,j)=>{resolve=r;reject=j;});void result.catch(()=>{});
  const closed=new Promise<void>(r=>process.on('exit',()=>r()));
  const timer=setTimeout(()=>{process.kill('SIGKILL');readyResolve();reject(Error('Child timeout'));},15000);
  process.on('error',e=>{readyResolve();reject(e);});
  process.on('message',(message:any)=>{if(message.ready)readyResolve();else{clearTimeout(timer);resolve(message);}});
  process.on('exit',(code,signal)=>{clearTimeout(timer);readyResolve();if(code||signal)reject(Error('Child terminated'));});
  t.after(async()=>{clearTimeout(timer);if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');await closed;});
  return {process,ready,result,closed};
}
const effects=(path:string)=>existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).length:0;
for(const [mode,state,initialEffects,afterRetry] of [
  ['registration-before',undefined,0,0],['registration-after','PREPARED',0,1],
  ['reserve-before','PREPARED',0,1],['reserve-after','DISPATCH_RESERVED',0,0],
  ['external-after','DISPATCH_RESERVED',1,1],['evidence-before','DISPATCH_RESERVED',1,1],
  ['result-before','DISPATCH_RESERVED',1,1],['result-after','RESULT_RECORDED',1,1],
  ['finalize-before','RESULT_RECORDED',1,1],['finalize-after','FINALIZED',1,1],
] as const) test(`real SIGKILL at ${mode}: durable boundary survives and possible effects never repeat`,async t=>{
  const f=executionFixture(t),effectPath=join(f.dir,'effects.log');
  if(!mode.startsWith('registration-'))f.register();
  // Stage finalization with an independently recorded external effect in a separate process.
  if(mode.startsWith('finalize-')){
    const stage=child(t,f.path,'result-after',effectPath);await stage.ready;stage.process.send({});assert.equal((await stage.result).stage,'result-after');stage.process.kill('SIGKILL');await stage.closed;
  }
  f.db.close();
  const crash=child(t,f.path,mode,effectPath);await crash.ready;crash.process.send({});assert.equal((await crash.result).stage,mode);crash.process.kill('SIGKILL');await crash.closed;
  assert.equal(effects(effectPath),initialEffects);
  const inspect=child(t,f.path,'inspect',effectPath);await inspect.ready;inspect.process.send({});
  const diagnostic=(await inspect.result).diagnostic;await inspect.closed;assert.equal(diagnostic?.state,state);
  assert.equal(effects(effectPath),initialEffects); // Inspecting/reopening never runs an Executor.
  if(!state){const opened=f.open();assert.equal(opened.store.getSnapshot('run').events.length,1);return;}
  const retry=child(t,f.path,'retry',effectPath);await retry.ready;retry.process.send({});const outcome=await retry.result;await retry.closed;
  if(state==='DISPATCH_RESERVED')assert.equal(outcome.code,'EXECUTION_REVIEW_REQUIRED');else assert.equal(outcome.code,undefined);
  assert.equal(effects(effectPath),afterRetry);assert.ok(effects(effectPath)<=1);
  const second=child(t,f.path,'retry',effectPath);await second.ready;second.process.send({});await second.result;await second.closed;assert.equal(effects(effectPath),afterRetry);
});
test('two Node processes racing the same Action produce at most one reservation and one external effect',async t=>{
  const f=executionFixture(t);f.register();f.db.close();const effectPath=join(f.dir,'effects.log');
  const a=child(t,f.path,'retry',effectPath),b=child(t,f.path,'retry',effectPath);await Promise.all([a.ready,b.ready]);a.process.send({});b.process.send({});
  const outcomes=await Promise.all([a.result,b.result]);await Promise.all([a.closed,b.closed]);
  assert.ok(outcomes.some(o=>!o.code));assert.equal(effects(effectPath),1);
  const snapshot=f.open().store.getSnapshot('run');assert.equal(snapshot.events.filter(e=>e.type==='TaskCompleted').length,1);
});


for (const stage of ['task','session','progress'] as const) test(`SIGKILL after legacy uncertain ${stage} COMMIT: fresh explicit Runner completes one block without dispatch or PLAN`, async t => {
  const f=executionFixture(t),effectPath=join(f.dir,'uncertain-effects.log');f.register();f.db.close();
  const crash=child(t,f.path,`uncertain-legacy-${stage}`,effectPath);await crash.ready;crash.process.send({});
  assert.equal((await crash.result).stage,`uncertain-legacy-${stage}`);crash.process.kill('SIGKILL');await crash.closed;
  const reopened=f.open(),before=reopened.store.getSnapshot('run');
  const ledger=()=>reopened.db.read(tx=>tx.get("SELECT * FROM execution_ledger WHERE workflow_run_id='run' AND action_id='action'"));
  const saved=ledger();assert.equal(saved!.state,'REVIEW_REQUIRED');assert.equal(saved!.review_reason,'EXECUTION_UNCERTAIN');
  assert.equal(before.run.status,'RUNNING');assert.equal(effects(effectPath),1);
  const recovery=child(t,f.path,'uncertain-recover',effectPath);await recovery.ready;recovery.process.send({});
  assert.equal((await recovery.result).outcome.reason,'needs_user');await recovery.closed;
  const after=reopened.store.getSnapshot('run');assert.equal(after.run.status,'BLOCKED');assert.equal(after.run.statusReason,'RUNNER_EXECUTION_UNCERTAIN:action');
  assert.deepEqual(after.events.slice(0,before.events.length),before.events);assert.deepEqual(ledger(),saved);
  for(const type of ['TaskFailed','SessionResolved','ProgressRecorded','WorkflowBlocked'])assert.equal(after.events.filter(e=>e.type===type).length,1);
  assert.equal(after.run.usage.rounds,1);assert.equal(after.run.usage.consecutiveErrors,1);
  const retry=child(t,f.path,'uncertain-recover',effectPath);await retry.ready;retry.process.send({});await retry.result;await retry.closed;
  assert.deepEqual(reopened.store.getSnapshot('run'),after);assert.deepEqual(ledger(),saved);
  assert.equal(effects(effectPath),1);assert.equal(effects(effectPath+'.plan'),0);assert.equal(effects(effectPath+'.verify'),0);
});
for(const boundary of ['before','after'] as const) test(`SIGKILL ${boundary} uncertain completion COMMIT preserves atomic suffix and exactly one block on retry`,async t=>{
  const f=executionFixture(t),effectPath=join(f.dir,'atomic-uncertain-effects.log');f.register();f.db.close();
  const stage=child(t,f.path,'uncertain-legacy-task',effectPath);await stage.ready;stage.process.send({});await stage.result;stage.process.kill('SIGKILL');await stage.closed;
  const reopened=f.open(),before=reopened.store.getSnapshot('run');
  const ledger=()=>reopened.db.read(tx=>tx.get("SELECT * FROM execution_ledger WHERE workflow_run_id='run' AND action_id='action'"));const saved=ledger();
  const crash=child(t,f.path,`uncertain-atomic-${boundary}`,effectPath);await crash.ready;crash.process.send({});
  assert.equal((await crash.result).stage,`uncertain-atomic-${boundary}`);crash.process.kill('SIGKILL');await crash.closed;
  const committed=reopened.store.getSnapshot('run');
  if(boundary==='before')assert.deepEqual(committed,before);
  else{assert.equal(committed.run.status,'BLOCKED');assert.equal(committed.events.length,before.events.length+3);}
  assert.deepEqual(ledger(),saved);
  for(let i=0;i<2;i++){
    const retry=child(t,f.path,'uncertain-recover',effectPath);await retry.ready;retry.process.send({});
    assert.equal((await retry.result).outcome.reason,'needs_user');await retry.closed;
  }
  const after=reopened.store.getSnapshot('run');assert.equal(after.events.length,before.events.length+3);
  for(const type of ['TaskFailed','SessionResolved','ProgressRecorded','WorkflowBlocked'])assert.equal(after.events.filter(e=>e.type===type).length,1);
  assert.equal(after.run.usage.rounds,1);assert.deepEqual(ledger(),saved);
  assert.equal(effects(effectPath),1);assert.equal(effects(effectPath+'.plan'),0);assert.equal(effects(effectPath+'.verify'),0);
});
