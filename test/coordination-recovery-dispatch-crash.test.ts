import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dispatchContents,dispatchFixture } from './recovery-dispatch-fixture.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { RecoveryDispatchReader } from '../services/coordination/durable/recoveryDispatchReader.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
import { terminationName,terminateChild } from './lease-fixture.ts';
function location(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'map-dispatch-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'db.sqlite'),counter:join(dir,'external-count.txt')};}
function child(t:TestContext,args:string[]){
  const proc=fork(fileURLToPath(new URL('./recovery-dispatch-child.ts',import.meta.url)),args,{execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
  let stderr='',ready:any,done:any;proc.stderr!.on('data',c=>{stderr+=c;});
  const exit=new Promise<{code:number|null;signal:string|null}>(resolve=>proc.once('exit',(code,signal)=>resolve({code,signal})));
  const waitReady=new Promise<any>((resolve,reject)=>{proc.on('message',(m:any)=>{if(m.ready){ready=m;resolve(m);}if(m.done)done=m;});proc.once('error',reject);proc.once('exit',()=>{if(!ready)reject(Error(stderr));});});
  const timer=setTimeout(()=>terminateChild(proc),15000);t.after(async()=>{clearTimeout(timer);if(proc.exitCode===null&&proc.signalCode===null)terminateChild(proc);await exit;});
  return {proc,waitReady,async finish(){const result=await exit;clearTimeout(timer);return {...result,ready,done,stderr};}};
}
const calls=(path:string)=>existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).length:0;
for(const boundary of ['before-A','after-A','before-send','after-send','after-evidence','before-B','after-B'])test(`${terminationName} ${boundary}: restart cannot mint another send permit`,async t=>{
  const l=location(t),c=child(t,[l.path,'crash',boundary,l.counter]),ready=await c.waitReady;c.proc.send({go:true});const dead=await c.finish();
  assert.equal(dead.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',dead.stderr);
  const raw=new DatabaseSync(l.path);t.after(()=>raw.close());
  const expectedCalls=['after-send','after-evidence','before-B','after-B'].includes(boundary)?1:0;
  assert.equal(calls(l.counter),expectedCalls);
  if(boundary==='before-A')assert.deepEqual(JSON.parse(JSON.stringify(dispatchContents(raw))),ready.before);
  else{
    assert.equal(raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_intents').get()!.n,1);
    assert.equal(raw.prepare('SELECT status FROM recovery_controlled_grants').get()!.status,'CONSUMED');
    assert.equal(raw.prepare('SELECT count(*) AS n FROM execution_results').get()!.n,boundary==='after-B'?1:0);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_receipts').get()!.n,boundary==='after-B'?1:0);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM runner_evidence').get()!.n,['after-B','after-evidence'].includes(boundary)?1:0);
    assert.deepEqual(JSON.parse(JSON.stringify(raw.prepare('SELECT * FROM recovery_holds').all())),ready.before.recovery_holds);
    const identity=testIdentityProvider(),db=new DurableDatabase({path:l.path,recoveryIdentityVerifier:identity.verifier});t.after(()=>db.close());
    const inspected=new RecoveryDispatchReader(db).inspectDispatch(ready.planId,identity.credential());assert.equal(inspected.status,boundary==='after-B'?'RESULT_RECORDED':'INTENT_RECORDED');
    assert.equal(inspected.outcome,boundary==='after-B'?'RESULT_AVAILABLE':'OUTCOME_UNKNOWN');
  }
  const after=dispatchContents(raw),again=child(t,[l.path,'retry','',l.counter,ready.planId]);await again.waitReady;again.proc.send({go:true});const retried=await again.finish();assert.equal(retried.code,0,retried.stderr);
  if(!['before-A','after-B'].includes(boundary))assert.equal(retried.done.outcome,'OUTCOME_UNKNOWN');
  assert.equal(calls(l.counter),expectedCalls);assert.deepEqual(dispatchContents(raw),after);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('two real Node processes compete for fresh approvals and one prepared Action; external entry remains one',async t=>{
  const l=location(t),f=dispatchFixture({after(){}},l);f.manager.release(f.lease);f.raw.close();f.db.close();
  const a=child(t,[l.path,'race','',l.counter]),b=child(t,[l.path,'race','',l.counter]);await Promise.all([a.waitReady,b.waitReady]);a.proc.send({go:true});b.proc.send({go:true});
  const results=await Promise.all([a.finish(),b.finish()]);assert.ok(results.every(r=>r.code===0),JSON.stringify(results));
  assert.equal(results.filter(r=>r.done.status==='RESULT_RECORDED').length,1);assert.equal(calls(l.counter),1);
  const raw=new DatabaseSync(l.path);t.after(()=>raw.close());assert.equal(raw.prepare('SELECT count(*) AS n FROM recovery_dispatch_intents').get()!.n,1);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
