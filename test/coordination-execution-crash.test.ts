import { waitForLeaseAvailability, terminateChild, terminationName } from './lease-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionFixture } from './durable-execution-fixture.ts';

async function child(t: TestContext,path:string,mode:string,effectPath:string){
  if(mode!=='inspect')await waitForLeaseAvailability(path);
  const process=fork(fileURLToPath(new URL('./durable-execution-child.ts',import.meta.url)),[path,mode,effectPath],{
    execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','ignore','ipc'],
  });
  let readyResolve!:()=>void,resolve!:(v:any)=>void,reject!:(e:Error)=>void;
  const ready=new Promise<void>(r=>{readyResolve=r;}),result=new Promise<any>((r,j)=>{resolve=r;reject=j;});void result.catch(()=>{});
  const closed=new Promise<void>(r=>process.on('exit',()=>r()));
  const timer=setTimeout(()=>{terminateChild(process);readyResolve();reject(Error('Child timeout'));},15000);
  process.on('error',e=>{readyResolve();reject(e);});
  process.on('message',(message:any)=>{if(message.ready)readyResolve();else{clearTimeout(timer);resolve(message);}});
  process.on('exit',(code,signal)=>{clearTimeout(timer);readyResolve();if(code||signal)reject(Error('Child terminated'));});
  t.after(async()=>{clearTimeout(timer);if(process.exitCode===null&&process.signalCode===null)terminateChild(process);await closed;});
  return {process,ready,result,closed};
}
const effects=(path:string)=>existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).length:0;
for(const [mode,state,initialEffects,afterRetry] of [
  ['registration-before',undefined,0,0],['registration-after','PREPARED',0,0],
  ['reserve-before','PREPARED',0,0],['reserve-after','DISPATCH_RESERVED',0,0],
  ['external-after','DISPATCH_RESERVED',1,1],['evidence-before','DISPATCH_RESERVED',1,1],
  ['result-before','DISPATCH_RESERVED',1,1],['result-after','RESULT_RECORDED',1,1],
  ['finalize-before','RESULT_RECORDED',1,1],['finalize-after','FINALIZED',1,1],
] as const) test(`${terminationName} at ${mode}: durable boundary survives and possible effects never repeat`,async t=>{
  const f=executionFixture(t),effectPath=join(f.dir,'effects.log');
  if(!mode.startsWith('registration-'))f.register();
  f.release();
  f.db.close();
  const crash=await child(t,f.path,mode,effectPath);await crash.ready;crash.process.send({});assert.equal((await crash.result).stage,mode);terminateChild(crash.process);await crash.closed;
  assert.equal(effects(effectPath),initialEffects);
  const inspect=await child(t,f.path,'inspect',effectPath);await inspect.ready;inspect.process.send({});
  const diagnostic=(await inspect.result).diagnostic;await inspect.closed;assert.equal(diagnostic?.state,state);
  assert.equal(effects(effectPath),initialEffects); // Inspecting/reopening never runs an Executor.
  if(!state){const opened=f.open();assert.equal(opened.store.getSnapshot('run').events.length,1);return;}
  const retry=await child(t,f.path,'retry',effectPath);await retry.ready;retry.process.send({});const outcome=await retry.result;await retry.closed;
  if(state==='DISPATCH_RESERVED')assert.equal(outcome.code,'EXECUTION_REVIEW_REQUIRED');else if(state!=='FINALIZED')assert.equal(outcome.code,'RECOVERY_HELD');else assert.equal(outcome.code,undefined);
  assert.equal(effects(effectPath),afterRetry);assert.ok(effects(effectPath)<=1);
  const second=await child(t,f.path,'retry',effectPath);await second.ready;second.process.send({});await second.result;await second.closed;assert.equal(effects(effectPath),afterRetry);
});
test('two Node processes racing the same Action produce at most one reservation and one external effect',async t=>{
  const f=executionFixture(t);f.register();f.release();f.db.close();const effectPath=join(f.dir,'effects.log');
  const a=await child(t,f.path,'retry',effectPath),b=await child(t,f.path,'retry',effectPath);await Promise.all([a.ready,b.ready]);a.process.send({});b.process.send({});
  const outcomes=await Promise.all([a.result,b.result]);await Promise.all([a.closed,b.closed]);
  assert.ok(outcomes.some(o=>!o.code));assert.equal(effects(effectPath),1);
  const snapshot=f.open().store.getSnapshot('run');assert.equal(snapshot.events.filter(e=>e.type==='TaskCompleted').length,1);
});


