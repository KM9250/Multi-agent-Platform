import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconciliationChild, processResult } from './reconciliation-process-fixture.ts';

const cases: Record<string,{id:string;table:string;audit:string}> = {
  candidate:{id:'CR-01',table:'reconciliation_evidence',audit:'RECONCILIATION_EVIDENCE_SUBMITTED'},
  verification:{id:'CR-01',table:'reconciliation_verifications',audit:'RECONCILIATION_VERIFICATION_RECORDED'},
  plan:{id:'CR-02',table:'reconciliation_plans',audit:'RECONCILIATION_PLAN_CREATED'},
  grant:{id:'CR-02',table:'reconciliation_grants',audit:'RECONCILIATION_AUTHORIZED'},
  outcome:{id:'CR-03',table:'reconciled_action_outcomes',audit:'RECONCILIATION_ACTION_OUTCOME_RECORDED'},
  usage:{id:'CR-04',table:'reconciled_model_usages',audit:'RECONCILIATION_MODEL_USAGE_SETTLED'},
  'expired-apply':{id:'PR36 F-01',table:'reconciled_action_applications',audit:'RECONCILIATION_ACTION_RESULT_APPLIED'},
  apply:{id:'CR-05',table:'reconciled_action_applications',audit:'RECONCILIATION_ACTION_RESULT_APPLIED'},
  dispute:{id:'CR-06',table:'reconciliation_disputes',audit:'RECONCILIATION_DISPUTE_RECORDED'},
};
for (const [mode,{id,table,audit}] of Object.entries(cases)) for (const boundary of ['before-commit','after-commit'])
  test(`${id}/CR-07: real SIGKILL ${mode}/${boundary} retains atomic effects and restart uses authenticated read APIs`, async t => {
    const dir=mkdtempSync(join(tmpdir(),'map-reconciliation-crash-')),path=join(dir,'db.sqlite'); t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const result=await processResult(reconciliationChild([path,mode,boundary]));
    assert.equal(result.timedOut,false,result.stderr); assert.equal(result.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',result.stderr);
    const before=JSON.parse(readFileSync(join(dir,'before.json'),'utf8')) as Record<string,Record<string,unknown>[]>;
    const raw=new DatabaseSync(path);t.after(()=>raw.close());const committed=boundary==='after-commit';
    const rows=(name:string)=>JSON.parse(JSON.stringify(raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())) as Record<string,unknown>[];
    assert.equal(rows(table).length,(before[table]?.length??0)+(committed?1:0),table);
    assert.equal(raw.prepare('SELECT count(*) n FROM reconciliation_audit WHERE event_kind=?').get(audit)!.n,(before.reconciliation_audit??[]).filter(row=>row.event_kind===audit).length+(committed?1:0));
    for(const name of ['execution_ledger','execution_results','model_call_ledger','model_call_attempts','recovery_invocation_debits'])assert.deepEqual(rows(name),before[name],name);
    if(mode!=='apply'&&mode!=='expired-apply')for(const name of ['workflow_seeds','journal_events'])assert.deepEqual(rows(name),before[name],name);
    if(['outcome','usage','apply','expired-apply'].includes(mode)) {
      const operations=rows('reconciliation_operations');assert.equal(operations.length,before.reconciliation_operations.length+(committed?1:0));
      const consumed=rows('reconciliation_grants').filter(row=>row.status==='CONSUMED').length;
      assert.equal(consumed,before.reconciliation_grants.filter(row=>row.status==='CONSUMED').length+(committed?1:0));
      assert.equal(rows('reconciliation_operation_grants').length,before.reconciliation_operation_grants.length+(committed?1:0));
      assert.equal(rows('reconciliation_cases').length,before.reconciliation_cases.length+(committed?1:0));
    }
    if(mode==='usage') {
      assert.equal(rows('model_usage_authorities').length,committed?1:0);
      assert.equal(rows('reconciled_model_usages').length,committed?1:0);
      assert.equal(rows('reconciliation_target_seals').length,committed?1:0);
      if(committed){const authority=rows('model_usage_authorities')[0];assert.equal(authority.authority,'RECONCILED');assert.equal(authority.cost_micros,400);}
    }
    if(mode==='apply'||mode==='expired-apply')assert.equal(rows('journal_events').length,before.journal_events.length+(committed?1:0));
    if(mode==='dispute') {
      const control=rows('recovery_workflow_control')[0],prior=before.recovery_workflow_control[0];
      assert.equal(control.control_revision,Number(prior.control_revision)+(committed?1:0));assert.equal(control.hold_state,committed?'HELD':prior.hold_state);
    }
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(raw.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    const durableBefore=Object.fromEntries(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>[String(row.name),rows(String(row.name))]));
    const restarted=await processResult(reconciliationChild([path,'inspect']));assert.equal(restarted.timedOut,false,restarted.stderr);assert.equal(restarted.code,0,restarted.stderr);
    const inspection=(restarted.messages.find((value:any)=>value.inspected) as {inspected:Record<string,number>}).inspected;
    assert.deepEqual(inspection,{cases:1,evidence:rows('reconciliation_evidence').length,bodies:rows('reconciliation_evidence').length,
      verifications:rows('reconciliation_verifications').length,planChecks:rows('reconciliation_plans').length,receipts:rows('reconciliation_operations').length,
      authenticationRefusals:1+2*rows('reconciliation_evidence').length+rows('reconciliation_verifications').length+rows('reconciliation_plans').length});
    for(const [name,data] of Object.entries(durableBefore))assert.deepEqual(rows(name),data,name);
  });

for(const boundary of ['before-commit','after-commit'])test(`CR-06: real SIGKILL verified dispute ${boundary} atomically preserves ACTIVE or commits DRAINING and reHold`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'map-reconciliation-active-crash-')),path=join(dir,'db.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const result=await processResult(reconciliationChild([path,'active-dispute',boundary]));assert.equal(result.timedOut,false,result.stderr);assert.equal(result.signal,process.platform==='win32'?'SIGTERM':'SIGKILL',result.stderr);
  const raw=new DatabaseSync(path);t.after(()=>raw.close());const before=JSON.parse(readFileSync(join(dir,'before.json'),'utf8')),committed=boundary==='after-commit';
  assert.equal(raw.prepare('SELECT status FROM recovery_invocations').get()!.status,committed?'DRAINING':'ACTIVE');
  assert.equal(raw.prepare('SELECT count(*) n FROM reconciliation_disputes').get()!.n,committed?1:0);
  const control=raw.prepare('SELECT * FROM recovery_workflow_control').get()!;
  assert.equal(control.control_revision,Number(before.recovery_workflow_control[0].control_revision)+(committed?1:0));
  if(committed)assert.equal(control.hold_state,'HELD');
  for(const table of ['model_usage_authorities','reconciliation_grants','reconciliation_operations','reconciled_model_usages'])assert.equal(raw.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
  for(const table of ['journal_events','model_call_ledger','model_call_attempts','recovery_invocation_debits'])assert.deepEqual(JSON.parse(JSON.stringify(raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),before[table],table);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
  const retry=await processResult(reconciliationChild([path,'inspect']));assert.equal(retry.code,0,retry.stderr);
  const inspection=(retry.messages.find((value:any)=>value.inspected) as {inspected:Record<string,number>}).inspected;
  assert.deepEqual(inspection,{cases:1,evidence:2,bodies:2,verifications:committed?2:1,planChecks:0,receipts:0,authenticationRefusals:committed?7:6});
});

test('CR-06/IN-07: dispute audit failure rolls back Drain and Hold with zero Abort; successful retry notifies after commit',async t=>{
  const {activeDispute}=await import('./reconciliation-active-process-fixture.ts');
  let checked=false;
  const result=await activeDispute(t,async({f,verify,before,aborts})=>{
    f.raw.exec("CREATE TRIGGER reconciliation_test_audit_failure BEFORE INSERT ON reconciliation_audit WHEN NEW.event_kind='RECONCILIATION_DISPUTE_RECORDED' BEGIN SELECT RAISE(ABORT,'injected'); END");
    await assert.rejects(verify);assert.equal(aborts(),0);
    for(const table of ['reconciliation_disputes','reconciliation_cases','recovery_invocations','recovery_workflow_control','recovery_hold_lifecycle','model_usage_authorities','journal_events'])assert.deepEqual(f.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before[table],table);
    assert.equal(f.raw.prepare('SELECT status FROM recovery_invocations').get()!.status,'ACTIVE');
    f.raw.exec('DROP TRIGGER reconciliation_test_audit_failure');await verify();
    assert.equal(f.raw.prepare('SELECT status FROM recovery_invocations').get()!.status,'DRAINING');assert.equal(f.raw.prepare('SELECT hold_state FROM recovery_workflow_control').get()!.hold_state,'HELD');assert.equal(aborts(),1);
    assert.equal(f.raw.prepare("SELECT count(*) n FROM reconciliation_audit WHERE event_kind='RECONCILIATION_DISPUTE_RECORDED'").get()!.n,1);checked=true;
  });
  assert.equal(checked,true);assert.equal(result.f.counts.draft,1);assert.equal(result.f.counts.action,0);assert.equal(result.f.counts.plan,0);assert.equal(result.f.counts.verify,0);
});
