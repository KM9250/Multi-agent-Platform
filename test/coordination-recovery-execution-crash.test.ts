import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync,rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, RecoveryReader, RecoveryPlanner, RecoveryAuthorizer } from '../services/coordination/durable/index.ts';
import { SafeRecoveryExecutor } from '../services/coordination/durable/safeRecoveryExecutor.ts';
import { testIdentityProvider } from './recovery-authorization-fixture.ts';
import { recoveryContents, recoveryExecutionFixture } from './recovery-execution-fixture.ts';
import { scopeOf } from '../services/coordination/durable/recoveryDecisionStore.ts';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { terminationName,terminateChild } from './lease-fixture.ts';

function location(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'map-recovery-kill-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path};}
async function childCrash(t:TestContext,path:string,operation:string,boundary:string){
  const child=fork(fileURLToPath(new URL('./recovery-execution-child.ts',import.meta.url)),[path,operation,boundary],{
    execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
  let stderr='',ready:any;child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const closed=new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  const timeout=setTimeout(()=>terminateChild(child),15_000);
  t.after(async()=>{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)terminateChild(child);await closed;});
  child.on('message',(message:any)=>{if(message.ready){ready=message;child.send({go:true});}});
  const result=await closed;clearTimeout(timeout);assert.equal(result.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',stderr);
  if(operation!=='migration')assert.ok(ready,'Child must finish setup and announce prepared state before death');
  return ready;
}
function plain(value:unknown){return JSON.parse(JSON.stringify(value));}
for(const operation of ['cancel','discard','reflect','safety'])for(const boundary of ['before-commit','after-commit'])test(`${terminationName} recovery ${operation}/${boundary}: all receipt, grant, business, hold and audit records commit together`,async t=>{
  const {path}=location(t),ready=await childCrash(t,path,operation,boundary),raw=new DatabaseSync(path);t.after(()=>raw.close());
  const after=recoveryContents(raw);
  if(boundary==='before-commit')assert.deepEqual(plain(after),ready.before);
  else {
    assert.equal(after.recovery_execution_operations.length,1);assert.equal(after.recovery_hold_transitions.length,1);assert.equal(after.recovery_operation_grants.length,1);
    assert.equal(after.recovery_execution_grants[0].status,'CONSUMED');assert.equal(after.runtime_audit_events.filter(r=>r.event_kind==='RECOVERY_OPERATION_COMMITTED').length,1);
    assert.deepEqual(plain(after.recovery_holds),ready.before.recovery_holds);assert.deepEqual(plain(after.model_call_ledger),ready.before.model_call_ledger);assert.deepEqual(plain(after.model_call_attempts),ready.before.model_call_attempts);
    const identity=testIdentityProvider(),credential=identity.credential(),db=new DurableDatabase({path,recoveryIdentityVerifier:identity.verifier});t.after(()=>db.close());
    const executor=new SafeRecoveryExecutor(db);const receipt=executor.inspectReceipt(ready.planId,credential);assert.equal(receipt?.status,'COMMITTED');
    assert.deepEqual(executor.inspectReceipt(ready.planId,credential),receipt);assert.deepEqual(recoveryContents(raw),after);
    assert.equal(new RecoveryReader(db).inspect('run').executionAllowed,false);
  }
});
for(const [operation,boundary] of [['cancel','grant'],['cancel','resolution'],['cancel','hold'],['reflect','result'],['safety','result']])test(`${terminationName} recovery ${operation} after ${boundary} write but before COMMIT rolls back every record`,async t=>{
  const {path}=location(t),ready=await childCrash(t,path,operation,boundary),raw=new DatabaseSync(path);t.after(()=>raw.close());assert.deepEqual(plain(recoveryContents(raw)),ready.before);
});
function historical(path:string,version:number){const raw=new DatabaseSync(path);if(version){raw.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY,migration_id TEXT NOT NULL UNIQUE,applied_at INTEGER NOT NULL) STRICT');for(const m of MIGRATIONS.slice(0,version)){raw.exec(m.sql);raw.prepare('INSERT INTO schema_migrations VALUES (?,?,1)').run(m.version,m.id);}raw.exec(`PRAGMA user_version=${version}`);}return raw;}
for(const version of [0,1,2,3,4,5,6])test(`migration ${version}→7 creates every strict recovery table without execution authority`,t=>{
  const {path}=location(t),raw=historical(path,version);t.after(()=>raw.close());const db=new DurableDatabase({path});t.after(()=>db.close());
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,7);assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,7);
  assert.equal(raw.prepare('SELECT migration_id FROM schema_migrations WHERE schema_version=7').get()!.migration_id,'007_safe_recovery_execution');
  for(const table of ['recovery_execution_plans','recovery_execution_grants','recovery_execution_operations','recovery_operation_grants','recovery_hold_transitions','recovery_model_resolutions']){
    assert.equal(raw.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)!.strict,1);assert.equal(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
  }
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('migration 007 thrown DDL failure rolls back schema, triggers and migration ledger',t=>{
  const {path}=location(t),raw=historical(path,6);t.after(()=>raw.close());const before=raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql.includes('CREATE TABLE recovery_execution_plans'))throw Error('migration fault');return result;};
  try{assert.throws(()=>new DurableDatabase({path}));}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,6);assert.deepEqual(raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),before);assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,6);
});
for(const boundary of ['before-ddl','after-ddl','before-commit','after-commit'])test(`${terminationName} migration 007/${boundary} exposes only a complete old or new schema`,async t=>{
  const {path}=location(t),raw=historical(path,6);t.after(()=>raw.close());await childCrash(t,path,'migration',boundary);const committed=boundary==='after-commit';
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,committed?7:6);assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,committed?7:6);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='recovery_execution_operations'").get()!.n,committed?1:0);
  const db=new DurableDatabase({path});db.close();assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,7);
});