for (const stage of ['task','session','progress'] as const) test(`${terminationName} after legacy uncertain ${stage} COMMIT: 4A retains the prefix and refuses all recovery writes`, async t => {
  const f=executionFixture(t),effectPath=join(f.dir,'uncertain-effects.log');f.register();f.release();f.db.close();
  const crash=await child(t,f.path,`uncertain-legacy-${stage}`,effectPath);await crash.ready;crash.process.send({});
  assert.equal((await crash.result).stage,`uncertain-legacy-${stage}`);terminateChild(crash.process);await crash.closed;
  const reopened=f.open(),before=reopened.store.getSnapshot('run');
  const ledger=()=>reopened.db.read(tx=>tx.get("SELECT * FROM execution_ledger WHERE workflow_run_id='run' AND action_id='action'"));
  const saved=ledger();assert.equal(saved!.state,'REVIEW_REQUIRED');assert.equal(saved!.review_reason,'EXECUTION_UNCERTAIN');
  assert.equal(before.run.status,'RUNNING');assert.equal(effects(effectPath),1);
  const recovery=await child(t,f.path,'uncertain-recover',effectPath);await recovery.ready;recovery.process.send({});
  assert.equal((await recovery.result).outcome.errorCode,'RUNNER_DURABLE_EXECUTION_STOPPED');await recovery.closed;
  const after=reopened.store.getSnapshot('run');assert.deepEqual(after,before);assert.deepEqual(ledger(),saved);
  const retry=await child(t,f.path,'uncertain-recover',effectPath);await retry.ready;retry.process.send({});await retry.result;await retry.closed;
  assert.deepEqual(reopened.store.getSnapshot('run'),after);assert.deepEqual(ledger(),saved);
  assert.equal(effects(effectPath),1);assert.equal(effects(effectPath+'.plan'),0);assert.equal(effects(effectPath+'.verify'),0);
});
for(const boundary of ['before','after'] as const) test(`${terminationName} ${boundary} uncertain completion COMMIT preserves atomic suffix and exactly one block on retry`,async t=>{
  const f=executionFixture(t),effectPath=join(f.dir,'atomic-uncertain-effects.log');f.register();f.release();f.db.close();
  const reopened=f.open(),before=reopened.store.getSnapshot('run');
  const ledger=()=>reopened.db.read(tx=>tx.get("SELECT * FROM execution_ledger WHERE workflow_run_id='run' AND action_id='action'"));
  const crash=await child(t,f.path,`uncertain-atomic-${boundary}`,effectPath);await crash.ready;crash.process.send({});
  assert.equal((await crash.result).stage,`uncertain-atomic-${boundary}`);terminateChild(crash.process);await crash.closed;
  const committed=reopened.store.getSnapshot('run');
  assert.equal(committed.events.length,before.events.length+(boundary==='before'?1:4));
  assert.equal(committed.run.status,boundary==='before'?'RUNNING':'BLOCKED');
  const saved=ledger();
  for(let i=0;i<2;i++){
    const retry=await child(t,f.path,'uncertain-recover',effectPath);await retry.ready;retry.process.send({});
    const outcome=(await retry.result).outcome;assert.equal(outcome.reason,boundary==='before'?'error':'needs_user');await retry.closed;
  }
  const after=reopened.store.getSnapshot('run');assert.deepEqual(after,committed);
  assert.equal(after.run.usage.rounds,boundary==='before'?0:1);assert.deepEqual(ledger(),saved);
  assert.equal(effects(effectPath),1);assert.equal(effects(effectPath+'.plan'),0);assert.equal(effects(effectPath+'.verify'),0);
});
