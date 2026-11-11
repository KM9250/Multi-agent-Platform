import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync,rmSync,readFileSync,existsSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { child,exited } from './continuation-process-fixture.ts';
const scenarios:Record<string,string[]>={model:['before-start','after-start','before-model-reservation','after-model-reservation','before-model-intent','after-model-intent','before-model-external','after-model-external','before-usage','after-usage','before-artifact','after-artifact'],
 read:['before-read-intent','after-read-intent','before-read-external','after-read-external','before-read-result','after-read-result'],
 action:['before-action-intent','after-action-intent','before-action-external','after-action-external','before-action-result','after-action-result'],
 finish:['before-finish','after-finish'],release:['before-release','after-release'],rehold:['before-rehold','after-rehold'],questions:['before-questions','after-questions'],
 review:['before-review','after-review'],stop:['before-stop','after-stop']};
for(const [mode,boundaries] of Object.entries(scenarios))for(const boundary of boundaries)test(`C01-C05: SIGKILL ${mode}/${boundary} cannot resend from saved IDs`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'map-bounded-crash-')),path=join(dir,'db.sqlite'),counter=join(dir,'external-count');t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(counter,'');
 const r=await exited(child([path,mode,boundary,counter]));assert.equal(r.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',r.stderr);
 const before=readFileSync(counter,'utf8'),plan=readFileSync(join(dir,'plan-id'),'utf8');
 const retry=await exited(child([path,'retry','',counter,plan]));assert.equal(retry.code,0,retry.stderr);assert.equal(readFileSync(counter,'utf8'),before);
 const raw=new DatabaseSync(path);try {
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(raw.prepare("SELECT count(*) n FROM recovery_invocations WHERE status IN ('ACTIVE','DRAINING')").get()!.n===0||raw.prepare("SELECT count(*) n FROM recovery_invocations WHERE status IN ('ACTIVE','DRAINING')").get()!.n===1,true);
  const models=Number(raw.prepare('SELECT count(*) n FROM model_call_ledger').get()!.n),debits=Number(raw.prepare("SELECT count(*) n FROM recovery_invocation_debits WHERE kind='MODEL'").get()!.n);assert.equal(models,debits);
  assert.equal(raw.prepare("SELECT count(*) n FROM recovery_invocation_debits WHERE kind='READ'").get()!.n,raw.prepare('SELECT count(*) n FROM planning_read_calls').get()!.n);
  assert.equal(raw.prepare("SELECT count(*) n FROM recovery_invocation_debits WHERE kind='ACTION'").get()!.n,raw.prepare('SELECT count(*) n FROM execution_ledger WHERE attempt_id IS NOT NULL').get()!.n);
  assert.equal(raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,raw.prepare("SELECT count(*) n FROM recovery_continuation_receipts WHERE kind='START'").get()!.n);
  const artifacts=raw.prepare('SELECT model_call_id FROM planning_artifacts').all();for(const a of artifacts)assert.equal(raw.prepare('SELECT application_status FROM model_call_ledger WHERE model_call_id=?').get(a.model_call_id)!.application_status,'APPLIED');
  const questions=raw.prepare('SELECT * FROM planning_input_requests').all();for(const q of questions){
   assert.equal(raw.prepare('SELECT application_status FROM model_call_ledger WHERE model_call_id=?').get(q.model_call_id)!.application_status,'APPLIED');
   assert.equal(raw.prepare('SELECT outcome FROM recovery_invocations WHERE invocation_id=?').get(q.invocation_id)!.outcome,'PLAN_INCOMPLETE');
   assert.deepEqual(JSON.parse(String(q.request_json)).questions,['Which environment?','Which retention period?']);
  }
  if(mode==='questions')assert.equal(questions.length,boundary==='after-questions'?1:0);
  if(mode==='review') {
   const committed=boundary==='after-review';assert.equal(raw.prepare('SELECT count(*) n FROM planning_reviews').get()!.n,committed?1:0);
   assert.equal(raw.prepare('SELECT planning_review_pending FROM recovery_workflow_control').get()!.planning_review_pending,committed?0:1);
   assert.equal(raw.prepare("SELECT count(*) n FROM bounded_audit WHERE entity_table='planning_reviews'").get()!.n,committed?1:0);
   assert.equal(artifacts.length,1);assert.equal(before,'model\n');
  }
  if(mode==='stop') {
   const committed=boundary==='after-stop';assert.equal(raw.prepare("SELECT count(*) n FROM recovery_continuation_receipts WHERE kind='STOP'").get()!.n,committed?1:0);
   assert.equal(raw.prepare('SELECT status FROM recovery_invocations').get()!.status,committed?'DRAINING':'ACTIVE');
   assert.equal(raw.prepare("SELECT count(*) n FROM bounded_audit WHERE entity_table='recovery_continuation_receipts'").get()!.n,committed?2:1);
   assert.equal(artifacts.length,0);assert.equal(before,'model\n');
  }
  if(boundary==='before-start')assert.equal(raw.prepare('SELECT count(*) n FROM recovery_invocations').get()!.n,0);
  if(boundary==='after-start')assert.equal(before,'');
 }finally{raw.close();}
});
