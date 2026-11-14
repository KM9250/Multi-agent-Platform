import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '../services/coordination/durable/schema.ts';
import { DurableDatabase } from '../services/coordination/durable/db.ts';
import { recoveryExecutionFixture } from './recovery-execution-fixture.ts';
import { usage } from './durable-fixture.ts';
import { reconciliationChild, processResult, ready } from './reconciliation-process-fixture.ts';

const baselineHashes = [
  '1081504f04e79db1588340ba0302991aeb42e3373b0edd9ba57810278e249566',
  'e260ee0f529e194487c363a3f13c965846165cfc0fba7577b8e221b331698189',
  '6586d8c14f895edf62d23612c4b4a67793a511e7c0f0eb064a944728cda7b94a',
  'e2ef99a787649bb2bc2e0107db24513c6189e98ee73b029bca53bfa80b5ef114',
  'a25bf6eba0319ee028c37c8b6406d96789384a54d8e052ff24c79c0eb0b787c8',
  'a05b168f32fa5f4bbe0402d5e25918b816fa7e32368819ec714365103a779b97',
  '1cbfc30fbe2ca6503482011f8c93e79e88683b342312496f95dce9652d04a526',
  'e5dce90128045fea17ac4a074fd75b28208312b96f788f88e38662a64f2fb724',
  'ce474da204af7f9b065f726847f20ab53ae8d2c5e42988a96e399df5fa5c39a4',
];
function historical(path: string, version: number): DatabaseSync {
  const raw = new DatabaseSync(path);
  if (version) {
    raw.exec('CREATE TABLE schema_migrations (schema_version INTEGER PRIMARY KEY,migration_id TEXT NOT NULL UNIQUE,applied_at INTEGER NOT NULL) STRICT');
    for (const migration of MIGRATIONS.slice(0, version)) {
      raw.exec(migration.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?,?,1)').run(migration.version, migration.id);
    }
    raw.exec(`PRAGMA user_version=${version}`);
  }
  return raw;
}
function contents(raw: DatabaseSync): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [String(row.name), raw.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]));
}
function copyHistorical(source: DatabaseSync, target: DatabaseSync) {
  const triggers = target.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  target.exec('PRAGMA foreign_keys=OFF');
  for (const row of triggers) target.exec(`DROP TRIGGER "${row.name}"`);
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const table of target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all()) {
    const name = String(table.name), columns = target.prepare(`PRAGMA table_info("${name}")`).all().map(row => String(row.name));
    const rows = source.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${name}" ORDER BY rowid`).all();
    target.exec(`DELETE FROM "${name}"`);
    for (const row of rows) target.prepare(`INSERT INTO "${name}" VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column] as string | number | null));
    before[name] = rows;
  }
  for (const row of triggers) target.exec(String(row.sql));
  target.exec('PRAGMA foreign_keys=ON');
  return before;
}
function assertComplete(raw: DatabaseSync) {
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 11);
  assert.equal(raw.prepare('SELECT migration_id FROM schema_migrations WHERE schema_version=10').get()!.migration_id, '010_evidence_reconciliation');
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(raw.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  for (const table of ['reconciliation_evidence','reconciliation_verifications','reconciliation_plans','reconciliation_grants','reconciliation_operations','model_usage_authorities'])
    assert.equal(raw.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)!.strict, 1, table);
}

test('CR-13: migrations 001–009 generated SQL remains byte-identical to 89d431e', () => {
  assert.deepEqual(MIGRATIONS.slice(0,9).map(migration => createHash('sha256').update(migration.sql).digest('hex')), baselineHashes);
});
for (let version = 0; version <= 9; version++) test(`CR-13: populated Schema ${version}→10 preserves original rows and never invents evidence or grants`, t => {
  const source = recoveryExecutionFixture(t);
  if(version>=5){source.settled(); source.reacquire();
    const plan = source.plan('DISCARD_SETTLED_RESPONSE'); source.authorize(plan); source.execute(plan);
  }else source.store.append(usage(source.store.getSnapshot('run'),'legacy-nonmodel-usage'));
  const path = join(source.dir, `schema-${version}.sqlite`), raw = historical(path, version); t.after(() => raw.close());
  const before = version ? copyHistorical(source.raw, raw) : {};
  const db = new DurableDatabase({ path }); t.after(() => db.close());
  for (const [name, rows] of Object.entries(before)) {
    const columns = rows.length ? Object.keys(rows[0]) : raw.prepare(`PRAGMA table_info("${name}")`).all().map(row => String(row.name));
    assert.deepEqual(raw.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${name}" ORDER BY rowid`).all(), rows, name);
  }
  assertComplete(raw);
  for (const table of ['reconciliation_evidence','reconciliation_verifications','reconciliation_plans','reconciliation_grants','reconciliation_operations'])
    assert.equal(raw.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table);
  assert.equal(raw.prepare('SELECT count(*) n FROM model_usage_authorities').get()!.n, version >= 5 ? 1 : 0);
});
for (const boundary of ['before-ddl','after-ddl','before-backfill','after-backfill','after-triggers','before-commit','after-commit'])
  test(`CR-11: real process SIGKILL migration010 ${boundary} commits the entire migration or nothing`, async t => {
    const source = recoveryExecutionFixture(t); source.settled();
    const path = join(source.dir, 'v9.sqlite'), raw = historical(path, 9); t.after(() => raw.close()); copyHistorical(source.raw, raw);
    const before = contents(raw), schemaBefore = raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    const result = await processResult(reconciliationChild([path, 'migration', boundary]));
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.signal, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL', result.stderr);
    const committed = boundary === 'after-commit';
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, committed ? 11 : 9);
    if (!committed) { assert.deepEqual(contents(raw), before); assert.deepEqual(raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), schemaBefore); }
    const db = new DurableDatabase({ path }); db.close(); assertComplete(raw);
    assert.equal(raw.prepare('SELECT count(*) n FROM model_usage_authorities').get()!.n, 1);
  });