test('populated schema 6 migration preserves hold, old model reservation and record-only authorization without granting execution',t=>{
  const f=recoveryExecutionFixture(t);f.reserve();f.reacquire();const p=new RecoveryPlanner(f.db,f.lease).createPlan({workflowRunId:'run',operationKind:'CANCEL_UNSENT_MODEL',targetId:'model'},f.credential);
  new RecoveryAuthorizer(f.db,f.lease).authorize(p.recoveryPlanId,scopeOf(p),f.credential);
  const path=join(f.dir,'populated-v6.sqlite'),raw=historical(path,6);t.after(()=>raw.close());raw.exec('PRAGMA foreign_keys=OFF');
  const triggers=raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  for(const trigger of triggers)raw.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"','""')}"`);
  const before:Record<string,Record<string,unknown>[]>={};
  for(const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations'").all()){
    const table=String(row.name),columns=raw.prepare(`PRAGMA table_info(${table})`).all().map(c=>String(c.name)),names=columns.join(',');
    const records=f.raw.prepare(`SELECT ${names} FROM ${table} ORDER BY rowid`).all();before[table]=records;
    raw.exec(`DELETE FROM ${table}`);for(const record of records)raw.prepare(`INSERT INTO ${table} (${names}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>record[c] as string|number|null));
  }
  for(const trigger of triggers)raw.exec(String(trigger.sql));raw.exec('PRAGMA foreign_keys=ON');
  const db=new DurableDatabase({path});t.after(()=>db.close());assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,7);
  for(const [table,records] of Object.entries(before)){
    const columns=records.length?Object.keys(records[0]):raw.prepare(`PRAGMA table_info(${table})`).all().map(c=>String(c.name));
    assert.deepEqual(raw.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all(),records);
  }
  assert.equal(raw.prepare('SELECT count(*) AS n FROM recovery_execution_grants').get()!.n,0);assert.equal(raw.prepare('SELECT status FROM recovery_authorizations').get()!.status,'AUTHORIZED');
  assert.equal(new RecoveryReader(db).inspect('run').executionAllowed,false);
});
