import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { DurableDatabase, SqliteCoordinationRunnerStore } from '../services/coordination/durable/index.ts';
import { executionFixture, registration, record } from './durable-execution-fixture.ts';

for (const fail of [false,true]) test(`real v1 database migration ${fail?'rolls back v2 failure then retries':'preserves Journal/Seed/Checkpoint exactly'}`, t=>{
  const f=executionFixture(t),request=registration(f.store);
  // A historical assigned task with no Ledger remains historical after migration.
  f.store.append(request.sessionEvent);f.store.append(request.taskEvent);f.store.createCheckpoint('run');
  const source=f.raw(),path=join(f.dir,'version1.sqlite'),raw=new DatabaseSync(path);t.after(()=>raw.close());
  raw.exec(MIGRATIONS[0].sql);
  raw.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY,migration_id TEXT NOT NULL UNIQUE,applied_at INTEGER NOT NULL) STRICT');
  raw.prepare('INSERT INTO schema_migrations VALUES (1,?,?)').run(MIGRATIONS[0].id,1);raw.exec('PRAGMA user_version=1');
  const before:Record<string,any[]>={};
  for(const table of ['workflow_seeds','journal_events','workflow_checkpoints']){
    before[table]=source.prepare(`SELECT * FROM ${table}`).all();
    for(const row of before[table])raw.prepare(`INSERT INTO ${table} VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row) as any[]);
  }
  if(fail){
    const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql:string){exec.call(this,sql);if(sql.includes('CREATE TABLE pending_actions'))throw Error('migration fault');};
    try{assert.throws(()=>new DurableDatabase({path}),{code:'DATABASE_ERROR'});}finally{DatabaseSync.prototype.exec=exec;}
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,1);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,1);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='pending_actions'").get()!.n,0);
  }
  const db=new DurableDatabase({path});t.after(()=>db.close());const store=new SqliteCoordinationRunnerStore(db);
  assert.deepEqual(store.getSnapshot('run'),f.snapshot());assert.ok(store.loadCheckpoint('run'));
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,2);
  for(const table of Object.keys(before))assert.deepEqual(raw.prepare(`SELECT * FROM ${table}`).all(),before[table]);
  for(const table of ['pending_actions','execution_ledger','execution_results','runner_evidence'])assert.equal(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
  db.close();const again=new DurableDatabase({path});again.close();assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,2);
});