test('CR-12: two real processes starting migration simultaneously produce one complete v10 ledger', async t => {
  const dir = mkdtempSync(join(tmpdir(),'map-reconciliation-migration-race-')), path = join(dir,'db.sqlite'); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const raw = historical(path,9); t.after(() => raw.close());
  const children = [reconciliationChild([path,'migration-race']), reconciliationChild([path,'migration-race'])];
  const results = children.map(child => processResult(child)); await Promise.all(children.map(child => ready(child)));
  children.forEach(child => child.send('go'));
  const completed=await Promise.all(results);
  for (const result of completed) { assert.equal(result.timedOut,false,result.stderr); assert.equal(result.code,0,result.stderr); }
  assert.ok(completed.some(result=>result.messages.some((value:any)=>value.migration==='COMPLETE')));
  const retried=new DurableDatabase({path});retried.close();
  assertComplete(raw); assert.equal(raw.prepare('SELECT count(*) n FROM schema_migrations WHERE schema_version=10').get()!.n,1);
});

test('CR-12: database busy leaves v9 intact and a later fresh process migrates exactly once', async t => {
  const dir = mkdtempSync(join(tmpdir(),'map-reconciliation-migration-busy-')), path = join(dir,'db.sqlite'); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const raw = historical(path,9); t.after(() => raw.close()); raw.exec('PRAGMA journal_mode=WAL'); const before=contents(raw);
  raw.exec('BEGIN IMMEDIATE');
  try {
    const result=await processResult(reconciliationChild([path,'migration-busy'])); assert.equal(result.code,0,result.stderr); assert.deepEqual(contents(raw),before);
  } finally { raw.exec('ROLLBACK'); }
  const result=await processResult(reconciliationChild([path,'migration-open'])); assert.equal(result.code,0,result.stderr); assertComplete(raw);
});

test('CR-14: actual baseline v9 Runtime refuses v10 without modifying any durable rows', async t => {
  const source=recoveryExecutionFixture(t); source.settled(); const before=contents(source.raw);
  const result=await processResult(reconciliationChild([source.path,'v9-open']),30_000);
  assert.equal(result.timedOut,false,result.stderr); assert.equal(result.code,0,result.stderr);
  assert.deepEqual(contents(source.raw),before); assertComplete(source.raw);
});

for(const defect of ['USAGE_MISMATCH','ATTEMPT_MISMATCH','MISSING_AUDIT'])test(`CR-13: contradictory v9 ${defect} refuses backfill and preserves the entire old database`,t=>{
  const source=recoveryExecutionFixture(t);source.settled();const path=join(source.dir,`${defect}.sqlite`),raw=historical(path,9);t.after(()=>raw.close());copyHistorical(source.raw,raw);
  const table=defect==='USAGE_MISMATCH'?'model_call_ledger':defect==='ATTEMPT_MISMATCH'?'model_call_attempts':'runtime_audit_events';
  const triggers=raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table);
  for(const trigger of triggers)raw.exec(`DROP TRIGGER "${trigger.name}"`);
  if(defect==='USAGE_MISMATCH')raw.prepare("UPDATE model_call_ledger SET usage_json=?").run(JSON.stringify({llmCalls:1,inputTokens:999,outputTokens:3,estimatedCost:0.000004}));
  else if(defect==='ATTEMPT_MISMATCH')raw.exec("UPDATE model_call_attempts SET generation=generation+1");
  else raw.exec("DELETE FROM runtime_audit_events WHERE event_kind='MODEL_CALL_SETTLED'");
  for(const trigger of triggers)raw.exec(String(trigger.sql));
  const before=contents(raw),schema=raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
  assert.throws(()=>new DurableDatabase({path}));assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version,9);
  assert.deepEqual(contents(raw),before);assert.deepEqual(raw.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),schema);
});
