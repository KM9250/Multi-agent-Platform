import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { controlledTables,dispatchFixture } from './recovery-dispatch-fixture.ts';
import { terminationName,terminateChild } from './lease-fixture.ts';

// SHA-256 of actual generated SQL from the requested 07c9e2e baseline, not source-file hashes.
const baselineSqlHashes=['1081504f04e79db1588340ba0302991aeb42e3373b0edd9ba57810278e249566','e260ee0f529e194487c363a3f13c965846165cfc0fba7577b8e221b331698189',
  '6586d8c14f895edf62d23612c4b4a67793a511e7c0f0eb064a944728cda7b94a','e2ef99a787649bb2bc2e0107db24513c6189e98ee73b029bca53bfa80b5ef114',
  'a25bf6eba0319ee028c37c8b6406d96789384a54d8e052ff24c79c0eb0b787c8','a05b168f32fa5f4bbe0402d5e25918b816fa7e32368819ec714365103a779b97','1cbfc30fbe2ca6503482011f8c93e79e88683b342312496f95dce9652d04a526'];
test('Migration 001–007 generated SQL is byte-for-byte identical to baseline main',()=>{
  assert.deepEqual(MIGRATIONS.slice(0,7).map(m=>createHash('sha256').update(m.sql).digest('hex')),baselineSqlHashes);
});
function historical(path:string,version:number){const raw=new DatabaseSync(path);if(version){raw.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY,migration_id TEXT NOT NULL UNIQUE,applied_at INTEGER NOT NULL) STRICT');for(const m of MIGRATIONS.slice(0,version)){raw.exec(m.sql);raw.prepare('INSERT INTO schema_migrations VALUES (?,?,1)').run(m.version,m.id);}raw.exec(`PRAGMA user_version=${version}`);}return raw;}
for(const version of [0,1,2,3,4,5,6,7])test(`migration ${version}→9 retains strict, empty controlled tables with no fabricated Intent/Receipt`,t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-v8-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));const raw=historical(path,version);t.after(()=>raw.close());
  const db=new DurableDatabase({path});t.after(()=>db.close());assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,11);
  assert.equal(raw.prepare('SELECT migration_id FROM schema_migrations WHERE schema_version=8').get()!.migration_id,'008_bounded_recovery_execution');
  for(const table of controlledTables){assert.equal(raw.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)!.strict,1);assert.equal(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);}
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('populated Schema 7 migrates without changing any historical column or minting execution',t=>{
  const f=dispatchFixture(t);f.plan();const path=join(f.dir,'populated-v7.sqlite'),raw=historical(path,7);t.after(()=>raw.close());raw.exec('PRAGMA foreign_keys=OFF');
  const triggers=raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();for(const r of triggers)raw.exec(`DROP TRIGGER "${r.name}"`);
  const before:Record<string,Record<string,unknown>[]>={};
  for(const r of raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations'").all()){
    const table=String(r.name),columns=raw.prepare(`PRAGMA table_info(${table})`).all().map(c=>String(c.name)),names=columns.join(',');
    const rows=f.raw.prepare(`SELECT ${names} FROM ${table} ORDER BY rowid`).all();before[table]=rows;raw.exec(`DELETE FROM ${table}`);
    for(const row of rows)raw.prepare(`INSERT INTO ${table} (${names}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c] as string|number|null));
  }
  for(const r of triggers)raw.exec(String(r.sql));raw.exec('PRAGMA foreign_keys=ON');const db=new DurableDatabase({path});t.after(()=>db.close());
  for(const [table,rows] of Object.entries(before)){const columns=rows.length?Object.keys(rows[0]):raw.prepare(`PRAGMA table_info(${table})`).all().map(c=>String(c.name));assert.deepEqual(raw.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all(),rows);}
  for(const table of controlledTables)assert.equal(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('migration 008 DDL failure rolls back tables, modified triggers, indexes and migration ledger',t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-v8-ddl-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));const raw=historical(path,7);t.after(()=>raw.close());
  const before=raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql:string){const r=exec.call(this,sql);if(sql.includes('CREATE TABLE recovery_controlled_plans'))throw Error('injected');return r;};
  try{assert.throws(()=>new DurableDatabase({path}));}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,7);assert.deepEqual(raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),before);
  const db=new DurableDatabase({path});db.close();assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,11);
});
for(const boundary of ['before-ddl','after-ddl','before-commit','after-commit'])test(`${terminationName} migration 008 ${boundary} commits all-or-none`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-v8-crash-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));const raw=historical(path,7);t.after(()=>raw.close());
  const p=fork(fileURLToPath(new URL('./recovery-dispatch-child.ts',import.meta.url)),[path,'migration',boundary],{execArgv:['--experimental-transform-types','--loader',fileURLToPath(new URL('./ts-loader.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';p.stderr!.on('data',c=>{stderr+=c;});const timer=setTimeout(()=>terminateChild(p),15000);
  const ended=await new Promise<{code:number|null;signal:string|null}>(resolve=>p.once('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
  assert.equal(ended.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',stderr);const committed=boundary==='after-commit';
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,committed?11:7);assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,committed?11:7);
  for(const table of controlledTables)assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name=? AND type='table'").get(table)!.n,committed?1:0);
  const db=new DurableDatabase({path});db.close();assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,11);
});
