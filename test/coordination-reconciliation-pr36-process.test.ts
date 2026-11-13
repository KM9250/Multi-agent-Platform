import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconciliationChild, processResult } from './reconciliation-process-fixture.ts';

for(const boundary of ['before-commit','after-commit'])test(`PR36 RT-01: real SIGKILL normal Usage plus Dispute ${boundary} is atomic`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-pr36-normal-crash-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const result=await processResult(reconciliationChild([path,'normal-conflict',boundary]));
  assert.equal(result.timedOut,false,result.stderr);assert.equal(result.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',result.stderr);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());const committed=boundary==='after-commit';
  const before=JSON.parse(readFileSync(join(dir,'before.json'),'utf8'));
  const rows=(name:string)=>JSON.parse(JSON.stringify(raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()));
  assert.equal(rows('model_usage_authorities').length,committed?1:0);
  assert.equal(rows('reconciliation_disputes').length,committed?1:0);
  assert.equal(rows('journal_events').length,before.journal_events.length+(committed?1:0));
  assert.equal(rows('reconciliation_cases').length,committed?1:0);
  assert.equal(rows('reconciliation_audit').length,before.reconciliation_audit.length+(committed?1:0));
  assert.deepEqual(rows('reconciliation_grants'),before.reconciliation_grants);
  assert.deepEqual(rows('reconciliation_operations'),before.reconciliation_operations);
  assert.deepEqual(rows('reconciled_model_usages'),[]);
  if(committed){assert.equal(rows('model_usage_authorities')[0].cost_micros,500);assert.equal(rows('model_call_ledger')[0].state,'SETTLED');assert.equal(rows('recovery_workflow_control')[0].hold_state,'HELD');}
  else for(const [table,data] of Object.entries(before))assert.deepEqual(rows(table),data,table);
  const snapshot=rows('journal_events'),audit=rows('reconciliation_audit');
  const inspected=await processResult(reconciliationChild([path,'inspect']));assert.equal(inspected.code,0,inspected.stderr);
  assert.deepEqual(rows('journal_events'),snapshot);assert.deepEqual(rows('reconciliation_audit'),audit);
});
