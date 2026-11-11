import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { DurableDatabase,RecoveryReader,SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { executionFixture,executionSeed } from './durable-execution-fixture.ts';
import { historicalDatabase } from './recovery-migration-fixture.ts';

async function crash(path:string,operation:string,boundary:string) {
  const child=fork(fileURLToPath(new URL('./recovery-authorization-child.ts',import.meta.url)),[path,operation,boundary],{
    execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc'],
  });
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);
  try {await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{
    if(signal==='SIGKILL'&&!timedOut)resolve();else reject(Error(`Child exited ${code}: ${stderr}`));
  });});}finally{clearTimeout(timeout);}
}
for(const op of ['plan','authorize','revoke'] as const)for(const boundary of ['before','after'])test(`Linux SIGKILL ${op} ${boundary} COMMIT: decision and audit agree on independent connection`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-decision-crash-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  await crash(path,op,boundary);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());
  const committed=boundary==='after';
  assert.equal(raw.prepare('SELECT count(*) n FROM recovery_plans').get()!.n,op==='plan'&&!committed?0:1);
  assert.equal(raw.prepare('SELECT count(*) n FROM recovery_authorizations').get()!.n,op==='revoke'||op==='authorize'&&committed?1:0);
  if(op==='revoke')assert.equal(raw.prepare('SELECT status FROM recovery_authorizations').get()!.status,committed?'REVOKED':'AUTHORIZED');
  const event={plan:'RECOVERY_PLAN_CREATED',authorize:'RECOVERY_AUTHORIZED',revoke:'RECOVERY_REVOKED'}[op];
  assert.equal(raw.prepare('SELECT count(*) n FROM runtime_audit_events WHERE event_kind=?').get(event)!.n,committed?1:0);
  assert.equal(raw.prepare('SELECT count(*) n FROM recovery_operations').get()!.n,0);
  const db=new DurableDatabase({path});try{assert.notEqual(new RecoveryReader(db).inspect('run').disposition,'RECOVERY_FAILED');}finally{db.close();}
});
for(const version of [0,1,2,3,4,5])test(`Migration ${version} → 8 preserves original records and persists legacy hold`,t=>{
  const f=executionFixture(t);f.register();const path=join(f.dir,`old-${version}.sqlite`);
  if(version)historicalDatabase(f,path,Math.min(version,2) as 1|2);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());
  for(let v=3;v<=version;v++){raw.exec(MIGRATIONS[v-1].sql);raw.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(v,MIGRATIONS[v-1].id,1);raw.exec(`PRAGMA user_version=${v}`);}
  const tables=raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','sqlite_sequence')").all().map(r=>String(r.name));
  const before=Object.fromEntries(tables.map(name=>[name,raw.prepare(`SELECT * FROM ${name}`).all()]));
  const db=new DurableDatabase({path});t.after(()=>db.close());assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,9);
  for(const [table,rows] of Object.entries(before)) {
    const after=raw.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(after.length,rows.length);rows.forEach((row,i)=>{for(const key of Object.keys(row))assert.deepEqual(after[i][key],row[key]);});
  }
  assert.equal(raw.prepare('SELECT count(*) n FROM recovery_holds').get()!.n,version?1:0);
  assert.equal(raw.prepare('SELECT count(*) n FROM recovery_operations').get()!.n,0);
});
for(const boundary of ['before','after'])test(`Linux SIGKILL migration006 ${boundary} COMMIT rolls DDL, holds and version together`,async t=>{
  const f=executionFixture(t);f.register();const path=join(f.dir,'migration.sqlite');historicalDatabase(f,path,2);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());
  for(let v=3;v<=5;v++){raw.exec(MIGRATIONS[v-1].sql);raw.prepare('INSERT INTO schema_migrations VALUES (?,?,1)').run(v,MIGRATIONS[v-1].id);raw.exec(`PRAGMA user_version=${v}`);}
  await crash(path,'migration',boundary);assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,boundary==='after'?9:5);
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='recovery_holds'").get()!.n,boundary==='after'?1:0);
  const db=new DurableDatabase({path});db.close();assert.equal(raw.prepare('SELECT count(*) n FROM recovery_holds').get()!.n,1);
});
test('migration006 SQL failure rolls back all schema additions',t=>{
  const f=executionFixture(t),path=join(f.dir,'failed.sqlite');historicalDatabase(f,path,2);
  const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql:string){exec.call(this,sql);if(sql.includes('CREATE TABLE recovery_holds'))throw Error('injected');};
  try{assert.throws(()=>new DurableDatabase({path}));}finally{DatabaseSync.prototype.exec=exec;}
  const raw=new DatabaseSync(path);try{assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='recovery_holds'").get()!.n,0);}finally{raw.close();}
});
for(const boundary of ['before','after'])test(`Linux SIGKILL takeover ${boundary} COMMIT cannot leave a new generation without hold`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-takeover-crash-')),path=join(dir,'db.sqlite'),db=new DurableDatabase({path});
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});new SqliteCoordinationRunnerStore(db).createWorkflow(executionSeed());
  const l=db.createLeaseManager({ttlMs:100}).acquire('run');await delay(Math.max(0,l.expiresAt-Date.now())+25);
  await crash(path,'takeover',boundary);
  const raw=new DatabaseSync(path);try{
    assert.equal(raw.prepare('SELECT generation FROM runtime_leases').get()!.generation,boundary==='after'?2:1);
    assert.equal(raw.prepare('SELECT count(*) n FROM recovery_holds').get()!.n,boundary==='after'?1:0);
    assert.equal(raw.prepare("SELECT count(*) n FROM runtime_audit_events WHERE event_kind='LEASE_TAKEN_OVER'").get()!.n,boundary==='after'?1:0);
    assert.throws(()=>db.writeWithLease(l,'run',tx=>tx.run('UPDATE workflow_seeds SET last_sequence=last_sequence')),{code:'LEASE_FENCED'});
  }finally{raw.close();}
});
