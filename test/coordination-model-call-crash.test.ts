import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executionFixture } from './durable-execution-fixture.ts';
import { historicalDatabase } from './recovery-migration-fixture.ts';
import { terminateChild } from './lease-fixture.ts';
import { DurableDatabase,RecoveryReader } from '../services/coordination/durable/index.ts';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
async function crash(t:TestContext,path:string,stage:string,boundary:string){
 const child=fork(fileURLToPath(new URL('./model-call-crash-child.ts',import.meta.url)),[path,stage,boundary],{execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));let stderr='';child.stderr!.on('data',s=>stderr+=s);
 let timer:ReturnType<typeof setTimeout>;
 t.after(async()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)terminateChild(child);await exited;});
 const reached=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('child timeout '+stderr)),15000);child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('child exit '+stderr)));});
 assert.deepEqual(reached,{stage,boundary});clearTimeout(timer!);terminateChild(child);await exited;
}
for(const stage of ['reservation','intent','settlement','application'])for(const boundary of ['before','after',...(stage==='application'?['during']:[])])test(`real process termination ${stage} ${boundary} COMMIT`,async t=>{
 const f=executionFixture(t);f.release();await crash(t,f.path,stage,boundary);
 const rows=f.raw().prepare('SELECT * FROM model_call_ledger').all(),committed=boundary==='after';
 const expected=stage==='reservation'?(committed?'RESERVED':undefined):stage==='intent'?(committed?'DISPATCH_INTENT':'RESERVED'):stage==='settlement'?(committed?'SETTLED':'DISPATCH_INTENT'):'SETTLED';
 assert.equal(rows[0]?.state,expected);
 if(stage==='application')assert.equal(rows[0].application_status,committed?'APPLIED':'PENDING_APPLICATION');
 assert.equal(f.snapshot().run.usage.llmCalls,stage==='application'||stage==='settlement'&&committed?1:0);
 if(stage==='application')assert.equal(f.snapshot().events.filter(e=>e.type==='ProgressRecorded').length,committed?1:0);
 const r=new RecoveryReader(f.db).inspect('run');assert.equal(r.executionAllowed,false);assert.notEqual(r.disposition,'RECOVERY_FAILED');
});
export function legacy(f:ReturnType<typeof executionFixture>,path:string,version:number){
 if(!version)return;
 historicalDatabase(f,path,Math.min(version,2) as 1|2);
 const raw=new DatabaseSync(path);try{for(const migration of MIGRATIONS.slice(2,version)){raw.exec(migration.sql);raw.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version,migration.id,1);raw.exec(`PRAGMA user_version=${migration.version}`);}}finally{raw.close();}
}
for(const version of [0,1,2,3,4])test(`schema ${version} to 5 and legacy coverage`,t=>{
 const f=executionFixture(t),path=join(f.dir,`legacy-${version}.sqlite`);legacy(f,path,version);
 const db=new DurableDatabase({path});try{
  assert.equal(db.read(tx=>tx.get('SELECT user_version FROM pragma_user_version')?.user_version),5);
  if(version)assert.equal(new RecoveryReader(db).inspect('run').modelCallCoverage,'LEGACY_UNTRACKED');
 }finally{db.close();}
});
for(const boundary of ['before','during','after'])test(`migration 005 forced termination ${boundary}`,async t=>{
 const f=executionFixture(t),path=join(f.dir,'legacy.sqlite');legacy(f,path,4);await crash(t,path,'migration',boundary);
 const raw=new DatabaseSync(path);try{assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,boundary==='after'?5:4);}finally{raw.close();}
 const db=new DurableDatabase({path});db.close();
});
test('migration 005 failure rolls back DDL and version',t=>{
 const f=executionFixture(t),path=join(f.dir,'legacy.sqlite');legacy(f,path,4);const original=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.exec=function(sql:string){original.call(this,sql);if(sql.includes('CREATE TABLE model_call_coverage'))throw Error('fault');};
 try{assert.throws(()=>new DurableDatabase({path}));}finally{DatabaseSync.prototype.exec=original;}
 const raw=new DatabaseSync(path);try{assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,4);assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='model_call_ledger'").get()!.n,0);}finally{raw.close();}
});
